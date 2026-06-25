import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createApp,
  createPresignRateLimit,
  createPutObjectInput,
  createTranscriptToken,
  verifyTranscriptToken,
} from '../server.js';

const SAMPLE_REGION = ['us', 'west', '002'].join('-');
const SAMPLE_ENDPOINT = `https://s3.${SAMPLE_REGION}.backblazeb2.com`;
const PRESIGN_AUTH_TOKEN = 'trusted-presign-token';
const TRUSTED_ORIGIN = 'https://trusted.example';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const B2_SETTINGS = {
  applicationKeyId: 'application-key-id',
  applicationKey: 'server-side-transcript-token-secret',
  bucketName: 'sample-bucket',
  endpoint: SAMPLE_ENDPOINT,
  publicUrlBase: '',
  region: SAMPLE_REGION,
};

function createTestApp(options = {}) {
  const calls = [];
  const app = createApp({
    allowedOrigins: [TRUSTED_ORIGIN],
    b2Settings: B2_SETTINGS,
    maxAudioFileSize: 100,
    presignAuthToken: PRESIGN_AUTH_TOKEN,
    presignRateLimit: null,
    presignUrls: async (key, contentType, presignOptions = {}) => {
      calls.push({ contentType, key, options: presignOptions });
      return {
        publicUrl: `https://read.example.com/${key}`,
        uploadUrl: `https://upload.example.com/${key}`,
      };
    },
    s3Client: { send: async () => ({}) },
    ...options,
  });

  return { app, calls };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function postJson(baseUrl, pathname, body, options = {}) {
  const {
    authToken = PRESIGN_AUTH_TOKEN,
    headers: extraHeaders = {},
    origin = TRUSTED_ORIGIN,
  } = options;
  const headers = { 'Content-Type': 'application/json' };

  if (authToken !== null) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  if (origin !== null) {
    headers.Origin = origin;
  }
  Object.assign(headers, extraHeaders);

  const response = await fetch(`${baseUrl}${pathname}`, {
    body: JSON.stringify(body),
    headers,
    method: 'POST',
  });
  return {
    body: await response.json(),
    status: response.status,
  };
}

test('createPutObjectInput includes the intended content length', () => {
  assert.deepEqual(
    createPutObjectInput('sample-bucket', 'audio/file.mp3', 'audio/mpeg', { contentLength: 42 }),
    {
      Bucket: 'sample-bucket',
      ContentLength: 42,
      ContentType: 'audio/mpeg',
      Key: 'audio/file.mp3',
    }
  );
});

test('transcript tokens remain valid through their configured TTL', () => {
  const fileId = '00000000-0000-4000-8000-000000000000';
  const issuedAt = 1_000;
  const token = createTranscriptToken(fileId, B2_SETTINGS.applicationKey, 120_000, issuedAt);

  assert.equal(verifyTranscriptToken(token, fileId, B2_SETTINGS.applicationKey, issuedAt + 119_999), true);
  assert.equal(verifyTranscriptToken(token, fileId, B2_SETTINGS.applicationKey, issuedAt + 120_000), false);
  assert.equal(verifyTranscriptToken(token, fileId, B2_SETTINGS.applicationKey, issuedAt + 120_001), false);
});

test('audio presign rejects unauthenticated requests without issuing URLs', async () => {
  const { app, calls } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    }, { authToken: null });

    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'Presign authentication required');
    assert.equal(calls.length, 0);
  });
});

test('audio presign rejects wrong bearer tokens without issuing URLs', async () => {
  const { app, calls } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    }, { authToken: 'wrong-token' });

    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'Presign authentication required');
    assert.equal(calls.length, 0);
  });
});

test('audio presign rejects untrusted origins without issuing URLs', async () => {
  const { app, calls } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    }, { origin: 'https://untrusted.example' });

    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'Untrusted origin');
    assert.equal(calls.length, 0);
  });
});

test('audio presign accepts forwarded same-origin HTTPS when trust proxy is enabled', async () => {
  const { app, calls } = createTestApp({
    allowedOrigins: [],
    trustProxy: true,
  });

  await withServer(app, async (baseUrl) => {
    const { host } = new URL(baseUrl);
    const response = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    }, {
      headers: { 'X-Forwarded-Proto': 'https' },
      origin: `https://${host}`,
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
  });
});

test('audio presign accepts origins normalized from CORS_ORIGIN URLs', async () => {
  const previousCorsOrigin = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = `${TRUSTED_ORIGIN}/upload`;

  try {
    const { app, calls } = createTestApp({ allowedOrigins: undefined });

    await withServer(app, async (baseUrl) => {
      const response = await postJson(baseUrl, '/api/presign-audio', {
        contentType: 'audio/mpeg',
        filename: 'clip.mp3',
        size: 42,
      });

      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
    });
  } finally {
    if (previousCorsOrigin === undefined) {
      delete process.env.CORS_ORIGIN;
    } else {
      process.env.CORS_ORIGIN = previousCorsOrigin;
    }
  }
});

test('presign rate limit uses forwarded IPs when trust proxy is enabled', async () => {
  const currentTime = 1_000;
  const { app } = createTestApp({
    presignRateLimit: createPresignRateLimit({
      maxRequests: 1,
      now: () => currentTime,
      windowMs: 100,
    }),
    trustProxy: true,
  });

  await withServer(app, async (baseUrl) => {
    const first = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    }, { headers: { 'X-Forwarded-For': '203.0.113.10' } });
    const second = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    }, { headers: { 'X-Forwarded-For': '203.0.113.11' } });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
  });
});

test('audio presign rejects requests above the server-side size limit', async () => {
  const { app, calls } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 101,
    });

    assert.equal(response.status, 413);
    assert.equal(response.body.error, 'File too large. Maximum size is 100 bytes.');
    assert.equal(calls.length, 0);
  });
});

test('audio presign requires a valid intended byte size', async () => {
  const { app, calls } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Missing or invalid file size');
    assert.equal(calls.length, 0);
  });
});

test('audio presign returns upload URLs and a transcript token for valid requests', async () => {
  const { app, calls } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    });

    assert.equal(response.status, 200);
    assert.match(response.body.fileId, UUID_RE);
    assert.equal(typeof response.body.transcriptToken, 'string');
    assert.match(response.body.uploadUrl, /^https:\/\/upload\.example\.com\/audio\//);
    assert.match(response.body.publicUrl, /^https:\/\/read\.example\.com\/audio\//);
    assert.equal(calls.length, 1);
  });
});

test('transcript presign rejects missing, malformed, and wrong-file tokens', async () => {
  const { app, calls } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const audio = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    });
    const wrongFileId = '00000000-0000-4000-8000-000000000000';

    const missingToken = await postJson(baseUrl, '/api/presign-transcript', {
      fileId: wrongFileId,
    });
    const malformedToken = await postJson(baseUrl, '/api/presign-transcript', {
      fileId: audio.body.fileId,
      transcriptToken: `${audio.body.transcriptToken}.tampered`,
    });
    const wrongFileToken = await postJson(baseUrl, '/api/presign-transcript', {
      fileId: wrongFileId,
      transcriptToken: audio.body.transcriptToken,
    });

    assert.equal(missingToken.status, 403);
    assert.equal(malformedToken.status, 403);
    assert.equal(wrongFileToken.status, 403);
    assert.equal(calls.length, 1);
  });
});

test('transcript presign accepts the token issued with the audio presign', async () => {
  const { app, calls } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const audio = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    });
    const transcript = await postJson(baseUrl, '/api/presign-transcript', {
      fileId: audio.body.fileId,
      transcriptToken: audio.body.transcriptToken,
    });

    assert.equal(transcript.status, 200);
    assert.equal(transcript.body.key, `transcripts/${audio.body.fileId}.json`);
    assert.match(transcript.body.uploadUrl, /^https:\/\/upload\.example\.com\/transcripts\//);
    assert.match(transcript.body.publicUrl, /^https:\/\/read\.example\.com\/transcripts\//);
    assert.equal(calls.length, 2);
  });
});

test('presign endpoints rate limit unauthenticated requests before auth', async () => {
  const { app, calls } = createTestApp({
    presignRateLimit: createPresignRateLimit({
      maxRequests: 1,
      now: () => 1_000,
      windowMs: 100,
    }),
  });

  await withServer(app, async (baseUrl) => {
    const first = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    }, { authToken: null });
    const second = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    }, { authToken: null });

    assert.equal(first.status, 401);
    assert.equal(second.status, 429);
    assert.equal(second.body.error, 'Too many presign requests');
    assert.equal(calls.length, 0);
  });
});

test('presign endpoints apply rate limiting', async () => {
  let currentTime = 1_000;
  const { app } = createTestApp({
    presignRateLimit: createPresignRateLimit({
      maxRequests: 1,
      now: () => currentTime,
      windowMs: 10,
    }),
  });

  await withServer(app, async (baseUrl) => {
    const first = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    });
    const second = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    });
    currentTime += 11;
    const afterWindow = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 42,
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(second.body.error, 'Too many presign requests');
    assert.equal(afterWindow.status, 200);
  });
});
