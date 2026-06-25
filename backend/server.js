import express from 'express';
import cors from 'cors';
import { PutObjectCommand, GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupCORS } from './setup-cors.js';
import { createB2S3Client, getB2PublicUrl, getB2Settings } from './b2-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

export const MAX_AUDIO_FILE_SIZE = 100 * 1024 * 1024;

const DEFAULT_URL_EXPIRY = 3600;
const PRESIGN_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PRESIGN_RATE_LIMIT_MAX_REQUESTS = 60;

const ALLOWED_AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'webm', 'flac']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUrlExpiry(env = process.env) {
  const parsed = Number.parseInt(env.URL_EXPIRY, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_URL_EXPIRY;
}

function shouldAutoSetupCors(env = process.env) {
  return !['false', '0', 'no'].includes((env.AUTO_SETUP_CORS || '').toLowerCase());
}

function parseContentLength(size) {
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

function signPayload(encodedPayload, secret) {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function signaturesMatch(expectedSignature, actualSignature) {
  try {
    const expected = Buffer.from(expectedSignature, 'base64url');
    const actual = Buffer.from(actualSignature, 'base64url');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function createTranscriptToken(fileId, secret, ttlMs, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    exp: now + ttlMs,
    fileId,
  })).toString('base64url');
  const signature = signPayload(payload, secret);
  return `${payload}.${signature}`;
}

export function verifyTranscriptToken(token, fileId, secret, now = Date.now()) {
  if (!token || typeof token !== 'string') {
    return false;
  }

  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) {
    return false;
  }

  const expectedSignature = signPayload(payload, secret);
  if (!signaturesMatch(expectedSignature, signature)) {
    return false;
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.fileId === fileId && Number.isSafeInteger(claims.exp) && claims.exp >= now;
  } catch {
    return false;
  }
}

export function createPresignRateLimit({
  maxRequests = PRESIGN_RATE_LIMIT_MAX_REQUESTS,
  windowMs = PRESIGN_RATE_LIMIT_WINDOW_MS,
} = {}) {
  const clients = new Map();

  return function presignRateLimit(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const current = clients.get(key);

    if (!current || current.resetAt <= now) {
      clients.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    current.count += 1;
    if (current.count > maxRequests) {
      res.status(429).json({ error: 'Too many presign requests' });
      return;
    }

    next();
  };
}

function createPresignHelper(s3Client, b2Settings, urlExpiry) {
  const bucket = b2Settings.bucketName;

  return async function generatePresignedUrls(key, contentType, options = {}) {
    const putObject = {
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    };

    if (options.contentLength !== undefined) {
      putObject.ContentLength = options.contentLength;
    }

    const putUrl = await getSignedUrl(
      s3Client,
      new PutObjectCommand(putObject),
      { expiresIn: urlExpiry }
    );
    const publicUrl = getB2PublicUrl(key, b2Settings) || await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: urlExpiry }
    );
    return { uploadUrl: putUrl, publicUrl };
  };
}

export function createApp({
  b2Settings = getB2Settings(),
  maxAudioFileSize = MAX_AUDIO_FILE_SIZE,
  presignRateLimit = createPresignRateLimit(),
  presignUrls,
  s3Client = createB2S3Client(b2Settings),
  transcriptTokenTtlMs,
  urlExpiry = parseUrlExpiry(),
} = {}) {
  const app = express();
  const bucket = b2Settings.bucketName;
  const presignObjectUrls = presignUrls || createPresignHelper(s3Client, b2Settings, urlExpiry);
  const tokenTtlMs = transcriptTokenTtlMs || urlExpiry * 1000;
  const presignMiddlewares = presignRateLimit ? [presignRateLimit] : [];

  app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
  app.use(express.json({ limit: '1kb' }));
  app.use(express.static(path.join(__dirname, '../frontend')));

  app.post('/api/presign-audio', ...presignMiddlewares, async (req, res) => {
    try {
      const { filename, contentType, size } = req.body;

      if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid filename' });
      }

      const contentLength = parseContentLength(size);
      if (!contentLength) {
        return res.status(400).json({ error: 'Missing or invalid file size' });
      }
      if (contentLength > maxAudioFileSize) {
        return res.status(413).json({ error: `File too large. Maximum size is ${maxAudioFileSize} bytes.` });
      }

      const ext = path.extname(filename).replace('.', '').toLowerCase();
      if (!ALLOWED_AUDIO_EXT.has(ext)) {
        return res.status(400).json({ error: 'Unsupported audio format' });
      }
      if (contentType && !String(contentType).startsWith('audio/')) {
        return res.status(400).json({ error: 'Invalid content type' });
      }

      const fileId = randomUUID();
      const key = `audio/${fileId}.${ext}`;
      const { uploadUrl, publicUrl } = await presignObjectUrls(
        key,
        contentType || 'audio/webm',
        { contentLength }
      );
      const transcriptToken = createTranscriptToken(fileId, b2Settings.applicationKey, tokenTtlMs);

      res.json({ uploadUrl, publicUrl, key, fileId, transcriptToken });
    } catch (error) {
      console.error('Error generating audio presigned URL:', error);
      res.status(500).json({ error: 'Failed to generate presigned URL' });
    }
  });

  app.post('/api/presign-transcript', ...presignMiddlewares, async (req, res) => {
    try {
      const { fileId, transcriptToken } = req.body;

      if (!fileId || !UUID_RE.test(fileId)) {
        return res.status(400).json({ error: 'Invalid file ID' });
      }
      if (!verifyTranscriptToken(transcriptToken, fileId, b2Settings.applicationKey)) {
        return res.status(403).json({ error: 'Invalid transcript token' });
      }

      const key = `transcripts/${fileId}.json`;
      const { uploadUrl, publicUrl } = await presignObjectUrls(key, 'application/json');

      res.json({ uploadUrl, publicUrl, key });
    } catch (error) {
      console.error('Error generating transcript presigned URL:', error);
      res.status(500).json({ error: 'Failed to generate presigned URL' });
    }
  });

  app.get('/health', async (req, res) => {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
      res.json({ status: 'ok' });
    } catch (error) {
      console.error('Health check failed:', error);
      res.status(503).json({ status: 'degraded' });
    }
  });

  return app;
}

export async function startServer() {
  let b2Settings;
  try {
    b2Settings = getB2Settings();
  } catch (error) {
    console.error(error.message);
    console.error('Copy backend/.env.example to backend/.env and fill in your credentials.');
    process.exit(1);
  }

  const s3Client = createB2S3Client(b2Settings);

  if (shouldAutoSetupCors()) {
    console.log('Checking B2 CORS configuration...');
    try {
      await setupCORS(true, b2Settings);
      console.log('B2 CORS is configured');
    } catch (error) {
      if (error.Code === 'InvalidRequest' && error.message.includes('B2 Native CORS rules')) {
        console.warn('\nYour bucket has B2 Native CORS rules (not S3 API rules)');
        console.warn('You need to manually update CORS in B2 Web Console:\n');
        console.warn('1. Go to: https://secure.backblaze.com/b2_buckets.htm');
        console.warn('2. Click on your bucket > Bucket Settings');
        console.warn('3. Find CORS Rules section');
        console.warn('4. DELETE the existing B2 Native rule');
        console.warn('5. Add NEW rule for "S3 Compatible API":');
        console.warn('   - Allowed Origins: *');
        console.warn('   - Allowed Operations: s3_get, s3_head, s3_put');
        console.warn('   - Allowed Headers: *');
        console.warn('   - Max Age: 3600');
        console.warn('6. Save and restart this server\n');
      } else {
        console.warn('Could not verify/setup CORS automatically');
        console.warn('Error:', error.message);
      }
    }
  }

  const port = process.env.PORT || 3000;
  const app = createApp({ b2Settings, s3Client });
  const server = app.listen(port, () => {
    console.log(`\nServer running on http://localhost:${port}\n`);
  });

  function shutdown() {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
