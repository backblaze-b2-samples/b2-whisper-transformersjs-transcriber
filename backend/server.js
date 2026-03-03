import express from 'express';
import cors from 'cors';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupCORS } from './setup-cors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// 1.1 — Validate required env vars at startup
const REQUIRED_ENV = ['B2_ENDPOINT', 'B2_KEY_ID', 'B2_APP_KEY', 'B2_BUCKET'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy backend/.env.example to backend/.env and fill in your credentials.');
  process.exit(1);
}

const app = express();

// 1.5 — Configurable CORS origin
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));

// 1.4 — Limit request body size (presign payloads are tiny)
app.use(express.json({ limit: '1kb' }));

// Serve frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

const s3Client = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION || 'us-west-002',
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APP_KEY,
  },
  forcePathStyle: true,
  customUserAgent: "b2ai-transformersjs",
});

const BUCKET = process.env.B2_BUCKET;

// 2.2 — Configurable URL expiry
const URL_EXPIRY = parseInt(process.env.URL_EXPIRY, 10) || 3600;

// 2.5 — Robust boolean parsing for AUTO_SETUP_CORS
const AUTO_SETUP_CORS = !['false', '0', 'no'].includes(
  (process.env.AUTO_SETUP_CORS || '').toLowerCase()
);

// 1.2 — Allowed audio extensions
const ALLOWED_AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'webm', 'flac']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 2.1 — Shared presign helper
async function generatePresignedUrls(key, contentType) {
  const putUrl = await getSignedUrl(
    s3Client,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: URL_EXPIRY }
  );
  const getUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: URL_EXPIRY }
  );
  return { uploadUrl: putUrl, publicUrl: getUrl };
}

// Generate pre-signed PUT URL for audio upload
app.post('/api/presign-audio', async (req, res) => {
  try {
    const { filename, contentType } = req.body;

    // 1.2 — Input validation
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid filename' });
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
    const { uploadUrl, publicUrl } = await generatePresignedUrls(key, contentType || 'audio/webm');

    res.json({ uploadUrl, publicUrl, key, fileId });
  } catch (error) {
    // 1.3 — Don't leak error internals
    console.error('Error generating audio presigned URL:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

// Generate pre-signed PUT URL for transcript upload
app.post('/api/presign-transcript', async (req, res) => {
  try {
    const { fileId } = req.body;

    // 1.2 — Validate fileId is a UUID
    if (!fileId || !UUID_RE.test(fileId)) {
      return res.status(400).json({ error: 'Invalid file ID' });
    }

    const key = `transcripts/${fileId}.json`;
    const { uploadUrl, publicUrl } = await generatePresignedUrls(key, 'application/json');

    res.json({ uploadUrl, publicUrl, key });
  } catch (error) {
    console.error('Error generating transcript presigned URL:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

// 2.4 — Health check with B2 connectivity verification
app.get('/health', async (req, res) => {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: BUCKET }));
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ status: 'degraded' });
  }
});

const PORT = process.env.PORT || 3000;

// Auto-setup CORS on startup
async function startServer() {
  if (AUTO_SETUP_CORS) {
    console.log('Checking B2 CORS configuration...');
    try {
      await setupCORS(true);
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

  // 2.3 — Graceful shutdown
  const server = app.listen(PORT, () => {
    console.log(`\nServer running on http://localhost:${PORT}\n`);
  });

  function shutdown() {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer();
