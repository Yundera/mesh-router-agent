# mesh-router-agent

A lightweight Mesh Router agent that registers a public IP with the mesh-router-backend, enabling direct IP routing without VPN tunneling.

## Purpose

This agent is part of the Mesh Router architecture, designed to reduce latency by allowing direct connections to PCS instances via their public IP, with Caddy handling local routing.

## How It Works

1. Parses the `PROVIDER` connection string
2. Detects or uses configured public IP
3. Registers the route with mesh-router-backend via `POST /routes/:userid/:sig` (priority 1)
4. Sends periodic heartbeats via `POST /heartbeat/:userid/:sig` to update `lastSeenOnline`

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROVIDER` | Yes | - | Connection string `<backend_url>,<userid>,<signature>` |
| `PUBLIC_IP` | No | auto-detect | Public IP to register (leave empty to auto-detect) |
| `TARGET_PORT` | No | 443 | Port where Caddy listens for incoming traffic |
| `ROUTE_PRIORITY` | No | 1 | Route priority (lower = higher priority) |
| `REFRESH_INTERVAL` | No | 300 | Route refresh interval in seconds (5 minutes) |
| `HEALTH_CHECK_PATH` | No | - | Optional health check HTTP path (e.g., `/.well-known/health`) |
| `HEALTH_CHECK_HOST` | No | - | Optional health check Host header override |
| `CERT_KEY_PATH` | No | `./data/key.pem` | Path to store the agent's private key |
| `CERT_PATH` | No | `./data/cert.pem` | Path to store the agent's certificate |
| `CA_CERT_PATH` | No | `./data/ca-cert.pem` | Path to store the CA certificate |

> **Note**: `HEARTBEAT_INTERVAL` is deprecated. Use `REFRESH_INTERVAL` instead.

### Example Configuration

```env
# Provider connection string: <backend_url>,<userid>,<signature>
PROVIDER=https://api.nsl.sh,<userid>,<signature>

# Public IP to register (leave empty to auto-detect)
PUBLIC_IP=

# Route refresh interval in seconds (default: 300 = 5 minutes)
REFRESH_INTERVAL=300

# Target port where Caddy listens (default: 443)
TARGET_PORT=443

# Route priority (default: 1 for direct connection)
ROUTE_PRIORITY=1

# Optional health check configuration
HEALTH_CHECK_PATH=/.well-known/health
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
