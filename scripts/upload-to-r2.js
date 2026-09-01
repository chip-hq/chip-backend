/**
 * Chip — Cloudflare R2 Batch Symbol Uploader
 * Uploads all KiCad symbol libraries directly to your Cloudflare R2 bucket.
 * 
 * Usage:
 *   node scripts/upload-to-r2.js
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFile, readdir, stat } from 'fs/promises';
import { join, relative, resolve } from 'path';
import 'dotenv/config';

// Cloudflare R2 Configuration
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '7ff2fa5391105731b4adfa28e80d9427';
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.SECRET_ACCESS_KEY;
const BUCKET_NAME = process.env.R2_BUCKET_NAME || 'chipbucket';
const PREFIX = 'Symbols/';

// Local KiCad symbols directory
const SOURCE_DIR = process.env.KICAD_SYMBOL_SOURCE || 'C:/Users/josep/Downloads/kicad-symbols-master';

if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
  console.error('\n❌ Missing Cloudflare R2 credentials in backend/.env:');
  console.error('Please add:');
  console.error('  R2_ACCOUNT_ID="your-cloudflare-account-id"');
  console.error('  R2_ACCESS_KEY_ID="your-r2-access-key-id"');
  console.error('  R2_SECRET_ACCESS_KEY="your-r2-secret-access-key"');
  console.error('  R2_BUCKET_NAME="your-bucket-name" (e.g. chip-kicad-symbols)\n');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});

async function getAllFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      const subFiles = await getAllFiles(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      if (
        entry.name.endsWith('.kicad_sym') ||
        entry.name.endsWith('.sym') ||
        entry.name === 'sym-lib-table' ||
        fullPath.includes('.kicad_symdir')
      ) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function uploadFile(filePath, total, index, retries = 3) {
  const relPath = relative(SOURCE_DIR, filePath).replace(/\\/g, '/');
  const fileBuffer = await readFile(filePath);
  const key = `${PREFIX}${relPath}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: fileBuffer,
        ContentType: 'text/plain',
      });

      await s3.send(command);
      console.log(`[${index + 1}/${total}] Uploaded: ${key} (${(fileBuffer.length / 1024).toFixed(1)} KB)`);
      return;
    } catch (err) {
      if (attempt === retries) {
        console.warn(`⚠️ Warning: Failed to upload ${key} after ${retries} attempts:`, err.message);
      } else {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
}

async function main() {
  console.log(`\n🚀 Scanning symbols from: ${SOURCE_DIR}...`);
  const files = await getAllFiles(SOURCE_DIR);
  console.log(`Found ${files.length} symbol files to upload to R2 bucket "${BUCKET_NAME}".\n`);

  const concurrency = 500;
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    await Promise.all(batch.map((f, idx) => uploadFile(f, files.length, i + idx)));
  }

  console.log(`\n✅ Successfully uploaded ${files.length} symbol files to Cloudflare R2!`);
}

main().catch((err) => {
  console.error('\n❌ Upload failed:', err);
  process.exit(1);
});
