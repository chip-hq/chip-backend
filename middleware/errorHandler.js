// middleware/errorHandler.js — Centralized error catching & data masking for all routes.
//
// Security features:
//  ✓ Catches all unhandled errors from route handlers via Express next(err)
//  ✓ Data masking: raw error messages / stack traces never sent to clients
//  ✓ Structured, safe error responses (only generic messages face outward)
//  ✓ Full error detail logged server-side only
//  ✓ 404 handler for unknown routes

// Wraps an async route handler so errors are forwarded to next() automatically.
// Use this to avoid try/catch boilerplate in every route.
export function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// 404 — no route matched.
export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// Central error handler — must be registered LAST with app.use().
// Express identifies it by the 4-argument signature (err, req, res, next).
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // Log full error internally only — never forwarded to client.
  const requestId = req.headers['x-request-id'] || '-';
  console.error(`[error] ${req.method} ${req.path} [${requestId}]:`, err?.message ?? err);
  if (err?.stack) {
    console.error(err.stack);
  }

  // Data masking: determine a safe HTTP status, never expose internals.
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600
    ? err.status
    : 500;

  // Generic, safe messages sent to clients — never raw DB or system errors.
  const safeMessages = {
    400: 'Bad request',
    401: 'Authentication required',
    403: 'Access denied',
    404: 'Not found',
    429: 'Too many requests',
    500: 'An internal error occurred',
    503: 'Service temporarily unavailable',
  };

  res.status(status).json({
    error: safeMessages[status] ?? 'An internal error occurred',
    // Only expose a requestId so ops can trace it in logs without leaking stack.
    ...(requestId !== '-' ? { requestId } : {}),
  });
}
