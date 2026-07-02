# Etteum Pool — Windows Service Installer
#
# Installs Etteum as a Windows Service using NSSM (Non-Sucking Service Manager).
# Requires NSSM to be installed: https://nssm.cc/download
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File service/install-service.ps1
#
# To uninstall:
#   nssm remove etteum confirm

$ErrorActionPreference = "Stop"

$ProjectDir = if ($env:ETTEUM_HOME) { $env:ETTEUM_HOME } else { Join-Path $HOME "etteum-pool" }
$ServiceName = "etteum"

function Step([string]$msg) { Write-Host "==> " -ForegroundColor Cyan -NoNewline; Write-Host $msg -ForegroundColor White }
function Info([string]$msg) { Write-Host "    $msg" }
function Ok  ([string]$msg) { Write-Host "ok  " -ForegroundColor Green -NoNewline; Write-Host $msg }

# Check for NSSM
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "xx  NSSM not found. Download from https://nssm.cc/download" -ForegroundColor Red
    Write-Host "    Extract nssm.exe to a folder in your PATH (e.g., C:\Windows\System32)"
    exit 1
}

# Check if service already exists
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "!!  Service '$ServiceName' already exists. Remove it first:" -ForegroundColor Yellow
    Write-Host "    nssm remove $ServiceName confirm"
    exit 1
}

Step "Installing Etteum as Windows Service..."

# Get Bun path
$bunPath = if ($env:BUN_EXECUTABLE_PATH) {
    $env:BUN_EXECUTABLE_PATH
} else {
    Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
}

if (-not (Test-Path $bunPath)) {
    Write-Host "xx  Bun not found at: $bunPath" -ForegroundColor Red
    exit 1
}

# Install service
nssm install $ServiceName $bunPath (Join-Path $ProjectDir "scripts\production.ts")
nssm set $ServiceName AppDirectory $ProjectDir
nssm set $ServiceName DisplayName "Etteum Pool Proxy"
nssm set $ServiceName Description "AI Proxy Pool for Multiple Providers"
nssm set $ServiceName Start SERVICE_AUTO_START

# Set environment variables
nssm set $ServiceName AppEnvironmentExtra "NODE_ENV=production" "PORT=1930" "DASHBOARD_PORT=1931"

# Logging
$logDir = Join-Path $ProjectDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
nssm set $ServiceName AppStdout (Join-Path $logDir "etteum-service.log")
nssm set $ServiceName AppStderr (Join-Path $logDir "etteum-service-error.log")
nssm set $ServiceName AppRotateFiles 1
nssm set $ServiceName AppRotateBytes 10485760  # 10MB
nssm set $ServiceName AppRotateLines 1000

# Start service
nssm start $ServiceName

Ok "Service installed and started"
Write-Host ""
Write-Host "Service name: $ServiceName"
Write-Host "Logs: $logDir"
Write-Host ""
Write-Host "Commands:"
Write-Host "  nssm stop $ServiceName"
Write-Host "  nssm start $ServiceName"
Write-Host "  nssm restart $ServiceName"
Write-Host "  nssm remove $ServiceName confirm"
Write-Host ""
