# Chip — Backend

Node.js + Express server that handles firmware compilation, device flashing, job history, and MCP OAuth for the Chip dashboard.

## Project Structure

```
backend/
├── index.js                        ← Entry point (server bootstrap & route mounting)
│
├── middleware/
│   ├── auth.js                     ← extractUser() Firebase token middleware
│   └── errorHandler.js             ← Centralized error catching & data masking
│
├── tiers/
│   ├── free-tier.js                ← Free mode algorithm & quota limits (mock)
│   ├── pro-tier.js                 ← Pro mode priority algorithm (mock)
│   ├── tier-evaluator.js           ← Tier resolution & quota evaluator
│   └── index.js                    ← Unified tiers interface
│
├── services/
│   ├── storage.js                  ← MongoDB (pooled, SSL, masked) + in-memory fallback
│   ├── websocket.js                ← WebSocket server + device socket registry
│   ├── user-resolver.js            ← resolveUserId() helper
│   └── platformio-runner.js        ← PlatformIO compiler engine (+ optional lib_deps)
│
├── libraries/                      ← Docs for shared lib cache (~/.chip-build-cache/libraries)
│
└── routes/
    ├── oauth.js                    ← OAuth 2.1 + PKCE endpoints
    ├── devices.js                  ← GET /api/devices
    ├── jobs.js                     ← GET|DELETE /api/jobs, GET /api/jobs/:id/download
    ├── compile.js                  ← POST /api/compile (optional libraries / libDeps)
    └── flash.js                    ← POST /api/flash
```

## Security & Resource Management Features

- **Connection Pooling**: Configured with `minPoolSize` (2) and `maxPoolSize` (20) limits to avoid connection exhaustion under high concurrency.
- **Idle & Socket Timeouts**: `maxIdleTimeMS` (30s), `socketTimeoutMS` (45s), and `connectTimeoutMS` (10s) to reclaim inactive database resources.
- **Connection Leak Prevention**: Drivers use auto-closing cursors and write queues with promise settlements (`.finally()`).
- **SSL/TLS Encryption**: `tls: true` enforced on MongoDB client connections for encrypted transit.
- **Parameterized Queries**: All queries structured via native driver document filters (protecting against NoSQL injection).
- **Data Masking**: MongoDB internal IDs (`_id`) and system internals are masked from API responses.
- **Centralized Error Handling**: Express middleware catches unexpected errors and returns sanitized, client-safe error messages while logging full stack traces server-side.
- **Graceful Fallbacks**: In-memory store automatically serves requests if MongoDB becomes temporarily unavailable.
- **N+1 Query Resolution**: Batch fetching with indexes on `jobId`, `userId`, `deviceId`, and `createdAt`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health check & DB status |
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

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Port to listen on | `3000` |
| `MONGODB_URI` | MongoDB connection string (optional — falls back to in-memory) | — |
| `MONGODB_DB` | Database name | `chip` |
| `MONGODB_MIN_POOL` | Minimum connection pool size | `2` |
| `MONGODB_MAX_POOL` | Maximum connection pool size | `20` |
| `MONGODB_SSL` | Enforce SSL/TLS encryption (`true`/`false`) | `true` |
| `FRONTEND_URL` | Client app URL for OAuth redirects | `http://localhost:5173` |
| `SESSION_SECRET` | HMAC secret for signing JWT tokens | `chip-dev-secret` |
