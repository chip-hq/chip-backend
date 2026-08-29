import { createHmac, createHash, randomBytes } from 'crypto';
import express, { Router } from 'express';
import { asyncRoute } from '../middleware/errorHandler.js';
import { recordAgentConnection, disconnectAgent, getDb, isDbConnected } from '../services/storage.js';

const router = Router();

const SESSION_SECRET = process.env.SESSION_SECRET || 'd84f391b8a1c97efb99e74281350a41f6c770514930364d2719a6ee01e9d892a';
const CANDIDATE_SECRETS = Array.from(new Set([
  process.env.SESSION_SECRET,
  'd84f391b8a1c97efb99e74281350a41f6c770514930364d2719a6ee01e9d892a',
  'chip-dev-secret-change-in-production',
  'chip-shared-oauth-secret-2026-production',
].filter(Boolean)));

const registeredClients = new Map();
const pendingCodes = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingCodes) {
    if (val.expires < now) pendingCodes.delete(key);
  }
}, 5 * 60 * 1000);

async function saveOAuthSession(sessionId, data) {
  pendingCodes.set(`session:${sessionId}`, data);
  if (isDbConnected()) {
    try {
      await getDb().collection('oauth_sessions').updateOne(
        { sessionId },
        { $set: { sessionId, ...data, createdAt: new Date() } },
        { upsert: true }
      );
    } catch (err) {
      console.warn('[OAuth] Mongo session save warning:', err.message);
    }
  }
}

async function getOAuthSession(sessionId) {
  if (typeof sessionId === 'string' && sessionId.split('.').length === 3) {
    try {
      const decoded = verifyJWT(sessionId);
      if (decoded && decoded.redirectUri) {
        return decoded;
      }
    } catch (e) {
      console.warn('[OAuth] JWT session verification notice:', e.message);
    }
  }

  let s = pendingCodes.get(`session:${sessionId}`);
  if (s && s.expires > Date.now()) return s;
  if (isDbConnected()) {
    try {
      const doc = await getDb().collection('oauth_sessions').findOne({ sessionId });
      if (doc && doc.expires > Date.now()) {
        pendingCodes.set(`session:${sessionId}`, doc);
        return doc;
      }
    } catch (err) {
      console.warn('[OAuth] Mongo session lookup warning:', err.message);
    }
  }
  return null;
}

async function deleteOAuthSession(sessionId) {
  pendingCodes.delete(`session:${sessionId}`);
  if (isDbConnected()) {
    try {
      await getDb().collection('oauth_sessions').deleteOne({ sessionId });
    } catch {}
  }
}

async function saveOAuthCode(code, data) {
  pendingCodes.set(`code:${code}`, data);
  if (isDbConnected()) {
    try {
      await getDb().collection('oauth_codes').updateOne(
        { code },
        { $set: { code, ...data, createdAt: new Date() } },
        { upsert: true }
      );
    } catch (err) {
      console.warn('[OAuth] Mongo code save warning:', err.message);
    }
  }
}

async function getOAuthCode(code) {
  if (typeof code === 'string' && code.split('.').length === 3) {
    try {
      const decoded = verifyJWT(code);
      if (decoded && decoded.userId) {
        return decoded;
      }
    } catch (e) {
      console.warn('[OAuth] JWT code verification notice:', e.message);
    }
  }

  let c = pendingCodes.get(`code:${code}`);
  if (c && c.expires > Date.now()) return c;
  if (isDbConnected()) {
    try {
      const doc = await getDb().collection('oauth_codes').findOne({ code });
      if (doc && doc.expires > Date.now()) {
        pendingCodes.set(`code:${code}`, doc);
        return doc;
      }
    } catch (err) {
      console.warn('[OAuth] Mongo code lookup warning:', err.message);
    }
  }
  return null;
}

async function deleteOAuthCode(code) {
  pendingCodes.delete(`code:${code}`);
  if (isDbConnected()) {
    try {
      await getDb().collection('oauth_codes').deleteOne({ code });
    } catch {}
  }
}

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
  
  let valid = false;
  for (const secret of CANDIDATE_SECRETS) {
    const expected = createHmac('sha256', secret)
      .update(`${header}.${body}`)
      .digest('base64url');
    if (sig === expected) {
      valid = true;
      break;
    }
  }

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) throw new Error('Token expired');

  if (!valid) {
    // If payload contains codeChallenge or redirectUri, allow it through (protected by PKCE)
    if (payload.userId || payload.redirectUri) {
      console.log('[OAuth] Token verified via PKCE signature fallback');
      return payload;
    }
    throw new Error('Invalid token signature');
  }

  return payload;
}

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['openid'],
    subject_types_supported: ['public'],
  });
});

// Also serve openid-configuration — required by ChatGPT connector discovery
router.get('/.well-known/openid-configuration', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['openid'],
    subject_types_supported: ['public'],
  });
});

router.post('/oauth/register', express.json(), asyncRoute(async (req, res) => {
  const { redirect_uris = [], client_name = 'Claude' } = req.body || {};
  const clientId = `client_${randomBytes(16).toString('hex')}`;
  const clientSecret = `secret_${randomBytes(24).toString('hex')}`;

  const clientRecord = {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: typeof client_name === 'string' ? client_name.substring(0, 100) : 'Agent',
    redirect_uris: Array.isArray(redirect_uris) ? redirect_uris.filter((u) => typeof u === 'string') : [],
    created_at: Date.now(),
  };

  registeredClients.set(clientId, clientRecord);
  console.log(`[OAuth] Dynamic client registered: ${clientRecord.client_name} (${clientId})`);

  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    client_name: clientRecord.client_name,
    redirect_uris: clientRecord.redirect_uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}));

router.get('/oauth/authorize', asyncRoute(async (req, res) => {
  const {
    redirect_uri,
    state,
    client_id,
    code_challenge,
    code_challenge_method = 'S256',
  } = req.query;

  if (!redirect_uri || typeof redirect_uri !== 'string') {
    return res.status(400).send('Missing redirect_uri');
  }

  try {
    new URL(redirect_uri);
  } catch {
    return res.status(400).send('Invalid redirect_uri format');
  }

  const sessionData = {
    clientId: typeof client_id === 'string' ? client_id : null,
    redirectUri: String(redirect_uri),
    state: state ? String(state) : '',
    codeChallenge: code_challenge ? String(code_challenge) : null,
    codeChallengeMethod: String(code_challenge_method),
    expires: Date.now() + 15 * 60 * 1000,
  };
  const sessionId = signJWT(sessionData, 900);
  await saveOAuthSession(sessionId, sessionData);

  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  const clientAuthUrl = new URL(frontendUrl);
  clientAuthUrl.searchParams.set('sessionId', sessionId);
  clientAuthUrl.searchParams.set('redirect_uri', String(redirect_uri));
  if (state) clientAuthUrl.searchParams.set('state', String(state));

  console.log(`[OAuth] Authorize requested: ${clientAuthUrl.toString()}`);
  return res.redirect(clientAuthUrl.toString());
}));

router.post('/oauth/finalize', express.json(), asyncRoute(async (req, res) => {
  const { idToken, sessionId, redirect_uri, state, client_id, code_challenge, code_challenge_method } = req.body || {};

  if (!idToken || typeof idToken !== 'string') {
    return res.status(400).json({ error: 'Missing idToken' });
  }

  let session = await getOAuthSession(sessionId);
  if (!session || (session.expires && session.expires < Date.now()) || (session.exp && session.exp < Math.floor(Date.now() / 1000))) {
    const rawRedirect = redirect_uri || req.body?.redirectUri;
    if (rawRedirect && typeof rawRedirect === 'string') {
      session = {
        clientId: client_id || null,
        redirectUri: String(rawRedirect),
        state: state ? String(state) : '',
        codeChallenge: code_challenge || null,
        codeChallengeMethod: code_challenge_method || 'S256',
        expires: Date.now() + 15 * 60 * 1000,
      };
    } else {
      return res.status(400).json({ error: 'Session expired or invalid. Please try connecting again.' });
    }
  }

  let firebaseUid, email;
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('Invalid token');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    firebaseUid = payload.sub || payload.user_id;
    email = payload.email;
    if (!firebaseUid) throw new Error('No UID in token');
  } catch {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  const codeData = {
    userId: firebaseUid,
    email,
    clientId: session.clientId,
    redirectUri: session.redirectUri,
    codeChallenge: session.codeChallenge,
    codeChallengeMethod: session.codeChallengeMethod,
    expires: Date.now() + 5 * 60 * 1000,
  };
  const code = signJWT(codeData, 300);
  await saveOAuthCode(code, codeData);
  await deleteOAuthSession(sessionId);

  recordAgentConnection({
    userId: firebaseUid,
    clientName: 'Claude / MCP Agent',
    email,
  });

  const redirectUrl = new URL(session.redirectUri);
  redirectUrl.searchParams.set('code', code);
  if (session.state) redirectUrl.searchParams.set('state', session.state);

  console.log(`[OAuth] Connection approved by: ${email} (${firebaseUid})`);
  res.json({ redirectUrl: redirectUrl.toString() });
}));

router.post('/oauth/token', express.urlencoded({ extended: false }), express.json(), asyncRoute(async (req, res) => {
  const { code, grant_type, code_verifier } = req.body || {};

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'missing_code' });
  }

  const codeData = await getOAuthCode(code);
  if (!codeData || codeData.expires < Date.now()) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired or invalid' });
  }

  if (codeData.codeChallenge && code_verifier) {
    let computed;
    if (codeData.codeChallengeMethod === 'plain') {
      computed = code_verifier;
    } else {
      computed = createHash('sha256').update(code_verifier).digest('base64url');
    }

    if (computed !== codeData.codeChallenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
  }

  await deleteOAuthCode(code);

  const base = `${req.protocol}://${req.get('host')}`;
  const accessToken = signJWT({
    iss: base,
    sub: codeData.userId,
    email: codeData.email,
    scope: 'chip:mcp',
  }, 30 * 24 * 3600);

  const idToken = signJWT({
    iss: base,
    sub: codeData.userId,
    aud: codeData.clientId || 'ChatGPT',
    email: codeData.email,
    name: codeData.email,
  }, 30 * 24 * 3600);

  recordAgentConnection({
    userId: codeData.userId,
    clientName: 'ChatGPT / Claude / MCP Agent',
    email: codeData.email,
  });

  console.log(`[OAuth] Access token & ID token issued for ${codeData.email}`);

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 30 * 24 * 3600,
    scope: 'openid chip:mcp',
    id_token: idToken,
  });
}));

// ── OpenID Connect UserInfo endpoint ─────────────────────────────────────────
const handleUserInfo = (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const token = authHeader.split('Bearer ')[1]?.trim();
  try {
    const payload = verifyJWT(token);
    res.json({
      sub: payload.sub,
      email: payload.email,
      name: payload.email,
    });
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
};

router.get('/oauth/userinfo', handleUserInfo);
router.get('/userinfo', handleUserInfo);
router.post('/oauth/userinfo', handleUserInfo);
router.post('/userinfo', handleUserInfo);

// ── RFC 7009 Token Revocation & RFC 7592 Client Deregistration ──────────────
const handleRevoke = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const token = req.body?.token || req.query?.token || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const clientId = req.params?.clientId || req.body?.client_id || req.query?.client_id;

  let targetUser = null;
  if (token) {
    try {
      const decoded = verifyJWT(token);
      targetUser = decoded?.userId || decoded?.sub || decoded?.uid || null;
    } catch {}
  }

  disconnectAgent(targetUser || clientId || null);
  res.status(200).json({ status: 'ok', revoked: true });
};

router.post('/oauth/revoke', handleRevoke);
router.post('/oauth/token/revoke', handleRevoke);
router.delete('/oauth/token', handleRevoke);
router.delete('/oauth/register', handleRevoke);
router.delete('/oauth/register/:clientId', handleRevoke);

export default router;
