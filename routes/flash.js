import { Router } from 'express';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { WebSocket } from 'ws';
import { getJob, createJob } from '../services/storage.js';
import { deviceSockets } from '../services/websocket.js';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

const FIRMWARE_CACHE_PATH = join(homedir(), '.chip-build-cache', 'esp32dev', '.pio', 'build', 'esp32dev', 'firmware.bin');
const FIRMWARE_B64_CACHE = join(homedir(), '.chip-build-cache', 'last_firmware.b64');

router.post('/api/flash', asyncRoute(async (req, res) => {
  const {
    jobId: compileJobId,
    binBase64: rawBase64,
    deviceId = 'default_device',
    offset: requestedOffset,
    filename: rawFilename = 'firmware.bin',
  } = req.body ?? {};

  const filename = typeof rawFilename === 'string' ? rawFilename.replace(/[^\w.\-]/g, '_') : 'firmware.bin';
  const targetDeviceId = typeof deviceId === 'string' ? deviceId.replace(/[^\w.\-]/g, '_') : 'default_device';

  let payloadBase64 = typeof rawBase64 === 'string' ? rawBase64 : null;
  let targetOffset = typeof requestedOffset === 'string' ? requestedOffset : null;

  if (payloadBase64 && payloadBase64.startsWith('compile_')) {
    const compileJob = await getJob(payloadBase64);
    payloadBase64 = compileJob?.binBase64;
    targetOffset = compileJob?.offset || targetOffset || '0x0';
  } else if (!payloadBase64 && compileJobId && typeof compileJobId === 'string') {
    const compileJob = await getJob(compileJobId);
    payloadBase64 = compileJob?.binBase64;
    targetOffset = compileJob?.offset || targetOffset || '0x0';
  }

  if (!payloadBase64) {
    try {
      if (existsSync(FIRMWARE_B64_CACHE)) {
        payloadBase64 = await readFile(FIRMWARE_B64_CACHE, 'utf8');
      } else if (existsSync(FIRMWARE_CACHE_PATH)) {
        payloadBase64 = (await readFile(FIRMWARE_CACHE_PATH)).toString('base64');
      }
    } catch {
      // fallback ignore
    }
  }

  if (!payloadBase64) {
    return res.status(400).json({ error: 'No compiled binary found. Please run compile_firmware first.' });
  }

  const offset = targetOffset && /^0x[0-9a-fA-F]+$/.test(targetOffset) ? targetOffset : '0x0';

  let finalTargetId = targetDeviceId;
  let socket = deviceSockets.get(targetDeviceId);
  if (!socket) {
    const first = deviceSockets.entries().next().value;
    if (first) [finalTargetId, socket] = first;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: `No active browser connected for device "${targetDeviceId}"` });
  }

  const flashJobId = `flash_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const userId = await resolveUserId(req, finalTargetId);

  createJob({
    jobId: flashJobId,
    userId,
    deviceId: finalTargetId,
    filename,
    offset,
    status: 'started',
    progress: 0,
    log: ['Job created, relaying firmware binary to browser dashboard...'],
  });

  socket.send(
    JSON.stringify({
      type: 'flash_payload',
      jobId: flashJobId,
      filename,
      offset,
      binBase64: payloadBase64,
    })
  );

  res.json({
    jobId: flashJobId,
    status: 'started',
    offset,
    message: `Firmware relayed to browser dashboard for ${finalTargetId}`,
  });
}));

export default router;
