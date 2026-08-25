import { Router } from 'express';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createJob, updateJob, recordAgentConnection } from '../services/storage.js';
import { compileFirmware } from '../services/platformio-runner.js';
import { deviceSockets } from '../services/websocket.js';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

const FIRMWARE_B64_CACHE = join(homedir(), '.chip-build-cache', 'last_firmware.b64');
const ALLOWED_BOARDS = new Set(['esp32', 'esp32dev', 'esp32s2', 'esp32s3', 'esp32c3']);

router.post('/api/compile', asyncRoute(async (req, res) => {
  const { source, board: rawBoard = 'esp32', webCompanion } = req.body || {};

  if (!source || typeof source !== 'string' || source.trim().length === 0) {
    return res.status(400).json({ error: '"source" (C++ string) is required' });
  }

  const board = typeof rawBoard === 'string' && ALLOWED_BOARDS.has(rawBoard.toLowerCase())
    ? rawBoard.toLowerCase()
    : 'esp32';

  if (req.userId) {
    recordAgentConnection({
      userId: req.userId,
      clientName: 'Claude / MCP Agent',
      email: req.userEmail || null,
    });
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
    webCompanion: typeof webCompanion === 'string' ? webCompanion : null,
    filename: `firmware_${board}.bin`,
    status: 'compiling',
    progress: 0,
    log: ['Compile job started…'],
  });

  console.log(`[COMPILE] Job ${jobId} started — board: ${board}${webCompanion ? ' (with Web Companion)' : ''}`);

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
      webCompanion: typeof webCompanion === 'string' ? webCompanion : null,
      logLine: `Done — ${result.binSize} bytes in ${(result.durationMs / 1000).toFixed(1)}s`,
    });

    try {
      await mkdir(join(homedir(), '.chip-build-cache'), { recursive: true });
      await writeFile(FIRMWARE_B64_CACHE, result.binBase64, 'utf8');
    } catch {
      // non-fatal cache write
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
    return res.status(500).json({ jobId, status: 'error', error: 'Firmware compilation failed. Please check your C++ syntax.' });
  }
}));

export default router;
