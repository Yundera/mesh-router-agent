$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "Stopping mesh-router-agent dev environment..." -ForegroundColor Yellow

if ($args[0] -eq "--clean") {
    Write-Host "Cleaning up containers and volumes..." -ForegroundColor Yellow
    docker compose down -v
    Write-Host "Containers and volumes removed." -ForegroundColor Green
} else {
    docker compose down
    Write-Host "Containers stopped. Volumes preserved." -ForegroundColor Green
    Write-Host "Use '.\stop.ps1 --clean' to also remove volumes (node_modules, pnpm-store)" -ForegroundColor Gray
}
