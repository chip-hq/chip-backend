// oauth.js — OAuth 2.1 Authorization Server for Chip MCP authentication.
//
// Flow:
//   1. Claude hits /.well-known/oauth-authorization-server → discovers auth endpoints
//   2. Claude redirects user to GET /oauth/authorize
//   3. Backend creates session and redirects to Client App (http://localhost:5173/?sessionId=...)
//   4. Client App verifies Backend + MCP live sync and shows "Approve & Connect"
//   5. Client POSTs Firebase token to /oauth/finalize
//   6. Backend verifies token, generates short-lived auth code, returns redirectUrl (back to Claude)
//   7. Claude exchanges code at POST /oauth/token → receives 30-day JWT access token

import { createHmac, randomBytes } from 'crypto';
import express, { Router } from 'express';

const router = Router();

const SESSION_SECRET = process.env.SESSION_SECRET || 'chip-dev-secret-change-in-production';

// Short-lived authorization codes (code → {userId, email, redirectUri, expires})
const pendingCodes = new Map();

// Cleanup expired codes every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingCodes) {
    if (val.expires < now) pendingCodes.delete(key);
  }
}, 5 * 60 * 1000);

// ── JWT Helpers ──────────────────────────────────────────────────────────────

export function signJWT(payload, expiresInSeconds = 86400 * 30) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  })).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJWT(token) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');
  const [header, body, sig] = parts;
  const expected = createHmac('sha256', SESSION_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  if (sig !== expected) throw new Error('Invalid token signature');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) throw new Error('Token expired');
  return payload;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    scopes_supported: ['openid'],
  });
});

// ── Authorization Endpoint — redirects to the Client App for Approval ────────

router.get('/oauth/authorize', (req, res) => {
  const { redirect_uri, state } = req.query;

  if (!redirect_uri) {
    return res.status(400).send('Missing redirect_uri');
  }

  const sessionId = randomBytes(16).toString('hex');
  pendingCodes.set(`session:${sessionId}`, {
    redirectUri: redirect_uri,
    state: state || '',
    expires: Date.now() + 10 * 60 * 1000,
  });

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const clientAuthUrl = new URL(frontendUrl);
  clientAuthUrl.searchParams.set('sessionId', sessionId);
  clientAuthUrl.searchParams.set('redirect_uri', redirect_uri);
  if (state) clientAuthUrl.searchParams.set('state', state);

  return res.redirect(clientAuthUrl.toString());
});

// ── Finalize — receives Firebase ID token from the Client App Approval Box ───

router.post('/oauth/finalize', async (req, res) => {
  const { idToken, sessionId } = req.body || {};

  if (!idToken || !sessionId) {
    return res.status(400).json({ error: 'Missing idToken or sessionId' });
  }

  const session = pendingCodes.get(`session:${sessionId}`);
  if (!session || session.expires < Date.now()) {
    return res.status(400).json({ error: 'Session expired or invalid. Please try connecting again.' });
  }

  // Decode Firebase JWT payload
  let firebaseUid, email;
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('Invalid token');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    firebaseUid = payload.sub || payload.user_id;
    email = payload.email;
    if (!firebaseUid) throw new Error('No UID in token');
  } catch {
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }

  // Generate a short-lived auth code
  const code = randomBytes(24).toString('hex');
  pendingCodes.set(`code:${code}`, {
    userId: firebaseUid,
    email,
    redirectUri: session.redirectUri,
    expires: Date.now() + 5 * 60 * 1000,
  });
  pendingCodes.delete(`session:${sessionId}`);

  // Build the redirect URL back to Claude with the code
  const redirectUrl = new URL(session.redirectUri);
  redirectUrl.searchParams.set('code', code);
  if (session.state) redirectUrl.searchParams.set('state', session.state);

  console.log(`[OAuth] Connection approved on client by: ${email} (${firebaseUid})`);
  res.json({ redirectUrl: redirectUrl.toString() });
});

// ── Token Endpoint — Claude exchanges code for access token ──────────────────

router.post('/oauth/token', express.urlencoded({ extended: false }), (req, res) => {
  const { code, grant_type } = req.body || {};

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  if (!code) {
    return res.status(400).json({ error: 'missing_code' });
  }

  const codeData = pendingCodes.get(`code:${code}`);
  if (!codeData || codeData.expires < Date.now()) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired or invalid' });
  }

  pendingCodes.delete(`code:${code}`);

  const accessToken = signJWT({
    sub: codeData.userId,
    email: codeData.email,
    scope: 'chip:mcp',
  }, 30 * 24 * 3600); // 30 days

  console.log(`[OAuth] Access token issued for ${codeData.email}`);

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 30 * 24 * 3600,
    scope: 'chip:mcp',
  });
});

export default router;
