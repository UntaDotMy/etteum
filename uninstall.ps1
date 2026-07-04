# Etteum Pool Uninstaller (Windows PowerShell 5.1+ / 7+).
#
# Removes CLI shims, Python venv, node_modules, and optionally the database.
# Does NOT remove the project directory itself (you can re-install into it).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#
# Environment variables (all optional):
#   $env:ETTEUM_HOME          Install directory (default: $HOME\etteum-pool)
#   $env:ETTEUM_YES = "1"     Skip confirmation (CI / unattended)
#   $env:ETTEUM_KEEP_DATA = "1"  Keep the database file (default: keep)
#   $env:ETTEUM_REMOVE_DATA = "1"  Also remove the database file

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$DefaultDir = if ($env:ETTEUM_HOME) { $env:ETTEUM_HOME } else { Join-Path $HOME "etteum-pool" }
$AssumeYes  = $env:ETTEUM_YES -eq "1"
$KeepData   = $env:ETTEUM_REMOVE_DATA -ne "1"

function Step([string]$msg) { Write-Host "==> " -ForegroundColor Cyan -NoNewline; Write-Host $msg -ForegroundColor White }
function Info([string]$msg) { Write-Host "    $msg" }
function Warn([string]$msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "xx  $msg" -ForegroundColor Red; exit 1 }
function Ok  ([string]$msg) { Write-Host "ok  " -ForegroundColor Green -NoNewline; Write-Host $msg }

function Confirm-Action([string]$msg) {
    if ($AssumeYes) { Info $msg; return $true }
    $answer = Read-Host "$msg [y/N]"
    return $answer -eq "y" -or $answer -eq "Y"
}

# ── Main ──────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Etteum Pool — Uninstaller (Windows)" -ForegroundColor Red
Write-Host ""

if (-not (Test-Path $DefaultDir)) {
    Warn "Directory not found: $DefaultDir"
    Info "Nothing to uninstall."
    exit 0
}

$ProjectDir = $DefaultDir

# 1. Stop running server
Step "Stopping server..."
$pidFile = Join-Path $ProjectDir ".etteum.pid"
if (Test-Path $pidFile) {
    $pid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($pid -and (Get-Process -Id $pid -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        Ok "Stopped process $pid"
    } else {
        Info "No running server found (stale PID file)"
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
} else {
    Info "No PID file found"
}

# 2. Remove CLI shims
Step "Removing CLI shims..."
$localBin = Join-Path $HOME ".local\bin"
$shims = @("etteum.ps1", "etteum.cmd", "etteum")
$removed = 0
foreach ($shim in $shims) {
    $shimPath = Join-Path $localBin $shim
    if (Test-Path $shimPath) {
        Remove-Item $shimPath -Force -ErrorAction SilentlyContinue
        $removed++
    }
}
Ok "Removed $removed CLI shim(s) from $localBin"

# 3. Remove Python venv
Step "Removing Python venv..."
$venvPath = Join-Path $ProjectDir "scripts\auth\.venv"
if (Test-Path $venvPath) {
    Remove-Item $venvPath -Recurse -Force -ErrorAction SilentlyContinue
    Ok "Removed $venvPath"
} else {
    Info "No venv found"
}

# 4. Remove node_modules
Step "Removing node_modules..."
$rootNm = Join-Path $ProjectDir "node_modules"
$dashNm = Join-Path $ProjectDir "dashboard\node_modules"
$nmCount = 0
if (Test-Path $rootNm) { Remove-Item $rootNm -Recurse -Force -ErrorAction SilentlyContinue; $nmCount++ }
if (Test-Path $dashNm) { Remove-Item $dashNm -Recurse -Force -ErrorAction SilentlyContinue; $nmCount++ }
Ok "Removed $nmCount node_modules directory(ies)"

# 5. Remove dashboard dist
Step "Removing dashboard build..."
$distPath = Join-Path $ProjectDir "dashboard\dist"
if (Test-Path $distPath) {
    Remove-Item $distPath -Recurse -Force -ErrorAction SilentlyContinue
    Ok "Removed $distPath"
} else {
    Info "No dist found"
}

# 6. Remove log files
Step "Removing log files..."
$logFiles = @(
    ".etteum.log", ".etteum.log.stdout", ".etteum.log.stderr",
    ".aiproxy.log", ".etteum.pid"
)
$logCount = 0
foreach ($lf in $logFiles) {
    $lfPath = Join-Path $ProjectDir $lf
    if (Test-Path $lfPath) { Remove-Item $lfPath -Force -ErrorAction SilentlyContinue; $logCount++ }
}
Ok "Removed $logCount log file(s)"

# 7. Database — optional
if ($KeepData) {
    Info "Keeping database file (data/poolprox3.db)"
} else {
    Step "Removing database..."
    $dbFile = Join-Path $ProjectDir "data\poolprox3.db"
    $dbShm  = Join-Path $ProjectDir "data\poolprox3.db-shm"
    $dbWal  = Join-Path $ProjectDir "data\poolprox3.db-wal"
    $dbCount = 0
    foreach ($f in @($dbFile, $dbShm, $dbWal)) {
        if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue; $dbCount++ }
    }
    Ok "Removed $dbCount database file(s)"
}

# 8. .env — keep by default (contains user's API key)
Info "Keeping .env file (contains your API key and settings)"
Info "Delete it manually if you want a full clean: Remove-Item $ProjectDir\.env"

Write-Host ""
Write-Host "ok  Uninstall complete!" -ForegroundColor Green
Write-Host ""
Write-Host "The project directory still exists at: $ProjectDir"
Write-Host "To fully remove it: Remove-Item -Recurse -Force '$ProjectDir'"
Write-Host ""
