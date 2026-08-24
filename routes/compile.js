// routes/compile.js — PlatformIO firmware compilation endpoint.

import { Router } from 'express';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createJob, updateJob } from '../services/storage.js';
import { compileFirmware } from '../services/platformio-runner.js';
import { deviceSockets } from '../services/websocket.js';
import { resolveUserId } from '../services/user-resolver.js';

const router = Router();

const FIRMWARE_B64_CACHE = join(homedir(), '.chip-build-cache', 'last_firmware.b64');

// Compile firmware via PlatformIO (used by MCP compile_firmware and direct API)
router.post('/api/compile', async (req, res) => {
  const { source, board = 'esp32' } = req.body;

  if (!source || typeof source !== 'string' || source.trim().length === 0) {
    return res.status(400).json({ error: '"source" (C++ string) is required' });
  }

  const jobId = `compile_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const anyDevice = Array.from(deviceSockets.keys())[0];
  const userId = await resolveUserId(req, anyDevice);

  createJob({
    jobId,
    userId,
    phase: 'compile',
    board,
    sourceCode: source,
    filename: `firmware_${board}.bin`,
    status: 'compiling',
    progress: 0,
    log: ['Compile job started…'],
  });

  console.log(`[COMPILE] Job ${jobId} started — board: ${board}`);

  try {
    const result = await compileFirmware({
      source,
      board,
      jobId,
      onLog: (line) => {
        updateJob(jobId, { logLine: line });
      },
    });

    updateJob(jobId, {
      status: 'done',
      progress: 100,
      binBase64: result.binBase64,
      binSize: result.binSize,
      offset: result.offset || '0x0',
      filename: `firmware_${board}.bin`,
      sourceCode: source,
      logLine: `Done — ${result.binSize} bytes in ${(result.durationMs / 1000).toFixed(1)}s`,
    });

    // Persist binary to disk so it survives restarts
    try {
      await mkdir(join(homedir(), '.chip-build-cache'), { recursive: true });
      await writeFile(FIRMWARE_B64_CACHE, result.binBase64, 'utf8');
    } catch {
      // non-fatal
    }

    console.log(`[COMPILE] Job ${jobId} done — ${result.binSize} bytes (@ ${result.offset || '0x0'})`);

    return res.json({
      jobId,
      status: 'done',
      binBase64: result.binBase64,
      binSize: result.binSize,
      offset: result.offset || '0x0',
      durationMs: result.durationMs,
      log: result.log,
    });
  } catch (err) {
    updateJob(jobId, { status: 'error', error: err.message, logLine: `Error: ${err.message}` });
    console.error(`[COMPILE] Job ${jobId} failed:`, err.message);
    return res.status(500).json({ jobId, status: 'error', error: err.message });
  }
});

export default router;
