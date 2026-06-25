import test from 'node:test';
import assert from 'node:assert/strict';
import { createB2S3Client, getB2PublicUrl, getB2Settings } from '../b2-config.js';

const B2_ENV_KEYS = [
  'B2_APPLICATION_KEY_ID',
  'B2_APPLICATION_KEY',
  'B2_BUCKET_NAME',
  'B2_REGION',
  'B2_PUBLIC_URL_BASE',
];
const SAMPLE_REGION = ['us', 'west', '002'].join('-');
const SAMPLE_ENDPOINT = `https://s3.${SAMPLE_REGION}.backblazeb2.com`;

function withB2Env(values, fn) {
  const previous = new Map();

  for (const key of B2_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  Object.assign(process.env, values);

  try {
    fn();
  } finally {
    for (const key of B2_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('getB2Settings reads standardized env vars and derives the S3 endpoint', () => {
  withB2Env({
    B2_APPLICATION_KEY_ID: 'application-key-id',
    B2_APPLICATION_KEY: 'application-key',
    B2_BUCKET_NAME: 'sample-bucket',
    B2_REGION: SAMPLE_REGION,
    B2_PUBLIC_URL_BASE: 'https://cdn.example.com/files/',
  }, () => {
    assert.deepEqual(getB2Settings(), {
      applicationKeyId: 'application-key-id',
      applicationKey: 'application-key',
      bucketName: 'sample-bucket',
      endpoint: SAMPLE_ENDPOINT,
      publicUrlBase: 'https://cdn.example.com/files',
      region: SAMPLE_REGION,
    });
  });
});

test('getB2Settings rejects missing required B2 env vars', () => {
  withB2Env({
    B2_APPLICATION_KEY_ID: 'application-key-id',
    B2_APPLICATION_KEY: 'application-key',
  }, () => {
    assert.throws(
      () => getB2Settings(),
      /Missing required B2 environment variables: B2_BUCKET_NAME, B2_REGION/
    );
  });
});

test('getB2Settings rejects placeholder B2 env vars', () => {
  withB2Env({
    B2_APPLICATION_KEY_ID: 'application-key-id',
    B2_APPLICATION_KEY: 'application-key',
    B2_BUCKET_NAME: 'your-bucket-name',
    B2_REGION: SAMPLE_REGION,
  }, () => {
    assert.throws(
      () => getB2Settings(),
      /B2 environment variables still have placeholder values: B2_BUCKET_NAME/
    );
  });
});

test('getB2PublicUrl returns encoded public URLs when configured', () => {
  const settings = {
    publicUrlBase: 'https://cdn.example.com/files',
  };

  assert.equal(
    getB2PublicUrl('audio/file name#.mp3', settings),
    'https://cdn.example.com/files/audio/file%20name%23.mp3'
  );
  assert.equal(getB2PublicUrl('audio/file.mp3', { publicUrlBase: '' }), null);
});

test('createB2S3Client sets the Backblaze sample custom user agent', () => {
  const client = createB2S3Client({
    applicationKeyId: 'application-key-id',
    applicationKey: 'application-key',
    bucketName: 'sample-bucket',
    endpoint: SAMPLE_ENDPOINT,
    publicUrlBase: '',
    region: SAMPLE_REGION,
  });

  assert.match(
    JSON.stringify(client.config.customUserAgent),
    /\(backblaze-b2-samples\)/
  );
});
