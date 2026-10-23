# mesh-router-agent

A lightweight Mesh Router agent that registers routes with the mesh-router-backend, enabling direct connections to PCS instances.

## Purpose

This agent is part of the Mesh Router architecture, designed to reduce latency by allowing direct connections to PCS instances. It registers domain routes: the CF Worker and the OpenResty gateway both use their `ip` field, and the gateway uses `domain` as the TLS server name.

## How It Works

1. Parses the `PROVIDER` connection string
2. Detects or uses configured public IP
3. Registers one domain route per scheme (https, http) with mesh-router-backend:
   `<ip-dashed>.<IP_ZONE>` when `IP_ZONE` is set (our own nameserver, e.g. `ip.nsl.sh`),
   otherwise `<ip-dashed>.nip.io`
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
| `ERROR_RETRY_INTERVAL` | No | 600 | Retry interval in seconds after a failed initialization |
| `TARGET_HOST` | No | `mesh-router-caddy` | Host serving `TARGET_PORT_HTTPS`, reached over the shared docker network |
| `READINESS_TIMEOUT` | No | 120 | Seconds to wait for `TARGET_HOST` to serve our certificate before registering routes. `0` disables the wait. Timing out is not fatal — the agent registers anyway |
| `READINESS_INTERVAL` | No | 2 | Seconds between readiness probes |
| `IP_ZONE` | No | - | Zone served by a mesh-router-nameserver (`ip.nsl.sh`). Set: routes are `<ip-dashed>.<IP_ZONE>` and replace nip.io. Empty: nip.io routes |

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

The agent registers 2 routes, one per scheme, at `ROUTE_PRIORITY`:

| Type | Priority | Domain | Scheme | Used By |
|------|----------|--------|--------|---------|
| `domain` | 1 | `88-187-147-189.ip.nsl.sh` | https | CF Worker, OpenResty Gateway |
| `domain` | 1 | `88-187-147-189.ip.nsl.sh` | http | CF Worker, OpenResty Gateway |

Without `IP_ZONE` the domain is `88-187-147-189.nip.io`. The box's sslip.io names
(Let's Encrypt) are not registered as routes: the CF Worker builds them from the
route's `ip` when the ip.<zone> path fails.

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
    {"type": "domain", "domain": "88-187-147-189.ip.nsl.sh", "port": 443}
  ],
  "rejected": [
    {"type": "domain", "domain": "88-187-147-189.ip.nsl.sh", "port": 80, "reason": "Connection timeout"}
  ]
}
```

### Why Domain Routes?

- **CF Workers cannot fetch IP addresses** (Cloudflare error 1003)
- **Domain routes** use wildcard DNS (our ip.<zone>, or nip.io) to resolve IPs
- **Validation needs the name to resolve**: with `IP_ZONE`, route registration depends on our nameserver

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
│     (uses domain routes: ip.<zone>, fallback sslip.io)      │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐
    │  Domain Routes  │             │ Gateway Fallback│
    │  (ip.<zone>)    │             │  (OpenResty)    │
    │  priority 1     │             │ connects by ip  │
    └─────────────────┘             └─────────────────┘
              │                               │
              │                     ┌─────────┴─────────┐
              │                     ▼                   ▼
              │           ┌─────────────┐     ┌─────────────┐
              │           │ Agent Route │     │ VPN Tunnel  │
              │           │  priority 1 │     │ priority 2  │
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
