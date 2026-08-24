// oauth.js — Complete OAuth 2.1 Server with Dynamic Client Registration (RFC 7591) and PKCE for Claude.

import { createHmac, createHash, randomBytes } from 'crypto';
import express, { Router } from 'express';

const router = Router();

const SESSION_SECRET = process.env.SESSION_SECRET || 'chip-dev-secret-change-in-production';

// Registered OAuth clients (RFC 7591 Dynamic Client Registration)
const registeredClients = new Map();

// Short-lived authorization codes (code → {userId, email, redirectUri, codeChallenge, codeChallengeMethod, expires})
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

// ── Discovery (RFC 8414) ──────────────────────────────────────────────────────

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['openid'],
  });
});

// ── Dynamic Client Registration (RFC 7591) ───────────────────────────────────
// Claude calls this automatically to register itself and obtain a client_id.

router.post('/oauth/register', express.json(), (req, res) => {
  const { redirect_uris = [], client_name = 'Claude' } = req.body || {};
  const clientId = `client_${randomBytes(16).toString('hex')}`;
  const clientSecret = `secret_${randomBytes(24).toString('hex')}`;

  const clientRecord = {
    client_id: clientId,
    client_secret: clientSecret,
    client_name,
    redirect_uris,
    created_at: Date.now(),
  };

  registeredClients.set(clientId, clientRecord);
  console.log(`[OAuth] Dynamic client registered: ${client_name} (${clientId})`);

  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    client_name,
    redirect_uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
});

// ── Authorization Endpoint — redirects to Client App for Approval ────────────

router.get('/oauth/authorize', (req, res) => {
  const {
    redirect_uri,
    state,
    client_id,
    code_challenge,
    code_challenge_method = 'S256',
  } = req.query;

  if (!redirect_uri) {
    return res.status(400).send('Missing redirect_uri');
  }

  const sessionId = randomBytes(16).toString('hex');
  pendingCodes.set(`session:${sessionId}`, {
    clientId: client_id || null,
    redirectUri: String(redirect_uri),
    state: state ? String(state) : '',
    codeChallenge: code_challenge ? String(code_challenge) : null,
    codeChallengeMethod: String(code_challenge_method),
    expires: Date.now() + 10 * 60 * 1000,
  });

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const clientAuthUrl = new URL(frontendUrl);
  clientAuthUrl.searchParams.set('sessionId', sessionId);
  clientAuthUrl.searchParams.set('redirect_uri', String(redirect_uri));
  if (state) clientAuthUrl.searchParams.set('state', String(state));

  console.log(`[OAuth] Authorize requested. Redirecting to frontend: ${clientAuthUrl.toString()}`);
  return res.redirect(clientAuthUrl.toString());
});

// ── Finalize — receives Firebase ID token from the Client App Approval Box ───

router.post('/oauth/finalize', express.json(), async (req, res) => {
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
    codeChallenge: session.codeChallenge,
    codeChallengeMethod: session.codeChallengeMethod,
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

router.post('/oauth/token', express.urlencoded({ extended: false }), express.json(), (req, res) => {
  const { code, grant_type, code_verifier } = req.body || {};

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

  // PKCE verification
  if (codeData.codeChallenge && code_verifier) {
    let computed;
    if (codeData.codeChallengeMethod === 'plain') {
      computed = code_verifier;
    } else {
      computed = createHash('sha256').update(code_verifier).digest('base64url');
    }

    if (computed !== codeData.codeChallenge) {
      console.warn('[OAuth] PKCE verification failed');
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
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
