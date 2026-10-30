# mesh-router-agent

A lightweight Mesh Router agent that registers routes with the mesh-router-backend, enabling direct connections to PCS instances.

## Purpose

This agent is part of the Mesh Router architecture, designed to reduce latency by allowing direct connections to PCS instances. It registers domain routes: the CF Worker and the OpenResty gateway both use their `ip` field, and the gateway uses `domain` as the TLS server name.

## How It Works

1. Parses the `PROVIDER` connection string
2. Detects or uses configured public IP
3. Registers one domain route per scheme (https, http) with mesh-router-backend:
   `<ip-dashed>.<IP_ZONE>`, the provider's nameserver zone (e.g. `ip.nsl.sh`): `IP_ZONE`
   when set, else the `ipZone` the backend publishes in `/router/api/version`. With
   neither the deployment is misconfigured: the agent logs an error and registers no
   route, leaving the box on its tunnel
4. Backend validates each route before storing (only healthy routes accepted)
5. Sends periodic refreshes to maintain route registration (TTL-based)

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROVIDER` | Yes | - | Connection string `<backend_url>,<userid>,<signature>` |
| `PUBLIC_IP` | No | auto-detect | Public IP to register (leave empty to auto-detect) |
| `TARGET_PORT_HTTPS` | No | 443 | Port where Caddy serves HTTPS (`TARGET_PORT` is its deprecated alias) |
| `TARGET_PORT_HTTP` | No | 80 | Port where Caddy serves HTTP |
| `ROUTE_PRIORITY` | No | 1 | Route priority (lower = higher priority) |
| `REFRESH_INTERVAL` | No | 300 | Route refresh interval in seconds (5 minutes) |
| `CERT_KEY_PATH` | No | `./data/key.pem` | Path to store the agent's private key |
| `CERT_PATH` | No | `./data/cert.pem` | Path to store the agent's certificate |
| `CA_CERT_PATH` | No | `./data/ca-cert.pem` | Path to store the CA certificate |
| `ERROR_RETRY_INTERVAL` | No | 600 | Retry interval in seconds after a failed initialization |
| `TARGET_HOST` | No | `mesh-router-caddy` | Host serving `TARGET_PORT_HTTPS`, reached over the shared docker network |
| `READINESS_TIMEOUT` | No | 120 | Seconds to wait for `TARGET_HOST` to serve our certificate before registering routes. `0` disables the wait. Timing out is not fatal — the agent registers anyway |
| `READINESS_INTERVAL` | No | 2 | Seconds between readiness probes |
| `IP_ZONE` | No | - | Zone served by a mesh-router-nameserver (`ip.nsl.sh`). Routes are `<ip-dashed>.<IP_ZONE>`. Empty: the backend's published `ipZone`; none there either = no direct route (no nip.io fallback) |
| `MESH_USAGE_REPORT` | No | `on` | Usage (DAU) reporting, see below. `off` = no listener, nothing sent |
| `USAGE_LOG_PORT` | No | 5140 | UDP port Caddy streams its access log to. Reach it over the docker network only; never publish it |
| `USAGE_REPORT_INTERVAL` | No | 300 | Seconds between report attempts; a report goes out only when the day's set grew |
| `USAGE_STATE_PATH` | No | `./usage/state.json` | What is collected and sent, for mesh-console (and kept across restarts) |
| `DOMAIN` | No | - | The box's domain (`alice.nsl.sh`), to tell which app a request was for. Empty: the domain the backend returns on route registration |

> **Note**: `HEARTBEAT_INTERVAL` is deprecated. Use `REFRESH_INTERVAL` instead.

### Usage reporting

The backend's Daily Active Users KPI counts, per day, **the boxes where someone opened app X**.
The box reports it itself, so it is right whichever route the visit took (direct, gateway, tunnel):

1. mesh-router-caddy streams its access log (JSON) to the agent on `USAGE_LOG_PORT`, over UDP: a
   stopped agent loses a few entries instead of Caddy blocking or dumping them to its own log.
   Nothing is written to disk.
2. The agent keeps a request only if it is a person opening a page: a `GET` answered 2xx that the
   browser marks as a navigation (`Sec-Fetch-Mode: navigate`, or an `Accept` asking for HTML), from
   a client outside the agent's own docker networks (so the box's own probes do not count; a home
   LAN does).
3. The host becomes an app name (`nextcloud-alice.nsl.sh` → `nextcloud`; the bare domain →
   `_root`; a custom domain → `_custom`) and lands in that UTC day's set.
4. Every `USAGE_REPORT_INTERVAL`, if the set grew, the agent sends
   `POST /router/api/usage/:userid/:sig {date, apps}`, signed like route registration. Only today
   and yesterday are kept; a failed send is retried, an older backend (404) is retried hourly.

Sent: the date and the app names. Not sent: addresses, paths, user agents, counts.
`MESH_USAGE_REPORT=off` turns it off on both sides (the template wires the switch to Caddy too).

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

Without an IP zone there is no agent route. The box's sslip.io names
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
- **Domain routes** use our own IP-encoding DNS (ip.<zone>) to resolve IPs
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
