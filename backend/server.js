import express from 'express';
import cors from 'cors';
import { PutObjectCommand, GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { setupCORS } from './setup-cors.js';
import { createB2S3Client, getB2PublicUrl, getB2Settings } from './b2-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

export const MAX_AUDIO_FILE_SIZE = 100 * 1024 * 1024;

const DEFAULT_URL_EXPIRY = 3600;
const PRESIGN_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PRESIGN_RATE_LIMIT_MAX_REQUESTS = 60;
const PRESIGN_AUTH_PLACEHOLDERS = new Set([
  'change_me_to_a_random_value',
  'change-me',
  'your-presign-token',
]);

const ALLOWED_AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'webm', 'flac']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUrlExpiry(env = process.env) {
  const parsed = Number.parseInt(env.URL_EXPIRY, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_URL_EXPIRY;
}

function shouldAutoSetupCors(env = process.env) {
  return !['false', '0', 'no'].includes((env.AUTO_SETUP_CORS || '').toLowerCase());
}

function getPresignAuthToken(env = process.env) {
  const token = (env.PRESIGN_AUTH_TOKEN || '').trim();
  if (!token || PRESIGN_AUTH_PLACEHOLDERS.has(token)) {
    throw new Error('Missing required PRESIGN_AUTH_TOKEN. Set it to a private random value shared only with trusted clients.');
  }
  return token;
}

function getAllowedOrigins(env = process.env) {
  return (env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function createCorsOrigin(allowedOrigins) {
  return function corsOrigin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    callback(null, allowedOrigins.includes(origin) ? origin : false);
  };
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
  now = Date.now,
  windowMs = PRESIGN_RATE_LIMIT_WINDOW_MS,
} = {}) {
  const clients = new Map();
  let nextCleanupAt = 0;

  return function presignRateLimit(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const currentTime = now();

    if (currentTime >= nextCleanupAt) {
      for (const [clientKey, entry] of clients) {
        if (entry.resetAt <= currentTime) {
          clients.delete(clientKey);
        }
      }
      nextCleanupAt = currentTime + windowMs;
    }

    const current = clients.get(key);
    if (!current || current.resetAt <= currentTime) {
      clients.set(key, { count: 1, resetAt: currentTime + windowMs });
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

function originMatchesRequestHost(req, origin) {
  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.host === req.get('host') && parsedOrigin.protocol === `${req.protocol}:`;
  } catch {
    return false;
  }
}

function createPresignAuth({ allowedOrigins = [], authToken }) {
  return function presignAuth(req, res, next) {
    const origin = req.get('origin');
    if (origin && !allowedOrigins.includes(origin) && !originMatchesRequestHost(req, origin)) {
      res.status(403).json({ error: 'Untrusted origin' });
      return;
    }

    const auth = req.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    const suppliedToken = match ? match[1] : req.get('x-presign-auth-token');
    if (suppliedToken !== authToken) {
      res.status(401).json({ error: 'Presign authentication required' });
      return;
    }

    next();
  };
}

export function createPutObjectInput(bucket, key, contentType, options = {}) {
  const putObject = {
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  };

  if (options.contentLength !== undefined) {
    putObject.ContentLength = options.contentLength;
  }

  return putObject;
}

function createPresignHelper(s3Client, b2Settings, urlExpiry) {
  const bucket = b2Settings.bucketName;

  return async function generatePresignedUrls(key, contentType, options = {}) {
    const putUrl = await getSignedUrl(
      s3Client,
      new PutObjectCommand(createPutObjectInput(bucket, key, contentType, options)),
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
  allowedOrigins = getAllowedOrigins(),
  b2Settings = getB2Settings(),
  maxAudioFileSize = MAX_AUDIO_FILE_SIZE,
  presignAuthToken = getPresignAuthToken(),
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
  const presignMiddlewares = [
    createPresignAuth({ allowedOrigins, authToken: presignAuthToken }),
    ...(presignRateLimit ? [presignRateLimit] : []),
  ];

  app.use(cors({ origin: createCorsOrigin(allowedOrigins) }));
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
  let presignAuthToken;
  try {
    b2Settings = getB2Settings();
    presignAuthToken = getPresignAuthToken();
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
  const app = createApp({ b2Settings, presignAuthToken, s3Client });
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

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  startServer();
}
