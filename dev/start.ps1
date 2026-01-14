$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Starting mesh-router-agent Dev Environment" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# Check for .env file
if (-not (Test-Path ".env")) {
    Write-Host "[WARN] No .env file found. Creating from template..." -ForegroundColor Yellow
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Host "[INFO] Created .env from .env.example - please edit with your values" -ForegroundColor Green
    } else {
        @"
# mesh-router-agent dev environment
PROVIDER=
PUBLIC_IP=
HEARTBEAT_INTERVAL=1800
"@ | Out-File -FilePath ".env" -Encoding UTF8
        Write-Host "[INFO] Created .env file - please edit with your PROVIDER value" -ForegroundColor Green
    }
}

# Build and start
Write-Host "[INFO] Building dev container..." -ForegroundColor Blue
docker compose build

Write-Host "[INFO] Starting container..." -ForegroundColor Blue
docker compose up -d

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Development server starting..." -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Logs:        docker compose logs -f" -ForegroundColor White
Write-Host "  Shell:       docker compose exec mesh-router-agent bash" -ForegroundColor White
Write-Host "  Stop:        .\stop.ps1" -ForegroundColor White
Write-Host ""
Write-Host "  Hot reload is enabled - edit files and save to restart" -ForegroundColor White
Write-Host ""

# Follow logs
docker compose logs -f
