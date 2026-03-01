# mesh-router-agent

A lightweight Mesh Router agent that registers routes with the mesh-router-backend, enabling direct connections to PCS instances.

## Purpose

This agent is part of the Mesh Router architecture, designed to reduce latency by allowing direct connections to PCS instances. It registers multiple route types to support both the CF Worker (domain routes) and OpenResty Gateway (IP routes).

## How It Works

1. Parses the `PROVIDER` connection string
2. Detects or uses configured public IP
3. Registers multiple route types with mesh-router-backend:
   - **IP route** (priority 1): For OpenResty Gateway direct connection
   - **sslip.io route** (priority 2): For CF Worker (primary domain route)
   - **nip.io route** (priority 3): For CF Worker (fallback domain route)
4. Backend validates each route before storing (only healthy routes accepted)
5. Sends periodic refreshes to maintain route registration (TTL-based)

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

## Route Registration

The agent registers 6 routes (3 route types × 2 schemes):

| Type | Priority | Domain/IP | Scheme | Used By |
|------|----------|-----------|--------|---------|
| `ip` | 1 | `88.187.147.189` | https | OpenResty Gateway |
| `ip` | 1 | `88.187.147.189` | http | OpenResty Gateway |
| `domain` | 2 | `88-187-147-189.sslip.io` | https | CF Worker |
| `domain` | 2 | `88-187-147-189.sslip.io` | http | CF Worker |
| `domain` | 3 | `88-187-147-189.nip.io` | https | CF Worker |
| `domain` | 3 | `88-187-147-189.nip.io` | http | CF Worker |

### Route Validation

Routes are validated by the backend at registration time:
- Backend tests connectivity to each route (5 second timeout)
- For HTTPS routes, SSL certificate is verified
- Only routes that pass validation are stored
- Agent receives feedback on accepted/rejected routes

Example response:
```json
{
  "accepted": [
    {"type": "ip", "ip": "88.187.147.189", "port": 443},
    {"type": "domain", "domain": "88-187-147-189.sslip.io", "port": 443}
  ],
  "rejected": [
    {"type": "domain", "domain": "88-187-147-189.nip.io", "port": 443, "reason": "Connection timeout"}
  ]
}
```

### Why Multiple Route Types?

- **CF Workers cannot fetch IP addresses** (Cloudflare error 1003)
- **Domain routes** use wildcard DNS (sslip.io, nip.io) to resolve IPs
- **Two DNS services** provide redundancy if one is unavailable
- **sslip.io preferred** (priority 2) as it's often more reliable than nip.io

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
│           (uses domain routes: sslip.io, nip.io)            │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐
    │  Domain Routes  │             │ Gateway Fallback│
    │  (sslip.io/nip) │             │  (OpenResty)    │
    │  priority 2-3   │             │  uses IP routes │
    └─────────────────┘             └─────────────────┘
              │                               │
              │                     ┌─────────┴─────────┐
              │                     ▼                   ▼
              │           ┌─────────────┐     ┌─────────────┐
              │           │  IP Route   │     │ VPN Tunnel  │
              │           │  priority 1 │     │ priority 10 │
              │           └─────────────┘     └─────────────┘
              │                     │                   │
              └─────────────────────┼───────────────────┘
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
