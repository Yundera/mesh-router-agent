# mesh-router-agent Development Environment

This folder contains everything needed to run mesh-router-agent in a development container with hot reload.

## Quick Start

### Linux/Mac
```bash
./start.sh
```

### Windows (PowerShell)
```powershell
.\start.ps1
```

## Configuration

1. Copy `.env.example` to `.env` (done automatically on first start)
2. Edit `.env` with your configuration:
   - `PROVIDER`: Your provider connection string (`<backend_url>,<userid>,<signature>`)
   - `PUBLIC_IP`: (Optional) Your public IP, leave empty to auto-detect
   - `REFRESH_INTERVAL`: (Optional) Route refresh interval in seconds (default: 300)
   - `TARGET_PORT`: (Optional) Port where Caddy listens (default: 443)
   - `ROUTE_PRIORITY`: (Optional) Route priority, lower = higher priority (default: 1)

## Commands

| Action | Linux/Mac | Windows |
|--------|-----------|---------|
| Start dev server | `./start.sh` | `.\start.ps1` |
| Stop dev server | `./stop.sh` | `.\stop.ps1` |
| Stop & clean volumes | `./stop.sh --clean` | `.\stop.ps1 --clean` |
| Run tests | `./test.sh` | `.\test.ps1` |
| View logs | `docker compose logs -f` | `docker compose logs -f` |
| Shell access | `docker compose exec mesh-router-agent bash` | `docker compose exec mesh-router-agent bash` |

## Features

- **Hot Reload**: Changes to TypeScript files are automatically detected and the server restarts
- **Volume Mounts**: Source code is mounted from the parent directory
- **Persistent Dependencies**: `node_modules` is stored in a Docker volume for better performance on Windows/Mac

## Troubleshooting

### First start is slow
The first start downloads dependencies and builds the TypeScript. Subsequent starts are faster due to volume caching.

### Dependencies not updating
If you add new dependencies, restart with:
```bash
./stop.sh --clean
./start.sh
```

### Permission issues on Linux
Make scripts executable:
```bash
chmod +x *.sh
```
