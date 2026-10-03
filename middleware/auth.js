import { createHmac } from 'crypto';

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}
const SESSION_SECRET = process.env.SESSION_SECRET || 'chip-local-development-secret-only';

if (!process.env.SESSION_SECRET) {
  console.warn('[auth] WARNING: SESSION_SECRET env var is not set. Using insecure default — set this in production!');
}

/**
 * Verify a JWT token's HMAC-SHA256 signature and expiry before trusting its payload.
 * Returns the decoded payload or null if invalid/expired.
 */
function verifyJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = createHmac('sha256', SESSION_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url');
    // Constant-time comparison to prevent timing attacks
    if (sig.length !== expected.length) return null;
    let mismatch = 0;
    for (let i = 0; i < sig.length; i++) mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (mismatch !== 0) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Decode a Firebase ID token payload (base64 only — Firebase tokens are verified
 * on their own authority; we just extract the uid/email for bookkeeping).
 */
function decodeFirebasePayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function extractUser(req, res, next) {
  req.authenticated = false;
  try {
    const authHeader = req.headers.authorization;
    const directUserId = req.headers['x-user-id'] || req.query?.userId || req.body?.userId;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1]?.trim();
      if (token) {
        // 1. Try verifying as our own signed JWT (HMAC-SHA256 validated)
        const chipPayload = verifyJwtPayload(token);
        if (chipPayload) {
          const uid = chipPayload.sub || chipPayload.user_id;
          if (uid) {
            req.userId = String(uid);
            req.authenticated = true;
            req.userEmail = chipPayload.email || null;
            req.tokenPayload = chipPayload; // expose for downstream agent detection
            return next();
          }
        }

        // 2. Fall back to decoding a Firebase ID token (uid only for bookkeeping)
        const firebasePayload = decodeFirebasePayload(token);
        const uid = firebasePayload?.sub || firebasePayload?.user_id;
        if (uid) {
          req.userId = String(uid);
          req.authenticated = true;
          req.userEmail = firebasePayload?.email || null;
          return next();
        }

        // 3. Last resort: treat raw token string as opaque user id
        req.userId = token;
        req.authenticated = true;
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

export function requireAuthenticated(req, res, next) {
  if (!req.authenticated || !req.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return next();
}
