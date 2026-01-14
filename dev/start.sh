#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "  Starting mesh-router-agent Dev Environment"
echo "=========================================="

# Check for .env file
if [ ! -f ".env" ]; then
    echo "[WARN] No .env file found. Creating from template..."
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "[INFO] Created .env from .env.example - please edit with your values"
    else
        echo "# mesh-router-agent dev environment" > .env
        echo "PROVIDER=" >> .env
        echo "PUBLIC_IP=" >> .env
        echo "HEARTBEAT_INTERVAL=1800" >> .env
        echo "[INFO] Created .env file - please edit with your PROVIDER value"
    fi
fi

# Build and start
echo "[INFO] Building dev container..."
docker compose build

echo "[INFO] Starting container..."
docker compose up -d

echo ""
echo "=========================================="
echo "  Development server starting..."
echo "=========================================="
echo ""
echo "  Logs:        docker compose logs -f"
echo "  Shell:       docker compose exec mesh-router-agent bash"
echo "  Stop:        ./stop.sh"
echo ""
echo "  Hot reload is enabled - edit files and save to restart"
echo ""

# Follow logs
docker compose logs -f
