# Chip — Backend

Node.js + Express server that handles firmware compilation, device flashing, job history, and MCP OAuth for the Chip dashboard.

## Project Structure

```
backend/
├── index.js                        ← Entry point (server bootstrap, ~60 lines)
│
├── middleware/
│   └── auth.js                     ← extractUser() Firebase token middleware
│
├── services/
│   ├── storage.js                  ← MongoDB + in-memory persistence
│   ├── websocket.js                ← WebSocket server + device socket registry
│   ├── user-resolver.js            ← resolveUserId() helper
│   └── platformio-runner.js        ← PlatformIO compiler engine
│
└── routes/
    ├── oauth.js                    ← OAuth 2.1 + PKCE endpoints
    ├── devices.js                  ← GET /api/devices
    ├── jobs.js                     ← GET|DELETE /api/jobs, GET /api/jobs/:id/download
    ├── compile.js                  ← POST /api/compile
    └── flash.js                    ← POST /api/flash
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health check |
| `GET` | `/api/devices` | List registered browser devices |
| `GET` | `/api/jobs` | List all jobs in history |
| `GET` | `/api/jobs/:jobId` | Get a single job status |
| `GET` | `/api/jobs/:jobId/download` | Download compiled `.bin` binary |
| `DELETE` | `/api/jobs` | Clear job history |
| `POST` | `/api/jobs/clear` | Clear job history (alias for proxies) |
| `POST` | `/api/compile` | Compile C++ Arduino firmware via PlatformIO |
| `POST` | `/api/flash` | Relay firmware binary to browser over WebSocket |
| `GET` | `/.well-known/oauth-authorization-server` | OAuth 2.1 discovery metadata |
| `POST` | `/oauth/register` | Dynamic client registration (RFC 7591) |
| `GET` | `/oauth/authorize` | Authorization endpoint |
| `POST` | `/oauth/finalize` | Finalize auth with Firebase ID token |
| `POST` | `/oauth/token` | Token exchange (PKCE) |

## Getting Started

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env

# Start dev server (with file watch)
npm run dev
```

## Environment Variables

See [`.env.example`](.env.example) for all available options. Key variables:

| Variable | Description |
|----------|-------------|
| `PORT` | Port to listen on (default: `3000`) |
| `MONGODB_URI` | MongoDB connection string (optional — falls back to in-memory) |
| `MONGODB_DB` | Database name (default: `chip`) |
| `FRONTEND_URL` | Client app URL for OAuth redirects (default: `http://localhost:5173`) |
| `SESSION_SECRET` | HMAC secret for signing JWT tokens |
