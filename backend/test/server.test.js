import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, createPresignRateLimit } from '../server.js';

const SAMPLE_REGION = ['us', 'west', '002'].join('-');
const SAMPLE_ENDPOINT = `https://s3.${SAMPLE_REGION}.backblazeb2.com`;
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
    b2Settings: B2_SETTINGS,
    maxAudioFileSize: 100,
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

async function postJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  return {
    body: await response.json(),
    status: response.status,
  };
}

test('audio presign rejects requests above the server-side size limit', async () => {
  const { app, calls } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/presign-audio', {
      contentType: 'audio/mpeg',
      filename: 'clip.mp3',
      size: 101,
    });

    assert.equal(response.status, 413);
    assert.equal(calls.length, 0);
    assert.equal(response.body.error, 'File too large. Maximum size is 100 bytes.');
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
    assert.equal(calls.length, 0);
    assert.equal(response.body.error, 'Missing or invalid file size');
  });
});

test('audio presign signs the intended content length and returns a transcript token', async () => {
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
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, `audio/${response.body.fileId}.mp3`);
    assert.equal(calls[0].contentType, 'audio/mpeg');
    assert.deepEqual(calls[0].options, { contentLength: 42 });
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
    assert.equal(calls.length, 2);
    assert.equal(calls[1].key, `transcripts/${audio.body.fileId}.json`);
    assert.equal(calls[1].contentType, 'application/json');
    assert.deepEqual(calls[1].options, {});
  });
});

test('presign endpoints apply rate limiting', async () => {
  const { app } = createTestApp({
    presignRateLimit: createPresignRateLimit({ maxRequests: 1, windowMs: 60_000 }),
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

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(second.body.error, 'Too many presign requests');
  });
});
