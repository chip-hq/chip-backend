import { Router } from 'express';
import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import {
  ensureOtaDir,
  otaJobPath,
  otaReleasePath,
  loadOtaBinary,
  sweepOtaDir,
} from '../services/ota-store.js';
import {
  getJob,
  getGroup,
  createRelease,
  listReleases,
  latestReleaseForDevice,
  createRollout,
  getRollout,
  listRollouts,
  updateRolloutDoc,
  reportOtaStatus,
  verifyDeviceToken,
} from '../services/storage.js';
import { sendToDevice, getDeviceRoute, otaHooks } from '../services/websocket.js';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

sweepOtaDir();

async function loadReleaseBinary(release) {
  return loadOtaBinary('release', release.releaseId);
}

/** Push an OTA trigger down a board's live channel; record queued/triggered. */
function triggerDeviceOta(deviceId, release) {
  const path = `/api/ota/firmware?deviceId=${encodeURIComponent(deviceId)}&token=__DEVICE_TOKEN__`;
  const ok = sendToDevice(deviceId, {
    type: 'ota_update',
    version: release.version,
    path,
    sha256: release.sha256,
    size: release.size,
  });
  reportOtaStatus(deviceId, { status: ok ? 'triggered' : 'queued', version: release.version });
  return ok;
}

/** Fill the current batch with queued boards (up to batchSize in flight). */
export async function advanceRollout(rolloutId) {
  const rollout = await getRollout(rolloutId);
  if (!rollout || rollout.state !== 'running') return rollout;
  const ids = Object.keys(rollout.devices ?? {});
  const terminalBad = (s) => s === 'failed' || s === 'rolled_back';
  const inFlight = (s) => s === 'triggered' || s === 'downloading' || s === 'applying';
  const terminalGood = (s) => s === 'applied' || s === 'healthy';

  if (ids.some((id) => terminalBad(rollout.devices[id].status))) {
    rollout.state = 'paused';
    updateRolloutDoc(rollout);
    return rollout;
  }

  const releases = await listReleases(rollout.userId, 200);
  const release = releases.find((r) => r.releaseId === rollout.releaseId);
  if (!release) {
    rollout.state = 'paused';
    updateRolloutDoc(rollout);
    return rollout;
  }

  const flying = ids.filter((id) => inFlight(rollout.devices[id].status)).length;
  const queued = ids.filter((id) => rollout.devices[id].status === 'queued');
  const slots = Math.max(0, rollout.batchSize - flying);
  for (const id of queued.slice(0, slots)) {
    const ok = triggerDeviceOta(id, release);
    rollout.devices[id] = { status: ok ? 'triggered' : 'queued', updatedAt: new Date(), error: null };
  }

  const remaining = ids.filter((id) => !terminalGood(rollout.devices[id].status));
  if (remaining.length === 0) rollout.state = 'done';
  updateRolloutDoc(rollout);
  return rollout;
}

async function rolloutsContaining(deviceId) {
  const all = await listRollouts(null, 200);
  return all.filter((r) => r.state === 'running' && r.devices && r.devices[deviceId]);
}

// Late-bound by services/websocket.js (import cycle avoided by design).
otaHooks.noteOtaStatus = (deviceId, status, version) => {
  void (async () => {
    try {
      const running = await rolloutsContaining(deviceId);
      for (const r of running) {
        const full = await getRollout(r.rolloutId);
        if (!full || full.state !== 'running' || !full.devices[deviceId]) continue;
        full.devices[deviceId] = { status, updatedAt: new Date(), error: null };
        updateRolloutDoc(full);
        await advanceRollout(full.rolloutId);
      }
    } catch (err) {
      console.error('[OTA] noteOtaStatus bookkeeping failed:', err?.message ?? err);
    }
  })();
};

otaHooks.noteVersion = (deviceId, version) => {
  void (async () => {
    try {
      if (!version) return;
      const running = await rolloutsContaining(deviceId);
      for (const r of running) {
        const full = await getRollout(r.rolloutId);
        if (!full || full.state !== 'running') continue;
        const entry = full.devices[deviceId];
        if (entry && entry.status === 'applied' && full.version === version) {
          entry.status = 'healthy';
          entry.updatedAt = new Date();
          updateRolloutDoc(full);
          await advanceRollout(full.rolloutId);
        }
      }
    } catch (err) {
      console.error('[OTA] noteVersion bookkeeping failed:', err?.message ?? err);
    }
  })();
};

// ── Publish ──────────────────────────────────────────────────────────────────

/**
 * Publish a firmware build as an OTA release and trigger it.
 * - Single board: { deviceId, jobId|binBase64, version } → immediate trigger.
 * - Group: { groupId, jobId|binBase64, version, batchSize? } → staged rollout
 *   (batchSize defaults to the whole group = one-shot fan-out with tracking).
 */
router.post('/api/ota/publish', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  const { deviceId = null, groupId = null, jobId = null, binBase64 = null, version, batchSize } = req.body ?? {};

  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: '"version" (string, e.g. "1.2.0") is required.' });
  }
  if (!deviceId && !groupId) {
    return res.status(400).json({ error: 'Target one of "deviceId" or "groupId".' });
  }

  let appBuf = null;
  let filename = 'firmware.bin';
  if (typeof binBase64 === 'string' && binBase64.length > 0) {
    try {
      appBuf = Buffer.from(binBase64, 'base64');
    } catch {
      return res.status(400).json({ error: 'binBase64 is not valid base64.' });
    }
  } else if (typeof jobId === 'string' && jobId) {
    const job = await getJob(jobId);
    const p = otaJobPath(jobId);
    if (!job || !existsSync(p)) {
      return res.status(400).json({ error: `No OTA artifact for job "${jobId}" (expired or never compiled with OTA partitions). Recompile, then publish.` });
    }
    appBuf = await readFile(p);
    filename = job.filename || filename;
  } else {
    return res.status(400).json({ error: 'Provide "jobId" (from compile_firmware) or raw "binBase64" app image.' });
  }
  if (!appBuf || appBuf.length < 1024) {
    return res.status(400).json({ error: 'Firmware image looks invalid (under 1KB).' });
  }

  await ensureOtaDir();
  await sweepOtaDir();
  const sha256 = createHash('sha256').update(appBuf).digest('hex');

  if (groupId) {
    const group = await getGroup(String(groupId));
    if (!group || (userId !== 'anonymous' && group.userId !== userId)) {
      return res.status(404).json({ error: `Group "${groupId}" not found.` });
    }
    const members = [...new Set(group.memberIds ?? [])];
    if (members.length === 0) {
      return res.status(400).json({ error: `Group "${groupId}" has no member boards.` });
    }
    const release = await createRelease({
      userId, version, target: { groupId: group.groupId }, jobId, sha256, size: appBuf.length, filename,
    });
    await writeFile(otaReleasePath(release.releaseId), appBuf);
    const rollout = await createRollout({
      userId,
      groupId: group.groupId,
      releaseId: release.releaseId,
      version,
      memberIds: members,
      batchSize: batchSize ?? members.length,
    });
    const advanced = await advanceRollout(rollout.rolloutId);
    return res.json({ release, rollout: advanced });
  }

  const targetDeviceId = String(deviceId).replace(/[^\w.\-]/g, '_');
  const release = await createRelease({
    userId, version, target: { deviceId: targetDeviceId }, jobId, sha256, size: appBuf.length, filename,
  });
  await writeFile(otaReleasePath(release.releaseId), appBuf);
  const delivered = triggerDeviceOta(targetDeviceId, release);
  res.json({ release, delivered, route: delivered ? 'wifi' : getDeviceRoute(targetDeviceId) });
}));

// ── Releases ─────────────────────────────────────────────────────────────────

router.get('/api/ota/releases', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  const releases = await listReleases(userId === 'anonymous' ? null : userId, req.query.limit);
  res.json({ count: releases.length, releases });
}));

/**
 * Device firmware download. Authed by the board's own claim token
 * (query ?deviceId=&token=[&version=]). Latest applicable release wins
 * when version is omitted.
 */
router.get('/api/ota/firmware', asyncRoute(async (req, res) => {
  const deviceId = String(req.query.deviceId || '');
  const token = String(req.query.token || '');
  const dev = await verifyDeviceToken(deviceId, token);
  if (!dev) return res.status(401).json({ error: 'Invalid deviceId/token.' });

  const releases = await listReleases(dev.userId, 200);
  let release = null;
  if (req.query.version) {
    release = releases.find((r) =>
      String(r.version) === String(req.query.version) &&
      (r.targetDeviceId === deviceId || r.targetGroupId));
  } else {
    release = await latestReleaseForDevice(deviceId, dev.userId);
  }
  if (!release) return res.status(404).json({ error: 'No OTA release pending for this device.' });

  const buf = await loadReleaseBinary(release);
  if (!buf) return res.status(410).json({ error: 'Release binary expired from the server cache. Republish the update.' });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('X-Chip-Version', release.version);
  res.setHeader('X-Chip-SHA256', release.sha256);
  res.setHeader('X-Chip-Size', String(release.size));
  res.send(buf);
}));

// ── Rollouts ─────────────────────────────────────────────────────────────────

router.post('/api/ota/rollouts', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  const { groupId, releaseId = null, jobId = null, version = null, batchSize = 5 } = req.body ?? {};
  if (!groupId) return res.status(400).json({ error: '"groupId" is required.' });
  const group = await getGroup(String(groupId));
  if (!group || (userId !== 'anonymous' && group.userId !== userId)) {
    return res.status(404).json({ error: `Group "${groupId}" not found.` });
  }
  const members = [...new Set(group.memberIds ?? [])];
  if (members.length === 0) return res.status(400).json({ error: 'Group has no member boards.' });

  let release = null;
  if (releaseId) {
    const releases = await listReleases(userId === 'anonymous' ? null : userId, 200);
    release = releases.find((r) => r.releaseId === releaseId) ?? null;
    if (!release) return res.status(404).json({ error: `Release "${releaseId}" not found.` });
  } else {
    if (!jobId || !version) return res.status(400).json({ error: 'Provide "releaseId" or ("jobId" + "version").' });
    const job = await getJob(jobId);
    const p = otaJobPath(jobId);
    if (!job || !existsSync(p)) {
      return res.status(400).json({ error: `No OTA artifact for job "${jobId}". Recompile, then retry.` });
    }
    const appBuf = await readFile(p);
    await ensureOtaDir();
    release = await createRelease({
      userId, version, target: { groupId: group.groupId }, jobId,
      sha256: createHash('sha256').update(appBuf).digest('hex'), size: appBuf.length, filename: job.filename || 'firmware.bin',
    });
    await writeFile(otaReleasePath(release.releaseId), appBuf);
  }

  const rollout = await createRollout({
    userId, groupId: group.groupId, releaseId: release.releaseId, version: release.version, memberIds: members, batchSize,
  });
  const advanced = await advanceRollout(rollout.rolloutId);
  res.json({ rollout: advanced });
}));

router.get('/api/ota/rollouts', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  const rollouts = await listRollouts(userId === 'anonymous' ? null : userId, req.query.limit);
  res.json({ count: rollouts.length, rollouts });
}));

router.get('/api/ota/rollouts/:rolloutId', asyncRoute(async (req, res) => {
  const rollout = await getRollout(String(req.params.rolloutId));
  if (!rollout) return res.status(404).json({ error: 'Rollout not found.' });
  res.json({ rollout });
}));

router.post('/api/ota/rollouts/:rolloutId/advance', asyncRoute(async (req, res) => {
  const rollout = await getRollout(String(req.params.rolloutId));
  if (!rollout) return res.status(404).json({ error: 'Rollout not found.' });
  if (rollout.state === 'paused') rollout.state = 'running';
  const advanced = await advanceRollout(rollout.rolloutId);
  res.json({ rollout: advanced });
}));

router.post('/api/ota/rollouts/:rolloutId/pause', asyncRoute(async (req, res) => {
  const rollout = await getRollout(String(req.params.rolloutId));
  if (!rollout) return res.status(404).json({ error: 'Rollout not found.' });
  rollout.state = 'paused';
  updateRolloutDoc(rollout);
  res.json({ rollout });
}));

export default router;
