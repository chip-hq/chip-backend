import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  initStorage,
  closeStorage,
  isDbConnected,
  upsertDevice,
  setDeviceConnected,
  listDevices,
  createJob,
  getJob,
  updateJob,
} from './storage.js';
import { compileFirmware } from './platformio-runner.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Live WebSocket sockets by deviceId. A socket can't be persisted, so this map
// (the one thing that must stay in-process) holds only the live connections used
// to relay flashes. All device metadata + job status lives in storage.js.
const deviceSockets = new Map();

// --- WebSocket connection handler --------------------------------------------
wss.on('connection', (ws, req) => {
  let deviceId = 'default_device';

  // Immediately register socket so it is visible to /api/devices and flash relays
  deviceSockets.set(deviceId, ws);
  upsertDevice({ deviceId, chip: 'ESP32', connected: true });
  console.log(`[WS] New client connection from ${req.socket.remoteAddress}`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      // Registration message from browser dashboard
      if (data.type === 'register') {
        deviceId = data.deviceId || 'default_device';
        deviceSockets.set(deviceId, ws);
        upsertDevice({
          deviceId,
          chip: data.chip || 'ESP32',
          connected: data.connected ?? true,
        });
        console.log(`[WS] Device registered: ${deviceId} (${data.chip || 'ESP32'})`);
        ws.send(JSON.stringify({ type: 'registered', deviceId, status: 'ok' }));
      }

      // Progress updates from browser flasher
      if (data.type === 'flash_progress') {
        updateJob(data.jobId, {
          progress: data.progress,
          status: data.status || 'flashing',
          logLine: data.logLine,
        });
      }

      // Flash complete / error updates
      if (data.type === 'flash_complete') {
        updateJob(data.jobId, {
          progress: 100,
          status: 'done',
          logLine: 'Flash successfully completed.',
        });
      }

      if (data.type === 'flash_error') {
        updateJob(data.jobId, {
          status: 'error',
          error: data.error,
          logLine: `Error: ${data.error}`,
        });
      }
    } catch (err) {
      console.error('[WS] Failed to parse message:', err);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Connection closed for ${deviceId}`);
    if (deviceSockets.get(deviceId) === ws) {
      deviceSockets.delete(deviceId);
    }
    setDeviceConnected(deviceId, false);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error on ${deviceId}:`, err);
  });
});

// --- HTTP API Endpoints ------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Chip Backend',
    connectedDevicesCount: deviceSockets.size,
    dbConnected: isDbConnected(),
  });
});

// List known browser devices (used by MCP list_devices).
app.get('/api/devices', async (req, res) => {
  const stored = await listDevices();
  const storedMap = new Map(stored.map((d) => [d.deviceId, d]));

  // Ensure every active WebSocket connection is included with connected: true
  for (const [id] of deviceSockets.entries()) {
    if (storedMap.has(id)) {
      storedMap.get(id).connected = true;
    } else {
      storedMap.set(id, { deviceId: id, chip: 'ESP32', connected: true });
    }
  }

  res.json({ devices: Array.from(storedMap.values()) });
});

// Trigger flash job (used by MCP flash_device or manual API)
app.post('/api/flash', async (req, res) => {
  const { deviceId = 'default_device', offset = '0x10000', binBase64, jobId: compileJobId, filename = 'firmware.bin' } = req.body;

  let payloadBase64 = binBase64;
  if (!payloadBase64 && compileJobId) {
    const compileJob = await getJob(compileJobId);
    payloadBase64 = compileJob?.binBase64;
  }

  if (!payloadBase64) {
    return res.status(400).json({ error: 'Either "binBase64" or a valid "jobId" from compile_firmware is required' });
  }

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
  createJob({
    jobId: flashJobId,
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
    message: `Firmware relayed to browser dashboard for ${targetId}`,
  });
});

// Get flash job status (used by MCP get_status)
app.get('/api/jobs/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

// Compile firmware via PlatformIO (used by MCP compile_firmware)
// Synchronous from the caller's perspective: waits for pio run to finish,
// then returns binBase64 in the response body. The job doc is updated live
// (log lines appended) so the dashboard can poll GET /api/jobs/:jobId.
app.post('/api/compile', async (req, res) => {
  const { source, board = 'esp32' } = req.body;

  if (!source || typeof source !== 'string' || source.trim().length === 0) {
    return res.status(400).json({ error: '"source" (C++ string) is required' });
  }

  const jobId = `compile_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  createJob({
    jobId,
    phase: 'compile',
    board,
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
      logLine: `Done — ${result.binSize} bytes in ${(result.durationMs / 1000).toFixed(1)}s`,
    });

    console.log(`[COMPILE] Job ${jobId} done — ${result.binSize} bytes`);

    return res.json({
      jobId,
      status: 'done',
      binBase64: result.binBase64,
      binSize: result.binSize,
      durationMs: result.durationMs,
      log: result.log,
    });
  } catch (err) {
    updateJob(jobId, { status: 'error', error: err.message, logLine: `Error: ${err.message}` });
    console.error(`[COMPILE] Job ${jobId} failed:`, err.message);
    return res.status(500).json({ jobId, status: 'error', error: err.message });
  }
});

// Connect the store (best-effort — never blocks boot), then start listening.
await initStorage();

server.listen(PORT, () => {
  console.log(`Chip Backend running with WebSocket support on port ${PORT}`);
});

async function shutdown(signal) {
  console.log(`\n[server] ${signal} received — shutting down.`);
  server.close();
  await closeStorage();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
