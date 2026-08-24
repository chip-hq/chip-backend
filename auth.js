// auth.js — Safe Firebase Token parsing & user extraction middleware for Chip backend.

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

/**
 * Express middleware to extract userId (Firebase UID) from incoming requests.
 * Checks Bearer JWT token payload (`sub` / `user_id`), fallback headers (`x-user-id`), or query/body.
 */
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
        // Fallback if not a JWT string
        req.userId = token;
        return next();
      }
    }

    if (directUserId) {
      req.userId = String(directUserId);
    }
  } catch (err) {
    console.warn('[auth] Non-fatal error parsing user token:', err?.message);
  }

  next();
}
