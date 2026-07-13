# etteum.ps1 - Etteum management CLI (Windows)
# Usage: .\etteum.ps1 [start|stop|restart|status|logs|update|port|build]
#
# Project dir resolution (first valid wins):
#   1. $env:ETTEUM_HOME
#   2. $env:POOLPROX_HOME  (legacy alias)
#   3. etteum.home pointer next to this script / under ~/.local/bin / ~/.config/etteum
#   4. Directory containing this script (when run from the checkout)
#   5. Default ~/etteum-pool

param(
  [Parameter(Position = 0)][string]$Command = "help",
  [Parameter(Position = 1)][string]$Arg1,
  [Parameter(Position = 2)][string]$Arg2
)

$ErrorActionPreference = "Stop"

function Test-EtteumProject([string]$dir) {
  if (-not $dir) { return $false }
  try { $dir = [System.IO.Path]::GetFullPath($dir) } catch { return $false }
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return $false }
  $pkg = Join-Path $dir "package.json"
  $prod = Join-Path $dir "scripts\production.ts"
  if (-not (Test-Path -LiteralPath $pkg)) { return $false }
  if (-not (Test-Path -LiteralPath $prod)) { return $false }
  return $true
}

function Read-HomePointer([string]$file) {
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  $line = (Get-Content -LiteralPath $file -TotalCount 1 -ErrorAction SilentlyContinue)
  if (-not $line) { return $null }
  return $line.Trim().Trim('"').Trim("'")
}

function Resolve-EtteumProjectDir {
  # $PSScriptRoot is the directory of this .ps1 even when called from a function.
  $scriptDir = $PSScriptRoot
  if (-not $scriptDir -and $PSCommandPath) {
    $scriptDir = Split-Path -Parent $PSCommandPath
  }

  $candidates = @()
  if ($env:ETTEUM_HOME) { $candidates += $env:ETTEUM_HOME }
  if ($env:POOLPROX_HOME) { $candidates += $env:POOLPROX_HOME }

  $pointerFiles = @(
    (Join-Path $scriptDir "etteum.home"),
    (Join-Path $HOME ".local\bin\etteum.home"),
    (Join-Path $HOME ".config\etteum\home")
  )
  foreach ($pf in $pointerFiles) {
    $pointed = Read-HomePointer $pf
    if ($pointed) { $candidates += $pointed }
  }

  if ($scriptDir) { $candidates += $scriptDir }
  $candidates += (Join-Path $HOME "etteum-pool")

  foreach ($c in $candidates) {
    if (Test-EtteumProject $c) {
      return [System.IO.Path]::GetFullPath($c)
    }
  }

  Write-Host "Could not locate the Etteum install directory." -ForegroundColor Red
  Write-Host ""
  Write-Host "Tried:"
  $seen = @{}
  foreach ($c in $candidates) {
    if (-not $c) { continue }
    $key = $c.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    Write-Host "  - $c"
  }
  Write-Host ""
  Write-Host "Fix one of:"
  Write-Host "  1. Set ETTEUM_HOME to your install folder, then reopen the terminal"
  Write-Host "     setx ETTEUM_HOME `"C:\path\to\etteum`""
  Write-Host "  2. Re-run install.ps1 from the project (rewrites the CLI home pointer)"
  Write-Host "  3. Run from the project:  .\etteum.ps1 <command>"
  exit 1
}

$ProjectDir = Resolve-EtteumProjectDir
$PidFile = Join-Path $ProjectDir ".etteum.pid"
$LogFile = Join-Path $ProjectDir ".etteum.log"
$EnvFile = Join-Path $ProjectDir ".env"

function Get-EnvValue([string]$key, [string]$default) {
  if (-not (Test-Path $EnvFile)) { return $default }
  $line = Select-String -Path $EnvFile -Pattern "^$key=" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { return ($line.Line -replace "^$key=", "").Trim('"').Trim("'") }
  return $default
}

function Test-Running {
  if (-not (Test-Path $PidFile)) { return $false }
  $procId = Get-Content $PidFile -ErrorAction SilentlyContinue
  if (-not $procId) { return $false }
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    return $true
  } catch {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    return $false
  }
}

function Test-PortInUse([int]$port) {
  try {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    return [bool]$listener
  } catch { return $false }
}

function Invoke-Start {
  $apiPort = [int](Get-EnvValue "PORT" "1930")
  $dashPort = [int](Get-EnvValue "DASHBOARD_PORT" "1931")

  if (Test-PortInUse $apiPort) {
    Write-Host "Port $apiPort already in use. Run: .\etteum.ps1 stop" -ForegroundColor Red
    return
  }
  if (Test-PortInUse $dashPort) {
    Write-Host "Port $dashPort already in use. Run: .\etteum.ps1 stop" -ForegroundColor Red
    return
  }

  Write-Host "Starting Etteum..."
  $stdoutLog = "$LogFile.stdout"
  $stderrLog = "$LogFile.stderr"
  $proc = Start-Process -FilePath "bun" -ArgumentList "scripts/production.ts","--skip-build" `
    -WorkingDirectory $ProjectDir -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog `
    -WindowStyle Hidden -PassThru
  $proc.Id | Out-File -FilePath $PidFile -Encoding ascii
  Start-Sleep -Seconds 1

  if (-not $proc.HasExited) {
    Write-Host "Etteum started (PID $($proc.Id))" -ForegroundColor Green
    Write-Host "  Backend:   http://localhost:$apiPort"
    Write-Host "  Dashboard: http://localhost:$dashPort"
    Write-Host "  Logs:      .\etteum.ps1 logs"
  } else {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host "Failed to start. Check logs at $LogFile" -ForegroundColor Red
    Get-Content $LogFile -Tail 5 -ErrorAction SilentlyContinue
  }
}

function Invoke-Stop {
  Write-Host "Stopping Etteum..."
  $killed = @()

  # 1. Match by command line (launcher + server + dashboard). This is the
  #    primary path. production.ts spawns src/index.ts as a child; both match.
  Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "scripts[\\/](production|start|serve-dashboard)\.ts|src[\\/]index\.ts" } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      $killed += $_.ProcessId
    }

  # 2. Kill whatever still owns the API/dashboard ports. The launcher
  #    (production.ts) spawns src/index.ts detached, and killing the parent
  #    can orphan the child — leaving the port held. This guarantees the ports
  #    are actually freed, which is what 'stop' promises.
  foreach ($port in @(
    [int](Get-EnvValue "PORT" "1930"),
    [int](Get-EnvValue "DASHBOARD_PORT" "1931")
  )) {
    try {
      Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
        ForEach-Object {
          if ($killed -notcontains $_.OwningProcess) {
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
            $killed += $_.OwningProcess
          }
        }
    } catch {}
  }

  # 3. Fallback: the PID recorded at start (in case the CIM/port paths missed
  #    a process started differently).
  if (Test-Path $PidFile) {
    $procId = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($procId) {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      $killed += $procId
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
  }

  # Give the OS a moment to release the listening sockets.
  Start-Sleep -Milliseconds 500
  Write-Host "Etteum stopped"
}

function Invoke-Status {
  if (Test-Running) {
    $procId = Get-Content $PidFile
    Write-Host "Etteum is running (PID $procId)" -ForegroundColor Green
    Write-Host "  Backend:   http://localhost:$(Get-EnvValue 'PORT' '1930')"
    Write-Host "  Dashboard: http://localhost:$(Get-EnvValue 'DASHBOARD_PORT' '1931')"
  } else {
    Write-Host "Etteum is not running"
  }
}

function Invoke-Logs([string]$tailArg) {
  if (-not (Test-Path $LogFile)) {
    Write-Host "No logs yet at $LogFile"
    return
  }
  if ($tailArg -eq "-f" -or -not $tailArg) {
    Get-Content $LogFile -Wait -Tail 50
  } else {
    Get-Content $LogFile -Tail ([int]$tailArg)
  }
}

function Install-CliHomePointer {
  # Keep global shims and home pointers aligned with this checkout so
  # `etteum update` works from PATH for every user after install/update.
  $target = Join-Path $HOME ".local\bin"
  if (-not (Test-Path -LiteralPath $target)) {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
  }
  $srcPs1 = Join-Path $ProjectDir "etteum.ps1"
  $srcCmd = Join-Path $ProjectDir "etteum.cmd"
  if (Test-Path -LiteralPath $srcPs1) {
    Copy-Item -LiteralPath $srcPs1 -Destination (Join-Path $target "etteum.ps1") -Force
  }
  if (Test-Path -LiteralPath $srcCmd) {
    Copy-Item -LiteralPath $srcCmd -Destination (Join-Path $target "etteum.cmd") -Force
  }
  $installRoot = [System.IO.Path]::GetFullPath($ProjectDir)
  Set-Content -LiteralPath (Join-Path $target "etteum.home") -Value $installRoot -Encoding ascii -NoNewline
  $configDir = Join-Path $HOME ".config\etteum"
  if (-not (Test-Path -LiteralPath $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
  }
  Set-Content -LiteralPath (Join-Path $configDir "home") -Value $installRoot -Encoding ascii -NoNewline
  $env:ETTEUM_HOME = $installRoot
  try {
    [Environment]::SetEnvironmentVariable("ETTEUM_HOME", $installRoot, "User")
  } catch {}
  Write-Host "CLI home pointer: $installRoot" -ForegroundColor DarkGray
}

function Invoke-Update {
  Write-Host "Updating Etteum at: $ProjectDir" -ForegroundColor Cyan
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir ".git"))) {
    Write-Host "Not a git checkout — re-run install.ps1 to upgrade, or clone the repo first." -ForegroundColor Red
    exit 1
  }
  Push-Location $ProjectDir
  try {
    Write-Host "Pulling latest..."
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) {
      Write-Host "git pull failed (exit $LASTEXITCODE). Resolve conflicts or run git pull manually." -ForegroundColor Red
      exit 1
    }
    Write-Host "Refreshing CLI shims..."
    Install-CliHomePointer
    Write-Host "Installing dependencies..."
    bun install
    if ($LASTEXITCODE -ne 0) {
      Write-Host "bun install failed (exit $LASTEXITCODE)." -ForegroundColor Red
      exit 1
    }
    $dashDir = Join-Path $ProjectDir "dashboard"
    if (-not (Test-Path -LiteralPath $dashDir)) {
      Write-Host "Dashboard folder missing at $dashDir" -ForegroundColor Red
      exit 1
    }
    # Dashboard is a separate package (not a workspace). Root bun install does
    # not install react-markdown / remark-gfm etc. into dashboard/node_modules.
    Write-Host "Installing dashboard dependencies..."
    Push-Location $dashDir
    try {
      bun install
      if ($LASTEXITCODE -ne 0) {
        Write-Host "dashboard bun install failed (exit $LASTEXITCODE)." -ForegroundColor Red
        exit 1
      }
    } finally { Pop-Location }
    Write-Host "Building dashboard..."
    Push-Location $dashDir
    try {
      bun run build
      if ($LASTEXITCODE -ne 0) {
        Write-Host "Dashboard build failed (exit $LASTEXITCODE)." -ForegroundColor Red
        exit 1
      }
    } finally { Pop-Location }
    Write-Host "Running migrations..."
    bun src/db/migrate.ts
    Write-Host "Restarting..."
    Invoke-Stop
    Start-Sleep -Seconds 1
    Invoke-Start
    Write-Host "Update complete" -ForegroundColor Green
  } finally { Pop-Location }
}

function Invoke-Build {
  $dashDir = Join-Path $ProjectDir "dashboard"
  if (-not (Test-Path -LiteralPath $dashDir)) {
    Write-Host "Dashboard folder missing at $dashDir" -ForegroundColor Red
    exit 1
  }
  Write-Host "Installing dashboard dependencies..."
  Push-Location $dashDir
  try {
    bun install
    if ($LASTEXITCODE -ne 0) {
      Write-Host "dashboard bun install failed (exit $LASTEXITCODE)." -ForegroundColor Red
      exit 1
    }
    Write-Host "Building dashboard..."
    bun run build
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Dashboard build failed (exit $LASTEXITCODE)." -ForegroundColor Red
      exit 1
    }
  } finally { Pop-Location }
  Write-Host "Restarting..."
  Invoke-Stop
  Start-Sleep -Seconds 1
  Invoke-Start
}

function Invoke-Port([string]$apiPort, [string]$dashPort) {
  if (-not $apiPort -or -not $dashPort) {
    Write-Host "Current ports: API=$(Get-EnvValue 'PORT' '1930') Dashboard=$(Get-EnvValue 'DASHBOARD_PORT' '1931')"
    Write-Host "Usage: .\etteum.ps1 port <api_port> <dashboard_port>"
    return
  }
  $content = Get-Content $EnvFile
  $content = $content -replace "^PORT=.*", "PORT=$apiPort"
  $content = $content -replace "^DASHBOARD_PORT=.*", "DASHBOARD_PORT=$dashPort"
  $content | Set-Content $EnvFile
  Write-Host "Ports changed: API=$apiPort Dashboard=$dashPort" -ForegroundColor Green
  if (Test-Running) {
    Write-Host "Restarting with new ports..."
    Invoke-Stop
    Start-Sleep -Seconds 1
    Invoke-Start
  }
}

function Invoke-Doctor {
  Push-Location $ProjectDir
  try { bun scripts/doctor.ts $args } finally { Pop-Location }
}

function Invoke-Preflight {
  Push-Location $ProjectDir
  try { bun scripts/preflight.ts } finally { Pop-Location }
}

function Invoke-Migrate {
  Push-Location $ProjectDir
  try { bun src/db/migrate.ts } finally { Pop-Location }
}

function Invoke-Dev {
  Push-Location $ProjectDir
  try { bun scripts/start.ts } finally { Pop-Location }
}

function Invoke-Export([string]$outPath) {
  Push-Location $ProjectDir
  try {
    # Arg2 can be --full (from: etteum export --full)
    $extra = @()
    if ($Arg1 -eq "--full" -or $Arg2 -eq "--full") { $extra += "--full" }
    $dest = if ($outPath -and $outPath -ne "--full") { $outPath } else { $null }
    if ($dest) { bun scripts/backup.ts export $dest @extra }
    else { bun scripts/backup.ts export @extra }
  } finally { Pop-Location }
}

function Invoke-Import([string]$inPath) {
  if (-not $inPath) {
    Write-Host "Usage: etteum import <backup-folder-or.zip>" -ForegroundColor Red
    return
  }
  Push-Location $ProjectDir
  try {
    Write-Host "Stopping server so the database is not locked..."
    Invoke-Stop
    Start-Sleep -Seconds 1
    bun scripts/backup.ts import $inPath --yes
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Import failed (exit $LASTEXITCODE)." -ForegroundColor Red
      return
    }
    Write-Host "Starting server..."
    Start-Sleep -Seconds 1
    Invoke-Start
  } finally { Pop-Location }
}

switch ($Command.ToLower()) {
  "start"     { Invoke-Start }
  "stop"      { Invoke-Stop }
  "restart"   { Invoke-Stop; Start-Sleep -Seconds 1; Invoke-Start }
  "status"    { Invoke-Status }
  "logs"      { Invoke-Logs $Arg1 }
  "update"    { Invoke-Update }
  "build"     { Invoke-Build }
  "port"      { Invoke-Port $Arg1 $Arg2 }
  "doctor"    { Invoke-Doctor }
  "preflight" { Invoke-Preflight }
  "migrate"   { Invoke-Migrate }
  "dev"       { Invoke-Dev }
  "export"    { Invoke-Export $Arg1 }
  "import"    { Invoke-Import $Arg1 }
  "prune-logs" {
    Push-Location $ProjectDir
    try {
      Write-Host "Stopping server for VACUUM (recommended on Windows)..."
      Invoke-Stop
      Start-Sleep -Seconds 1
      if ($Arg1) { bun scripts/prune-request-logs.ts $Arg1 }
      else { bun scripts/prune-request-logs.ts }
      Start-Sleep -Seconds 1
      Invoke-Start
    } finally { Pop-Location }
  }
  default {
    Write-Host "etteum - Etteum Pool Management CLI (Windows)`n"
    Write-Host "Usage: .\etteum.ps1 <command> [args]`n"
    Write-Host "Server:" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host "  start             Start the server"
    Write-Host "  stop              Stop the server"
    Write-Host "  restart           Restart the server"
    Write-Host "  status            Show server status"
    Write-Host "  dev               Run in foreground with HMR"
    Write-Host ""
    Write-Host "Logs & maintenance:" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host "  logs [-f|N]       Follow logs, or print last N lines"
    Write-Host "  build             Rebuild dashboard and restart"
    Write-Host "  migrate           Run database migrations"
    Write-Host "  doctor            Diagnose installation health"
    Write-Host "  preflight         Quick smoke test"
    Write-Host ""
    Write-Host "Configuration:" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host "  port <api> <dash> Change ports"
    Write-Host "  update            Pull, install, build, restart"
    Write-Host "  export [path]     Backup DB + .env for another PC"
    Write-Host "  import <path>     Restore backup (stops/starts server)"
    Write-Host "  prune-logs        Shrink request_logs + VACUUM disk"
    Write-Host ""
    Write-Host "Common workflows:"
    Write-Host "  First time:       irm bun.sh/install.ps1 | iex; .\install.ps1; etteum start"
    Write-Host "  After update:     etteum update"
    Write-Host "  Migrate PC:       etteum export; copy file; other PC: etteum import file"
    Write-Host "  DB too big:       etteum prune-logs"
    Write-Host "  Something broke:  etteum doctor; etteum logs 50"
  }
}
