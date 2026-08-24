export function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found' });
}

export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const requestId = req.headers['x-request-id'] || '-';
  console.error(`[error] ${req.method} ${req.path} [${requestId}]:`, err?.message ?? err);
  if (err?.stack) {
    console.error(err.stack);
  }

  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600
    ? err.status
    : 500;

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
    ...(requestId !== '-' ? { requestId } : {}),
  });
}
