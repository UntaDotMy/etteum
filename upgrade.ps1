# Etteum Pool Upgrader (Windows PowerShell 5.1+ / 7+).
#
# Safely upgrades the installation: backs up the database, pulls latest code,
# rebuilds, and restores if anything fails.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File upgrade.ps1
#
# Environment variables (all optional):
#   $env:ETTEUM_HOME          Install directory (default: $HOME\etteum-pool)
#   $env:ETTEUM_YES = "1"     Skip confirmation (CI / unattended)
#   $env:ETTEUM_BRANCH        Branch to pull (default: current branch)

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$DefaultDir = if ($env:ETTEUM_HOME) { $env:ETTEUM_HOME } else { Join-Path $HOME "etteum-pool" }
$AssumeYes  = $env:ETTEUM_YES -eq "1"
$Branch     = $env:ETTEUM_BRANCH

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

function Have([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# ── Main ──────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Etteum Pool — Upgrader (Windows)" -ForegroundColor Blue
Write-Host ""

if (-not (Test-Path $DefaultDir)) {
    Fail "Directory not found: $DefaultDir — run the installer first."
}

$ProjectDir = $DefaultDir
Set-Location $ProjectDir

# 1. Check prerequisites
Step "Checking prerequisites..."
if (-not (Have "git")) { Fail "git not found in PATH" }
if (-not (Have "bun")) { Fail "bun not found in PATH — reinstall Bun" }
Ok "Prerequisites OK"

# 2. Stop server if running
Step "Stopping server..."
$pidFile = Join-Path $ProjectDir ".etteum.pid"
$serverWasRunning = $false
if (Test-Path $pidFile) {
    $pid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($pid -and (Get-Process -Id $pid -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        $serverWasRunning = $true
        Ok "Stopped server (PID $pid)"
    } else {
        Info "No running server (stale PID file)"
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
} else {
    Info "No PID file found"
}

# 3. Backup database
Step "Backing up database..."
$dbFile = Join-Path $ProjectDir "data\poolprox3.db"
$backupDir = Join-Path $ProjectDir "backups"
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }

if (Test-Path $dbFile) {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupFile = Join-Path $backupDir "poolprox3-$timestamp.db"
    Copy-Item $dbFile $backupFile -Force
    Ok "Backed up to $backupFile"

    # Also backup WAL/SHM if they exist
    foreach ($ext in @("-shm", "-wal")) {
        $src = "$dbFile$ext"
        if (Test-Path $src) {
            Copy-Item $src "$backupFile$ext" -Force -ErrorAction SilentlyContinue
        }
    }

    # Prune old backups (keep last 5)
    $oldBackups = Get-ChildItem $backupDir -Filter "poolprox3-*.db" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 5
    foreach ($old in $oldBackups) {
        Remove-Item $old.FullName -Force -ErrorAction SilentlyContinue
        Remove-Item "$($old.FullName)-shm" -Force -ErrorAction SilentlyContinue
        Remove-Item "$($old.FullName)-wal" -Force -ErrorAction SilentlyContinue
    }
} else {
    Info "No database file to backup"
}

# 4. Git pull
Step "Pulling latest code..."
$branchArg = if ($Branch) { "--ff-only" } else { "--ff-only" }
$pullResult = & git pull $branchArg 2>&1
if ($LASTEXITCODE -ne 0) {
    Warn "git pull failed: $pullResult"
    Info "Trying with rebase..."
    & git pull --rebase 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail "git pull/rebase failed. Resolve conflicts manually."
    }
}
Ok "Code updated"

# 5. Install dependencies
Step "Installing dependencies..."
& bun install 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "bun install failed" }
Ok "Dependencies installed"

# 6. Build dashboard
Step "Building dashboard..."
Set-Location (Join-Path $ProjectDir "dashboard")
& bun run build 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Warn "Dashboard build failed — rolling back..."
    Set-Location $ProjectDir
    & git checkout -- . 2>&1 | Out-Null
    Fail "Dashboard build failed. Check dashboard/ for errors."
}
Set-Location $ProjectDir
Ok "Dashboard built"

# 7. Run migrations
Step "Running migrations..."
& bun run migrate 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Warn "Migration failed — database backup is at: $backupDir"
    Fail "Migration failed. Restore from backup if needed."
}
Ok "Migrations complete"

# 8. Rebuild Python venv (if needed)
Step "Checking Python venv..."
$venvPy = Join-Path $ProjectDir "scripts\auth\.venv\Scripts\python.exe"
$venvPyLinux = Join-Path $ProjectDir "scripts\auth\.venv\bin\python"
if (-not (Test-Path $venvPy) -and -not (Test-Path $venvPyLinux)) {
    Info "Rebuilding Python venv..."
    & python -m venv (Join-Path $ProjectDir "scripts\auth\.venv") 2>&1 | Out-Null
    & $venvPy -m pip install -r (Join-Path $ProjectDir "scripts\auth\requirements.txt") 2>&1 | Out-Null
    Ok "Python venv rebuilt"
} else {
    Ok "Python venv OK"
}

# 9. Restart server if it was running
if ($serverWasRunning) {
    Step "Restarting server..."
    Start-Process -FilePath "bun" -ArgumentList "scripts/production.ts" -WorkingDirectory $ProjectDir -WindowStyle Hidden
    Ok "Server restarted"
}

Write-Host ""
Write-Host "ok  Upgrade complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Database backup: $backupDir"
Write-Host "To rollback: git checkout <previous-commit> && bun run migrate"
Write-Host ""
