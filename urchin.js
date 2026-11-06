// Urchin monitoring ("Chip backend"): heartbeat + error reporting.
// Fire-and-forget, 5s timeout, never throws. Key comes from URCHIN_KEY (never logged).
const URCHIN_URL = 'https://backend.josephakpansunday.workers.dev';
const HEARTBEAT_MS = 60_000;
const TIMEOUT_MS = 5_000;

const send = async (path, body = {}) => {
  const key = process.env.URCHIN_KEY;
  if (!key) return;
  try {
    await fetch(URCHIN_URL + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-urchin-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Monitoring must never break the app.
  }
};

export function reportError(err, route) {
  const body = {
    message: String(err?.message ?? err).slice(0, 2000),
  };
  if (err?.stack) body.stack = String(err.stack).slice(0, 10000);
  if (route) body.route = String(route).slice(0, 500);
  return send('/ingest/error', body);
}

// Express error middleware: register BEFORE the app's final error handler.
export function urchinErrorHandler(err, req, res, next) {
  const status = err?.status ?? err?.statusCode;
  const isClientError = typeof status === 'number' && status >= 400 && status < 500;
  if (!isClientError) {
    reportError(err, `${req.method} ${(req.originalUrl || req.url || '').split('?')[0]}`);
  }
  next(err);
}

// Heartbeat at startup, then every 60s.
export function startHeartbeat() {
  send('/ingest/heartbeat');
  setInterval(() => send('/ingest/heartbeat'), HEARTBEAT_MS).unref();
}
