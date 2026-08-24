import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { initStorage, closeStorage, isDbConnected } from './services/storage.js';
import { extractUser } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
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

app.use(oauthRouter);

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
      // Fall through to extractUser
    }
  }
  extractUser(req, res, next);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Chip Backend',
    connectedDevicesCount: deviceSockets.size,
    dbConnected: isDbConnected(),
  });
});

app.use(devicesRouter);
app.use(jobsRouter);
app.use(compileRouter);
app.use(flashRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const server = createServer(app);
setupWebSocket(server);

await initStorage();

server.listen(PORT, () => {
  console.log(`Chip Backend running on port ${PORT}`);
});

async function shutdown(signal) {
  console.log(`\n[server] ${signal} received — shutting down.`);
  server.close();
  await closeStorage();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
