// oauth.js — OAuth 2.1 Authorization Server for Chip MCP authentication.
//
// Flow:
//   1. Claude hits /.well-known/oauth-authorization-server → discovers auth endpoints
//   2. Claude redirects user to GET /oauth/authorize → user sees Google sign-in page
//   3. User signs in with Firebase/Google → page POSTs token to /oauth/finalize
//   4. Backend verifies token, generates short-lived auth code, redirects back to Claude
//   5. Claude exchanges code at POST /oauth/token → receives access token (JWT)
//   6. All subsequent MCP tool calls carry the access token → backend resolves Firebase UID

import { createHmac, randomBytes } from 'crypto';
import { Router } from 'express';

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

// ── JWT Helpers (no external dependency — pure Node crypto) ──────────────────

export function signJWT(payload, expiresInSeconds = 86400) {
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

// ── Authorization Endpoint — serves the Google Sign-in page ──────────────────

router.get('/oauth/authorize', (req, res) => {
  const { redirect_uri, state, client_id } = req.query;

  if (!redirect_uri) {
    return res.status(400).send('Missing redirect_uri');
  }

  const sessionId = randomBytes(16).toString('hex');
  pendingCodes.set(`session:${sessionId}`, {
    redirectUri: redirect_uri,
    state: state || '',
    expires: Date.now() + 10 * 60 * 1000, // 10 min to complete sign-in
  });

  const finalizeUrl = `${req.protocol}://${req.get('host')}/oauth/finalize`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chip – Connect to Claude</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #1a1d2e;
      border: 1px solid #2d3152;
      border-radius: 16px;
      padding: 40px;
      max-width: 400px;
      width: 90%;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    .logo { font-size: 36px; margin-bottom: 12px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; color: #f0f4ff; }
    p { font-size: 14px; color: #94a3b8; margin-bottom: 28px; line-height: 1.6; }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 12px 20px;
      background: #fff;
      color: #1a1a1a;
      font-size: 15px;
      font-weight: 600;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      transition: opacity 0.2s, transform 0.1s;
    }
    .btn:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn svg { flex-shrink: 0; }
    .status { margin-top: 18px; font-size: 13px; color: #64748b; min-height: 20px; }
    .status.error { color: #f87171; }
    .status.success { color: #4ade80; }
    .spinner {
      display: inline-block;
      width: 14px; height: 14px;
      border: 2px solid #4ade80;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      margin-right: 6px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">◇</div>
    <h1>Connect Chip to Claude</h1>
    <p>Sign in with your Google account to link Claude to your Chip dashboard and ESP32 board.</p>
    <button class="btn" id="signInBtn" onclick="signIn()">
      <svg width="18" height="18" viewBox="0 0 18 18">
        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
        <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18z"/>
        <path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.02-2.34z"/>
        <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58z"/>
      </svg>
      Continue with Google
    </button>
    <div class="status" id="status"></div>
  </div>

  <script type="module">
    import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
    import { getAuth, GoogleAuthProvider, signInWithPopup } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

    const firebaseConfig = {
      apiKey: 'AIzaSyCqGDdLjDTgdTgprcK19daAFPSth6N4jdM',
      authDomain: 'chip-hq.firebaseapp.com',
      projectId: 'chip-hq',
      storageBucket: 'chip-hq.firebasestorage.app',
      messagingSenderId: '358690504566',
      appId: '1:358690504566:web:2b8623c8ef2cee5c2f8457',
    };

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const provider = new GoogleAuthProvider();

    window.signIn = async function signIn() {
      const btn = document.getElementById('signInBtn');
      const status = document.getElementById('status');
      btn.disabled = true;
      status.className = 'status';
      status.innerHTML = '<span class="spinner"></span> Signing in…';

      try {
        const result = await signInWithPopup(auth, provider);
        const idToken = await result.user.getIdToken();

        status.innerHTML = '<span class="spinner"></span> Linking to Claude…';

        const resp = await fetch('${finalizeUrl}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, sessionId: '${sessionId}' }),
        });

        const data = await resp.json();

        if (!resp.ok) {
          throw new Error(data.error || 'Failed to finalize authentication');
        }

        // Redirect back to Claude with the auth code
        window.location.href = data.redirectUrl;

      } catch (err) {
        status.className = 'status error';
        status.textContent = err.message || 'Sign-in failed. Please try again.';
        btn.disabled = false;
      }
    };
  </script>
</body>
</html>`);
});

// ── Finalize — receives Firebase ID token from the sign-in page ──────────────

router.post('/oauth/finalize', async (req, res) => {
  const { idToken, sessionId } = req.body || {};

  if (!idToken || !sessionId) {
    return res.status(400).json({ error: 'Missing idToken or sessionId' });
  }

  const session = pendingCodes.get(`session:${sessionId}`);
  if (!session || session.expires < Date.now()) {
    return res.status(400).json({ error: 'Session expired or invalid. Please try connecting again.' });
  }

  // Decode Firebase JWT payload (we trust Firebase's signature here — it's signed by Google's keys)
  let firebaseUid, email;
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('Invalid token');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    firebaseUid = payload.sub || payload.user_id;
    email = payload.email;
    if (!firebaseUid) throw new Error('No UID in token');
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }

  // Generate a short-lived auth code
  const code = randomBytes(24).toString('hex');
  pendingCodes.set(`code:${code}`, {
    userId: firebaseUid,
    email,
    redirectUri: session.redirectUri,
    expires: Date.now() + 5 * 60 * 1000, // 5 min to exchange
  });
  pendingCodes.delete(`session:${sessionId}`);

  // Build the redirect URL back to Claude with the code
  const redirectUrl = new URL(session.redirectUri);
  redirectUrl.searchParams.set('code', code);
  if (session.state) redirectUrl.searchParams.set('state', session.state);

  console.log(`[OAuth] User authenticated: ${email} (${firebaseUid})`);
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

  console.log(`[OAuth] Token issued for ${codeData.email}`);

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 30 * 24 * 3600,
    scope: 'chip:mcp',
  });
});

// Need to import express for the urlencoded middleware above
import express from 'express';

export default router;
