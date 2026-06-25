import test from 'node:test';
import assert from 'node:assert/strict';
import {
  B2_SAMPLE_USER_AGENT,
  createB2S3Client,
  getB2S3ClientOptions,
  getB2PublicUrl,
  getB2Settings,
} from '../b2-config.js';

const B2_ENV_KEYS = [
  'B2_ENDPOINT',
  'B2_APPLICATION_KEY_ID',
  'B2_APPLICATION_KEY',
  'B2_BUCKET_NAME',
  'B2_REGION',
  'B2_PUBLIC_URL_BASE',
  'B2_KEY_ID',
  'B2_APP_KEY',
  'B2_BUCKET',
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
    const warnings = [];
    assert.deepEqual(getB2Settings({ warn: (message) => warnings.push(message) }), {
      applicationKeyId: 'application-key-id',
      applicationKey: 'application-key',
      bucketName: 'sample-bucket',
      endpoint: SAMPLE_ENDPOINT,
      publicUrlBase: 'https://cdn.example.com/files',
      region: SAMPLE_REGION,
    });
    assert.deepEqual(warnings, []);
  });
});

test('getB2Settings accepts deprecated legacy env aliases', () => {
  withB2Env({
    B2_ENDPOINT: SAMPLE_ENDPOINT,
    B2_KEY_ID: 'legacy-key-id',
    B2_APP_KEY: 'legacy-application-key',
    B2_BUCKET: 'legacy-bucket',
  }, () => {
    const warnings = [];
    assert.deepEqual(getB2Settings({ warn: (message) => warnings.push(message) }), {
      applicationKeyId: 'legacy-key-id',
      applicationKey: 'legacy-application-key',
      bucketName: 'legacy-bucket',
      endpoint: SAMPLE_ENDPOINT,
      publicUrlBase: '',
      region: SAMPLE_REGION,
    });
    assert.equal(warnings.length, 4);
    assert.match(warnings.join('\n'), /B2_KEY_ID is deprecated/);
    assert.match(warnings.join('\n'), /B2_APP_KEY is deprecated/);
    assert.match(warnings.join('\n'), /B2_BUCKET is deprecated/);
    assert.match(warnings.join('\n'), /B2_ENDPOINT is deprecated/);
  });
});

test('getB2Settings gives standardized env vars precedence over aliases', () => {
  withB2Env({
    B2_ENDPOINT: SAMPLE_ENDPOINT,
    B2_APPLICATION_KEY_ID: 'application-key-id',
    B2_APPLICATION_KEY: 'application-key',
    B2_BUCKET_NAME: 'sample-bucket',
    B2_REGION: SAMPLE_REGION,
    B2_KEY_ID: 'legacy-key-id',
    B2_APP_KEY: 'legacy-application-key',
    B2_BUCKET: 'legacy-bucket',
  }, () => {
    const warnings = [];
    assert.deepEqual(getB2Settings({ warn: (message) => warnings.push(message) }), {
      applicationKeyId: 'application-key-id',
      applicationKey: 'application-key',
      bucketName: 'sample-bucket',
      endpoint: SAMPLE_ENDPOINT,
      publicUrlBase: '',
      region: SAMPLE_REGION,
    });
    assert.equal(warnings.length, 4);
    assert.match(warnings.join('\n'), /B2_KEY_ID is deprecated and ignored/);
    assert.match(warnings.join('\n'), /B2_APP_KEY is deprecated and ignored/);
    assert.match(warnings.join('\n'), /B2_BUCKET is deprecated and ignored/);
    assert.match(warnings.join('\n'), /B2_ENDPOINT is deprecated/);
  });
});

test('getB2Settings rejects unsafe legacy B2 endpoints', () => {
  const invalidEndpoints = [
    `http://s3.${SAMPLE_REGION}.backblazeb2.com`,
    `https://user@s3.${SAMPLE_REGION}.backblazeb2.com`,
    `https://s3.${SAMPLE_REGION}.backblazeb2.com/path`,
    `https://s3.${SAMPLE_REGION}.backblazeb2.com?token=value`,
    `https://s3.${SAMPLE_REGION}.backblazeb2.com.evil.example`,
    'https://evil.example',
  ];

  for (const endpoint of invalidEndpoints) {
    withB2Env({
      B2_ENDPOINT: endpoint,
      B2_KEY_ID: 'legacy-key-id',
      B2_APP_KEY: 'legacy-application-key',
      B2_BUCKET: 'legacy-bucket',
    }, () => {
      assert.throws(
        () => getB2Settings({ warn: () => {} }),
        /Invalid B2_ENDPOINT/
      );
    });
  }
});

test('getB2Settings rejects mismatched legacy endpoint and standard region', () => {
  const otherRegion = ['eu', 'central', '003'].join('-');

  withB2Env({
    B2_ENDPOINT: SAMPLE_ENDPOINT,
    B2_APPLICATION_KEY_ID: 'application-key-id',
    B2_APPLICATION_KEY: 'application-key',
    B2_BUCKET_NAME: 'sample-bucket',
    B2_REGION: otherRegion,
  }, () => {
    assert.throws(
      () => getB2Settings({ warn: () => {} }),
      /B2_ENDPOINT region must match B2_REGION/
    );
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
  assert.match(B2_SAMPLE_USER_AGENT, /^b2ai-/);
  assert.match(B2_SAMPLE_USER_AGENT, /\(backblaze-b2-samples\)/);

  const settings = {
    applicationKeyId: 'application-key-id',
    applicationKey: 'application-key',
    bucketName: 'sample-bucket',
    endpoint: SAMPLE_ENDPOINT,
    publicUrlBase: '',
    region: SAMPLE_REGION,
  };
  const clientOptions = getB2S3ClientOptions(settings);
  const client = createB2S3Client(settings);

  assert.equal(clientOptions.customUserAgent, B2_SAMPLE_USER_AGENT);
  assert.equal(client.constructor.name, 'S3Client');
});
