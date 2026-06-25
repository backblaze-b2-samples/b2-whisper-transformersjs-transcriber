#!/usr/bin/env node

import { PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import { createB2S3Client, getB2Settings } from './b2-config.js';

dotenv.config();

let b2Settings;
try {
  b2Settings = getB2Settings();
} catch (error) {
  console.error('❌ Invalid B2 environment configuration!');
  console.error(error.message);
  console.error('Please set: B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, B2_REGION');
  process.exit(1);
}

const s3Client = createB2S3Client(b2Settings);
const BUCKET = b2Settings.bucketName;

// CORS rules for S3 Compatible API with PUT support
const corsRules = {
  CORSRules: [
    {
      AllowedOrigins: ['*'],
      AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag', 'x-amz-request-id', 'x-amz-id-2'],
      MaxAgeSeconds: 3600,
    },
  ],
};

async function forceCORS() {
  console.log('🔧 Force-setting S3 Compatible API CORS for bucket:', BUCKET);
  console.log('   This will overwrite any existing S3 CORS rules...\n');

  try {
    // Try to apply CORS rules directly (force)
    const command = new PutBucketCorsCommand({
      Bucket: BUCKET,
      CORSConfiguration: corsRules,
    });

    await s3Client.send(command);
    console.log('✅ CORS rules applied successfully!\n');

    // Verify
    const getCommand = new GetBucketCorsCommand({ Bucket: BUCKET });
    const result = await s3Client.send(getCommand);
    console.log('✅ Verified - Current S3 CORS Configuration:');
    console.log(JSON.stringify(result.CORSRules, null, 2));
    console.log('\n🎉 Done! CORS is configured. Try uploading now!\n');

  } catch (error) {
    console.error('❌ Error:', error.message);

    if (error.Code === 'InvalidRequest' && error.message.includes('B2 Native CORS')) {
      console.error('\n⚠️  Your bucket CORS is set to "B2 Native API" only');
      console.error('\nManual fix required:');
      console.error('1. Go to: https://secure.backblaze.com/b2_buckets.htm');
      console.error('2. Click bucket → Bucket Settings → CORS Rules');
      console.error('3. Change API selection from "B2 Native API" to "S3 Compatible API"');
      console.error('   OR select "Both APIs"');
      console.error('4. If rules exist, delete them first');
      console.error('5. Save, then run this script again\n');
    } else {
      console.error('\nFull error:', error);
    }

    process.exit(1);
  }
}

forceCORS();
