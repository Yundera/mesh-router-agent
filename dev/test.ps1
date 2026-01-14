$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Check if container is running
$running = docker compose ps --status running 2>$null | Select-String "mesh-router-agent-dev"

if (-not $running) {
    Write-Host "[INFO] Container not running. Starting it..." -ForegroundColor Blue
    docker compose up -d

    Write-Host "[INFO] Waiting for container to be ready..." -ForegroundColor Blue
    Start-Sleep -Seconds 10

    # Install dependencies if needed
    docker compose exec mesh-router-agent pnpm install
}

Write-Host "[INFO] Running tests..." -ForegroundColor Blue
docker compose exec mesh-router-agent pnpm test

Write-Host ""
Write-Host "Tests completed!" -ForegroundColor Green
