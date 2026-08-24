// index.js — Main application entry point for Chip backend.

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { initStorage, closeStorage, isDbConnected } from './services/storage.js';
import { extractUser } from './middleware/auth.js';
import oauthRouter, { verifyJWT } from './routes/oauth.js';
import { setupWebSocket, deviceSockets } from './services/websocket.js';

import devicesRouter from './routes/devices.js';
import jobsRouter from './routes/jobs.js';
import compileRouter from './routes/compile.js';
import flashRouter from './routes/flash.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 1. OAuth 2.1 routes (/.well-known, /oauth/authorize, /oauth/token, /oauth/finalize)
app.use(oauthRouter);

// 2. User authentication middleware
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1]?.trim();
    try {
      const payload = verifyJWT(token);
      req.userId = payload.sub;
      req.userEmail = payload.email;
      return next();
    } catch {
      // Not a Chip JWT — fall through to extractUser
    }
  }
  extractUser(req, res, next);
});

// 3. Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Chip Backend',
    connectedDevicesCount: deviceSockets.size,
    dbConnected: isDbConnected(),
  });
});

// 4. API Route Modules
app.use(devicesRouter);
app.use(jobsRouter);
app.use(compileRouter);
app.use(flashRouter);

// 5. Create Server & Initialize WebSockets
const server = createServer(app);
setupWebSocket(server);

// 6. Connect Database (best-effort) & Start Listening
await initStorage();

server.listen(PORT, () => {
  console.log(`Chip Backend running with WebSocket support on port ${PORT}`);
});

// 7. Graceful Shutdown
async function shutdown(signal) {
  console.log(`\n[server] ${signal} received — shutting down.`);
  server.close();
  await closeStorage();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
