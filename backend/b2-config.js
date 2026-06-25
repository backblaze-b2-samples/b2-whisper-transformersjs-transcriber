import { S3Client } from '@aws-sdk/client-s3';

export const B2_SAMPLE_USER_AGENT = 'b2-whisper-transformersjs-transcriber (backblaze-b2-samples)';

const REQUIRED_SETTINGS = [
  {
    name: 'applicationKeyId',
    envKey: 'B2_APPLICATION_KEY_ID',
    legacyEnvKeys: ['B2_KEY_ID'],
  },
  {
    name: 'applicationKey',
    envKey: 'B2_APPLICATION_KEY',
    legacyEnvKeys: ['B2_APP_KEY'],
  },
  {
    name: 'bucketName',
    envKey: 'B2_BUCKET_NAME',
    legacyEnvKeys: ['B2_BUCKET'],
  },
  {
    name: 'region',
    envKey: 'B2_REGION',
    legacyEnvKeys: [],
  },
];

const PLACEHOLDER_VALUES = new Set([
  'your_application_key_id',
  'your_application_key',
  'your_application_key_here',
  'your_key_id_here',
  'your_app_key_here',
  'your-bucket-name',
  'your_region',
]);

function cleanValue(key, env) {
  return (env[key] || '').trim();
}

function parseLegacyEndpointRegion(endpoint) {
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return '';
    }

    const match = url.hostname.toLowerCase().match(/^s3[.-]([a-z]+-[a-z]+-\d+)\.backblazeb2\.com$/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function emitDeprecation(warn, message) {
  if (typeof warn === 'function') {
    warn(message);
  }
}

function readRequiredSetting(setting, env, warn) {
  const primaryValue = cleanValue(setting.envKey, env);
  const legacyValues = setting.legacyEnvKeys
    .map((key) => ({ key, value: cleanValue(key, env) }))
    .filter(({ value }) => value);

  if (primaryValue) {
    for (const { key } of legacyValues) {
      emitDeprecation(
        warn,
        `${key} is deprecated and ignored because ${setting.envKey} is set. ` +
          `Keep both during rollout, then remove ${key} after migration.`
      );
    }
    return {
      key: setting.envKey,
      value: primaryValue,
    };
  }

  if (legacyValues.length > 0) {
    const { key, value } = legacyValues[0];
    emitDeprecation(
      warn,
      `${key} is deprecated. Set ${setting.envKey}; ${setting.envKey} takes precedence when both are present.`
    );
    return { key, value };
  }

  return {
    key: setting.envKey,
    value: '',
  };
}

export function getB2Settings({ env = process.env, warn = console.warn } = {}) {
  const settings = {};
  const usedKeys = {};

  for (const setting of REQUIRED_SETTINGS) {
    const { key, value } = readRequiredSetting(setting, env, warn);
    settings[setting.name] = value;
    usedKeys[setting.name] = key;
  }

  const legacyEndpoint = cleanValue('B2_ENDPOINT', env);
  let legacyEndpointRegion = '';
  if (legacyEndpoint) {
    emitDeprecation(
      warn,
      'B2_ENDPOINT is deprecated. Set B2_REGION and let the app derive the S3-compatible endpoint.'
    );

    legacyEndpointRegion = parseLegacyEndpointRegion(legacyEndpoint);
    if (!legacyEndpointRegion) {
      throw new Error(
        'Invalid B2_ENDPOINT. Use https://s3.<region>.backblazeb2.com without credentials, paths, query strings, or fragments.'
      );
    }
  }

  if (!settings.region && legacyEndpointRegion) {
    settings.region = legacyEndpointRegion;
    usedKeys.region = 'B2_ENDPOINT';
  }

  const missing = REQUIRED_SETTINGS
    .filter((setting) => !settings[setting.name])
    .map((setting) => setting.envKey);
  if (missing.length > 0) {
    throw new Error(`Missing required B2 environment variables: ${missing.join(', ')}`);
  }

  const placeholders = REQUIRED_SETTINGS
    .filter((setting) => PLACEHOLDER_VALUES.has(settings[setting.name]))
    .map((setting) => usedKeys[setting.name] || setting.envKey);
  if (placeholders.length > 0) {
    throw new Error(`B2 environment variables still have placeholder values: ${placeholders.join(', ')}`);
  }
  if (legacyEndpointRegion && legacyEndpointRegion !== settings.region) {
    throw new Error('B2_ENDPOINT region must match B2_REGION while both are configured.');
  }

  const publicUrlBase = cleanValue('B2_PUBLIC_URL_BASE', env).replace(/\/+$/, '');

  return {
    applicationKeyId: settings.applicationKeyId,
    applicationKey: settings.applicationKey,
    bucketName: settings.bucketName,
    endpoint: `https://s3.${settings.region}.backblazeb2.com`,
    publicUrlBase,
    region: settings.region,
  };
}

export function getB2S3ClientOptions(settings = getB2Settings()) {
  return {
    endpoint: settings.endpoint,
    region: settings.region,
    credentials: {
      accessKeyId: settings.applicationKeyId,
      secretAccessKey: settings.applicationKey,
    },
    forcePathStyle: true,
    customUserAgent: B2_SAMPLE_USER_AGENT,
  };
}

export function createB2S3Client(settings = getB2Settings()) {
  return new S3Client(getB2S3ClientOptions(settings));
}

export function getB2PublicUrl(key, settings = getB2Settings()) {
  if (!settings.publicUrlBase) {
    return null;
  }

  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${settings.publicUrlBase}/${encodedKey}`;
}
