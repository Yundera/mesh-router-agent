# mesh-router-agent

A lightweight NSL agent that registers a public IP with the mesh-router-backend, enabling direct IP routing without VPN tunneling.

## Purpose

This agent is part of Phase 1 of the NSL architecture improvement to reduce latency by allowing direct connections to PCS instances via their public IP, with Caddy handling local routing.

## How It Works

1. Parses the `PROVIDER` connection string
2. Detects or uses configured public IP
3. Registers the IP with mesh-router-backend via `POST /ip/:userid/:sig`
4. Sends periodic heartbeats via `POST /heartbeat/:userid/:sig` to update `lastSeenOnline`

## Configuration

```env
# Provider connection string: <backend_url>,<userid>,<signature>
PROVIDER=https://api.nsl.sh,<userid>,<signature>

# Public IP to register (leave empty to auto-detect)
PUBLIC_IP=

# Heartbeat interval in seconds (default: 1800 = 30 minutes)
HEARTBEAT_INTERVAL=1800
```

### Connection String Format

The `PROVIDER` string uses the same format as mesh-router:

```
<backend_url>,<userid>,<signature>
```

- **backend_url**: mesh-router-backend API URL (e.g., `https://api.nsl.sh`)
- **userid**: Firebase UID
- **signature**: Pre-computed Ed25519 signature of the userid (base36 encoded)

## Development

### Local Development

```bash
# Install dependencies
pnpm install

# Development with hot reload
pnpm start

# Build
pnpm build

# Run built application
pnpm exec

# Run tests
pnpm test
```

### Docker Development Environment

The `dev/` folder contains a complete Docker-based development environment:

```bash
# Linux/Mac
cd dev && ./start.sh

# Windows (PowerShell)
cd dev; .\start.ps1
```

See `dev/README.md` for more details.

## Docker

```bash
# Build image
docker build -t mesh-router-agent .

# Run
docker run -e PROVIDER="https://api.nsl.sh,userid,signature" mesh-router-agent
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Internet                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                        │
│         (decides: direct IP or tunnel based on RTT)         │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐
    │   Direct IP     │             │   VPN Tunnel    │
    │   (port 14443)  │             │  (mesh-router)  │
    └─────────────────┘             └─────────────────┘
              │                               │
              └───────────────┬───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         Caddy                               │
│              (local routing to containers)                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    App Containers                           │
└─────────────────────────────────────────────────────────────┘
```

## Related Components

- **mesh-router-backend**: API for domain/IP registration
- **mesh-router**: VPN tunnel-based routing (alternative path)
- **Caddy**: Local reverse proxy for container routing
