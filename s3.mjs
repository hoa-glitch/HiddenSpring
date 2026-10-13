import { S3Client } from '@aws-sdk/client-s3';

// WHEN_REQUIRED stops the SDK from adding checksum parameters to signed upload links;
// the browser can't supply that checksum, so S3 would reject the upload.
// S3_ENDPOINT is only for local testing against an S3 stand-in; leave it unset on AWS.
export const s3 = new S3Client({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
});
