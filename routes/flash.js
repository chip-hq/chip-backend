// routes/flash.js — Flash job creation and WebSocket payload relay.

import { Router } from 'express';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { WebSocket } from 'ws';
import { getJob, createJob } from '../services/storage.js';
import { deviceSockets } from '../services/websocket.js';
import { resolveUserId } from '../services/user-resolver.js';

const router = Router();

const FIRMWARE_CACHE_PATH = join(homedir(), '.chip-build-cache', 'esp32dev', '.pio', 'build', 'esp32dev', 'firmware.bin');
const FIRMWARE_B64_CACHE = join(homedir(), '.chip-build-cache', 'last_firmware.b64');

// Trigger flash job (used by MCP flash_device or direct API)
router.post('/api/flash', async (req, res) => {
  const {
    jobId: compileJobId,
    binBase64: rawBase64,
    deviceId = 'default_device',
    offset: requestedOffset,
    filename = 'firmware.bin',
  } = req.body ?? {};

  let payloadBase64 = rawBase64;
  let targetOffset = requestedOffset;

  // If jobId was passed in binBase64 field (e.g. "compile_...")
  if (payloadBase64 && payloadBase64.startsWith('compile_')) {
    const compileJob = await getJob(payloadBase64);
    payloadBase64 = compileJob?.binBase64;
    targetOffset = compileJob?.offset || targetOffset || '0x0';
  } else if (!payloadBase64 && compileJobId) {
    const compileJob = await getJob(compileJobId);
    payloadBase64 = compileJob?.binBase64;
    targetOffset = compileJob?.offset || targetOffset || '0x0';
  }

  // Fallback to latest compiled binary on disk if memory is empty
  if (!payloadBase64) {
    try {
      if (existsSync(FIRMWARE_B64_CACHE)) {
        payloadBase64 = await readFile(FIRMWARE_B64_CACHE, 'utf8');
      } else if (existsSync(FIRMWARE_CACHE_PATH)) {
        payloadBase64 = (await readFile(FIRMWARE_CACHE_PATH)).toString('base64');
      }
    } catch {
      // ignore
    }
  }

  if (!payloadBase64) {
    return res.status(400).json({ error: 'No compiled binary found. Please run compile_firmware first.' });
  }

  const offset = targetOffset || '0x0';

  // Resolve the target socket: the named device, else the first live one
  let targetId = deviceId;
  let socket = deviceSockets.get(deviceId);
  if (!socket) {
    const first = deviceSockets.entries().next().value;
    if (first) [targetId, socket] = first;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: `No active browser connected for device "${deviceId}"` });
  }

  const flashJobId = `flash_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const userId = await resolveUserId(req, targetId);

  createJob({
    jobId: flashJobId,
    userId,
    deviceId: targetId,
    filename,
    offset,
    status: 'started',
    progress: 0,
    log: ['Job created, relaying firmware binary to browser dashboard...'],
  });

  // Relay binary payload over WebSocket to browser flasher
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
    message: `Firmware relayed to browser dashboard for ${targetId}`,
  });
});

export default router;
