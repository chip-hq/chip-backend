function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

export function extractUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const directUserId = req.headers['x-user-id'] || req.query?.userId || req.body?.userId;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1]?.trim();
      if (token) {
        const payload = decodeJwtPayload(token);
        const uid = payload?.sub || payload?.user_id;
        if (uid) {
          req.userId = String(uid);
          return next();
        }
        req.userId = token;
        return next();
      }
    }

    if (directUserId) {
      req.userId = String(directUserId);
    }
  } catch (err) {
    console.warn('[auth] Token parsing error:', err?.message);
  }

  next();
}
