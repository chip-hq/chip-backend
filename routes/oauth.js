import { createHmac, createHash, randomBytes } from 'crypto';
import express, { Router } from 'express';
import { asyncRoute } from '../middleware/errorHandler.js';
import { recordAgentConnection, disconnectAgent, getDb, isDbConnected } from '../services/storage.js';

const router = Router();

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}
const SESSION_SECRET = process.env.SESSION_SECRET || 'chip-local-development-secret-only';
const CANDIDATE_SECRETS = [SESSION_SECRET];

const registeredClients = new Map();
const pendingCodes = new Map();

async function saveRegisteredClient(clientRecord) {
  registeredClients.set(clientRecord.client_id, clientRecord);
  if (isDbConnected()) {
    await getDb().collection('oauth_clients').updateOne(
      { client_id: clientRecord.client_id },
      { $set: clientRecord },
      { upsert: true }
    );
  }
}

async function getRegisteredClient(clientId) {
  const cached = registeredClients.get(clientId);
  if (cached) return cached;

  if (isDbConnected()) {
    const stored = await getDb().collection('oauth_clients').findOne({ client_id: clientId });
    if (stored) {
      registeredClients.set(clientId, stored);
      return stored;
    }
  }

  return null;
}

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

  if (!valid) throw new Error('Invalid token signature');

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

  if (process.env.NODE_ENV === 'production' && !isDbConnected()) {
    return res.status(503).json({
      error: 'temporarily_unavailable',
      error_description: 'OAuth registration storage is unavailable. Please try again shortly.',
    });
  }

  const clientId = `client_${randomBytes(16).toString('hex')}`;
  const clientSecret = `secret_${randomBytes(24).toString('hex')}`;

  const clientRecord = {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: typeof client_name === 'string' ? client_name.substring(0, 100) : 'Agent',
    redirect_uris: Array.isArray(redirect_uris) ? redirect_uris.filter((u) => typeof u === 'string') : [],
    created_at: Date.now(),
  };

  await saveRegisteredClient(clientRecord);
  console.log(`[OAuth] Dynamic client registered: ${clientRecord.client_name} (${clientId})`);

  const base = `${req.protocol}://${req.get('host')}`;

  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    client_name: clientRecord.client_name,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: clientRecord.redirect_uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    registration_client_uri: `${base}/oauth/register/${clientId}`,
  });
}));

router.get('/oauth/register/:clientId', asyncRoute(async (req, res) => {
  const client = await getRegisteredClient(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'invalid_client' });

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    client_id: client.client_id,
    client_name: client.client_name,
    client_id_issued_at: Math.floor((client.created_at || Date.now()) / 1000),
    client_secret_expires_at: 0,
    redirect_uris: client.redirect_uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    registration_client_uri: `${req.protocol}://${req.get('host')}/oauth/register/${client.client_id}`,
  });
}));

router.delete('/oauth/register/:clientId', asyncRoute(async (req, res) => {
  const clientId = req.params.clientId;
  registeredClients.delete(clientId);
  if (isDbConnected()) {
    await getDb().collection('oauth_clients').deleteOne({ client_id: clientId });
  }
  return res.status(204).send();
}));

router.get('/oauth/authorize', asyncRoute(async (req, res) => {
  const {
    redirect_uri,
    state,
    client_id,
    code_challenge,
    code_challenge_method = 'S256',
  } = req.query;

  if (!client_id || typeof client_id !== 'string') {
    return res.status(400).send('Missing client_id');
  }
  const client = await getRegisteredClient(client_id);
  if (!client) {
    return res.status(400).send('Unknown client_id');
  }
  if (!redirect_uri || typeof redirect_uri !== 'string') {
    return res.status(400).send('Missing redirect_uri');
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).send('redirect_uri is not registered for this client');
  }

  try {
    const parsed = new URL(redirect_uri);
    const localHttp = parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname);
    if (parsed.protocol !== 'https:' && !localHttp) throw new Error('HTTPS redirect required');
  } catch {
    return res.status(400).send('Invalid redirect_uri format');
  }

  const sessionData = {
    clientId: typeof client_id === 'string' ? client_id : null,
    clientName: client.client_name,
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

  const session = await getOAuthSession(sessionId);
  if (!session || (session.expires && session.expires < Date.now()) || (session.exp && session.exp < Math.floor(Date.now() / 1000))) {
    return res.status(400).json({ error: 'Session expired or invalid. Please try connecting again.' });
  }
  if (redirect_uri && redirect_uri !== session.redirectUri) {
    return res.status(400).json({ error: 'redirect_uri does not match the authorization session' });
  }
  if (client_id && client_id !== session.clientId) {
    return res.status(400).json({ error: 'client_id does not match the authorization session' });
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
    clientName: session.clientName,
    redirectUri: session.redirectUri,
    codeChallenge: session.codeChallenge,
    codeChallengeMethod: session.codeChallengeMethod,
    expires: Date.now() + 5 * 60 * 1000,
  };
  const code = signJWT(codeData, 300);
  await saveOAuthCode(code, codeData);
  await deleteOAuthSession(sessionId);

  // Derive agent name — check redirect_uri / client_name signals BEFORE clientId,
  // because dynamic registration historically prefixed every client_id with "claude_".
  const agentHint = (() => {
    const uri = (session.redirectUri || '').toLowerCase();
    const cid = (session.clientId || '').toLowerCase();
    const name = (session.clientName || '').toLowerCase();
    if (uri.includes('chatgpt') || uri.includes('openai') || cid.includes('chatgpt') || cid.includes('openai') || name.includes('chatgpt') || name.includes('openai')) {
      return { name: 'ChatGPT', key: 'chatgpt' };
    }
    if (uri.includes('claude') || uri.includes('anthropic') || cid.includes('claude') || cid.includes('anthropic') || name.includes('claude') || name.includes('anthropic')) {
      return { name: 'Claude', key: 'claude' };
    }
    return { name: 'MCP Agent', key: session.clientId?.slice(0, 12) || 'mcpagent' };
  })();

  recordAgentConnection({
    userId: firebaseUid,
    clientName: agentHint.name,
    clientKey: agentHint.key,
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

  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  const base = (process.env.PUBLIC_URL || `${proto}://${host}`).replace(/\/+$/, '');
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

  // Derive agent name — prefer redirect_uri over clientId (client ids may be claude_* even for ChatGPT)
  const agentHint = (() => {
    const clientId = (codeData.clientId || '').toLowerCase();
    const clientName = (codeData.clientName || '').toLowerCase();
    const redirectUri = (codeData.redirectUri || '').toLowerCase();
    if (redirectUri.includes('chatgpt') || redirectUri.includes('openai') || clientId.includes('chatgpt') || clientId.includes('openai') || clientName.includes('chatgpt') || clientName.includes('openai')) {
      return { name: 'ChatGPT', key: 'chatgpt' };
    }
    if (redirectUri.includes('claude') || redirectUri.includes('anthropic') || clientId.includes('claude') || clientId.includes('anthropic') || clientName.includes('claude') || clientName.includes('anthropic')) {
      return { name: 'Claude', key: 'claude' };
    }
    return { name: 'MCP Agent', key: clientId.slice(0, 12) || 'mcpagent' };
  })();

  recordAgentConnection({
    userId: codeData.userId,
    clientName: agentHint.name,
    clientKey: agentHint.key,
    email: codeData.email,
  });

  console.log(`[OAuth] Access token issued for ${codeData.email} via ${agentHint.name}`);

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
  let clientKey = null;

  if (token) {
    try {
      const decoded = verifyJWT(token);
      targetUser = decoded?.userId || decoded?.sub || decoded?.uid || null;
      // Derive which agent this token was issued to from the client_id hint
      const cid = (clientId || decoded?.aud || '').toLowerCase();
      if (cid.includes('claude') || cid.includes('anthropic')) clientKey = 'claude';
      else if (cid.includes('chatgpt') || cid.includes('openai')) clientKey = 'chatgpt';
    } catch {}
  }

  // Also try to detect agent from clientId alone (no token)
  if (!clientKey && clientId) {
    const cid = String(clientId).toLowerCase();
    if (cid.includes('claude') || cid.includes('anthropic')) clientKey = 'claude';
    else if (cid.includes('chatgpt') || cid.includes('openai')) clientKey = 'chatgpt';
  }

  disconnectAgent(targetUser || null, clientKey || null);
  res.status(200).json({ status: 'ok', revoked: true });
};

router.post('/oauth/revoke', handleRevoke);
router.post('/oauth/token/revoke', handleRevoke);
router.delete('/oauth/token', handleRevoke);
router.delete('/oauth/register', handleRevoke);

export default router;
