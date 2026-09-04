/**
 * Chip — Backend Server
 * Copyright (c) 2024–2026 Chip. All Rights Reserved.
 *
 * This software is proprietary and confidential. Unauthorized copying,
 * distribution, or use of this file, via any medium, is strictly prohibited.
 * See LICENSE for full terms.
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
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
import preferencesRouter from './routes/preferences.js';
import circuitRouter from './routes/circuit.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Railway / reverse proxies set X-Forwarded-For — required for express-rate-limit
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Lock CORS to the configured frontend origin in production
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
const ALLOWED_ORIGINS = new Set([
  FRONTEND_URL,
  'https://chip-mocha.vercel.app',
]);

// OAuth discovery & token endpoints must be open to all origins
// so ChatGPT, Claude, and other agents can reach them
const openCorsMiddleware = cors({ origin: '*', credentials: false });

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, MCP tool calls, curl)
    if (!origin) return callback(null, true);
    const cleanOrigin = origin.replace(/\/+$/, '');
    if (ALLOWED_ORIGINS.has(cleanOrigin) || cleanOrigin.endsWith('.vercel.app')) return callback(null, true);
    // Also allow localhost variants during local development
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting — prevent abuse of expensive CPU-bound endpoints
const compileLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 minute window
  max: 10,                       // max 10 compile requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many compile requests — please wait before trying again.' },
});

const flashLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many flash requests — please wait before trying again.' },
});

const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});

// Apply open CORS to OAuth & discovery endpoints specifically
app.use('/.well-known', openCorsMiddleware);
app.use('/oauth', openCorsMiddleware);
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
app.use('/api/compile', compileLimiter);
app.use(compileRouter);
app.use('/api/flash', flashLimiter);
app.use(flashRouter);
app.use('/api/preferences', generalApiLimiter);
app.use(preferencesRouter);
app.use(circuitRouter);

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

// Catch unhandled errors so crashes are visible instead of silent
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  process.exit(1);
});

