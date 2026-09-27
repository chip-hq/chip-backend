import { writeFile, readFile, mkdir, readdir, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { createHash } from 'crypto';

/**
 * On-disk store for OTA app binaries. Kept out of MongoDB (a 1–2MB base64
 * blob per release would bloat documents); files expire after 7 days.
 * Imported by platformio-runner (write at compile) and routes/ota.js (read
 * at publish/download). Owns its cache path so neither side import-cycles.
 */
export const OTA_CACHE_BASE = process.env.CHIP_BUILD_CACHE_DIR
  ? process.env.CHIP_BUILD_CACHE_DIR
  : join(homedir(), '.chip-build-cache');

export const OTA_DIR = join(OTA_CACHE_BASE, 'ota');
const OTA_RETENTION_MS = 7 * 24 * 3600 * 1000;

export async function ensureOtaDir() {
  await mkdir(OTA_DIR, { recursive: true });
}

export function otaJobPath(jobId) {
  return join(OTA_DIR, `${String(jobId).replace(/[^\w.\-]/g, '_')}.bin`);
}

export function otaReleasePath(releaseId) {
  return join(OTA_DIR, `${String(releaseId).replace(/[^\w.\-]/g, '_')}.bin`);
}

/** Persist the app-only image at compile time; returns { sha256, size }. */
export async function persistOtaArtifact(jobId, appBinBuffer) {
  await ensureOtaDir();
  await writeFile(otaJobPath(jobId), appBinBuffer);
  return {
    sha256: createHash('sha256').update(appBinBuffer).digest('hex'),
    size: appBinBuffer.length,
  };
}

export async function loadOtaBinary(kind, id) {
  const p = kind === 'release' ? otaReleasePath(id) : otaJobPath(id);
  if (!existsSync(p)) return null;
  try {
    return await readFile(p);
  } catch {
    return null;
  }
}

/** Best-effort expiry sweep; never throws. */
export async function sweepOtaDir() {
  try {
    const files = await readdir(OTA_DIR);
    const now = Date.now();
    await Promise.all(files.map(async (f) => {
      try {
        const p = join(OTA_DIR, f);
        const st = await stat(p);
        if (now - st.mtimeMs > OTA_RETENTION_MS) await unlink(p);
      } catch { /* ignore per-file errors */ }
    }));
  } catch { /* missing dir is fine */ }
}
