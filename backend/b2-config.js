import { S3Client } from '@aws-sdk/client-s3';

const REQUIRED_ENV = [
  'B2_APPLICATION_KEY_ID',
  'B2_APPLICATION_KEY',
  'B2_BUCKET_NAME',
  'B2_REGION',
];

const PLACEHOLDER_VALUES = new Set([
  'your_application_key_id',
  'your_application_key',
  'your_application_key_here',
  'your-bucket-name',
  'your_region',
]);

function cleanValue(key) {
  return (process.env[key] || '').trim();
}

export function getB2Settings() {
  const missing = REQUIRED_ENV.filter((key) => !cleanValue(key));
  if (missing.length > 0) {
    throw new Error(`Missing required B2 environment variables: ${missing.join(', ')}`);
  }

  const placeholders = REQUIRED_ENV.filter((key) => PLACEHOLDER_VALUES.has(cleanValue(key)));
  if (placeholders.length > 0) {
    throw new Error(`B2 environment variables still have placeholder values: ${placeholders.join(', ')}`);
  }

  const region = cleanValue('B2_REGION');
  const publicUrlBase = cleanValue('B2_PUBLIC_URL_BASE').replace(/\/+$/, '');

  return {
    applicationKeyId: cleanValue('B2_APPLICATION_KEY_ID'),
    applicationKey: cleanValue('B2_APPLICATION_KEY'),
    bucketName: cleanValue('B2_BUCKET_NAME'),
    endpoint: `https://s3.${region}.backblazeb2.com`,
    publicUrlBase,
    region,
  };
}

export function createB2S3Client(settings = getB2Settings()) {
  return new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    credentials: {
      accessKeyId: settings.applicationKeyId,
      secretAccessKey: settings.applicationKey,
    },
    forcePathStyle: true,
    customUserAgent: 'b2-whisper-transformersjs-transcriber/1.0.0 (backblaze-b2-samples)',
  });
}

export function getB2PublicUrl(key, settings = getB2Settings()) {
  if (!settings.publicUrlBase) {
    return null;
  }

  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${settings.publicUrlBase}/${encodedKey}`;
}
