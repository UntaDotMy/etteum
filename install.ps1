# Etteum Pool installer (PRIVATE) for Windows (PowerShell 5.1+ / 7+).
#
# This is the private repo's installer. It mirrors install.ps1 in the public
# repo but defaults to the private repo URL. The private build includes extra
# providers (gitlab-duo, youmind) — installer flow is identical.
#
# One-command install (requires SSH key configured for the private repo):
#   irm https://raw.githubusercontent.com/priyo000/etteum/main/install.ps1 | iex
#
# Or after cloning:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Environment variables (all optional):
#   $env:ETTEUM_HOME          Install directory (default: $HOME\etteum-pool)
#   $env:ETTEUM_REPO          Repo URL (default: github.com/priyo000/etteum — PRIVATE)
#   $env:ETTEUM_YES = "1"     Skip confirmation (CI / unattended)
#   $env:ETTEUM_BRANCH        Branch to clone (default: main)
#   $env:ETTEUM_NO_CLI = "1"  Skip the etteum CLI in ~\.local\bin
#   $env:ETTEUM_SKIP_BROWSERS = "1"  Skip Camoufox browser binary download

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$RepoUrl     = if ($env:ETTEUM_REPO)    { $env:ETTEUM_REPO }    else { "git@github.com:priyo000/etteum.git" }
$DefaultDir  = if ($env:ETTEUM_HOME)    { $env:ETTEUM_HOME }    else { Join-Path $HOME "etteum-pool" }
$Branch      = if ($env:ETTEUM_BRANCH)  { $env:ETTEUM_BRANCH }  else { "main" }
$AssumeYes   = $env:ETTEUM_YES -eq "1"

function Step([string]$msg) { Write-Host "==> " -ForegroundColor Cyan -NoNewline; Write-Host $msg -ForegroundColor White }
function Info([string]$msg) { Write-Host "    $msg" }
function Warn([string]$msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "xx  $msg" -ForegroundColor Red; exit 1 }
function Ok  ([string]$msg) { Write-Host "ok  " -ForegroundColor Green -NoNewline; Write-Host $msg }

function Have([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# Refresh PATH from registry — winget/scoop/choco may have updated it
function Refresh-Path {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Add-PathOnce([string]$dir) {
    if (-not (Test-Path $dir)) { return }
    $current = $env:Path -split ';'
    if ($current -notcontains $dir) {
        $env:Path = "$dir;$env:Path"
    }
}

# Some Windows installs ship `python.exe` as a Microsoft Store stub that opens
# the Store and exits 0 with no real interpreter. Detect and reject it.
function Test-RealPython([string]$cmd) {
    try {
        $r = & $cmd --version 2>&1
        if ($LASTEXITCODE -ne 0) { return $false }
        if ($r -match "^Python \d+\.\d+") { return $true }
        return $false
    } catch { return $false }
}

# Retry a script block with exponential backoff for flaky network steps
function Retry-Action {
    param(
        [Parameter(Mandatory)] [scriptblock]$Action,
        [int]$MaxAttempts = 3,
        [int]$DelaySeconds = 3
    )
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            & $Action
            if ($LASTEXITCODE -eq 0) { return }
        } catch {
            if ($attempt -ge $MaxAttempts) { throw }
        }
        if ($attempt -ge $MaxAttempts) {
            throw "Failed after $MaxAttempts attempts"
        }
        Warn "Command failed (attempt $attempt/$MaxAttempts). Retrying in ${DelaySeconds}s..."
        Start-Sleep -Seconds $DelaySeconds
        $DelaySeconds = $DelaySeconds * 2
    }
}

function Show-Summary {
    Write-Host ""
    Write-Host "Etteum Pool" -ForegroundColor Cyan -NoNewline
    Write-Host " — AI Proxy Pool for Multiple Providers"
    Write-Host ""

    $needsGit = -not (Have git)
    $needsBun = -not (Have bun)

    $hasRealPython = $false
    foreach ($cand in @("python3.13","python3.12","python3.11","python3.10","python","python3")) {
        if (Have $cand) {
            if (-not (Test-RealPython $cand)) { continue }
            try {
                $v = & $cand -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
                if ($v) {
                    $p = $v.Trim().Split('.')
                    if ([int]$p[0] -eq 3 -and [int]$p[1] -ge 10) { $hasRealPython = $true; break }
                }
            } catch {}
        }
    }
    $needsPython = -not $hasRealPython

    $totalSize = 0
    $items = @()

    if ($needsGit)    { $items += "  • Git                          ~50 MB";  $totalSize += 50  }
    if ($needsBun)    { $items += "  • Bun runtime                  ~50 MB";  $totalSize += 50  }
    if ($needsPython) { $items += "  • Python 3.10+                 ~100 MB"; $totalSize += 100 }

    $items += "  • Node.js dependencies         ~200 MB"; $totalSize += 200
    $items += "  • Python packages (venv)       ~150 MB"; $totalSize += 150
    if ($env:ETTEUM_SKIP_BROWSERS -ne "1") {
        $items += "  • Camoufox browser (shared)    ~250 MB"; $totalSize += 250
    }
    $items += "  • Dashboard build              ~50 MB";  $totalSize += 50

    Write-Host "This will install:" -ForegroundColor White
    foreach ($item in $items) { Write-Host $item }
    Write-Host ""
    Write-Host "Estimated total size: " -NoNewline; Write-Host "~$totalSize MB" -ForegroundColor Yellow
    Write-Host "Install location:     $DefaultDir"
    Write-Host "PowerShell version:   $($PSVersionTable.PSVersion)"
    Write-Host ""

    if ($needsGit -or $needsBun -or $needsPython) {
        Write-Host "Note: " -ForegroundColor Yellow -NoNewline
        Write-Host "System dependencies will be installed via package manager (winget/scoop/choco)."
        Write-Host "      This may require " -NoNewline; Write-Host "administrator privileges" -ForegroundColor Yellow -NoNewline; Write-Host "."
        Write-Host ""
    }

    if ($AssumeYes) {
        Write-Host "ETTEUM_YES=1 set — skipping confirmation." -ForegroundColor DarkGray
        Write-Host ""
        return
    }

    if (-not [Environment]::UserInteractive) {
        Write-Host "Non-interactive shell — proceeding automatically." -ForegroundColor DarkGray
        Write-Host ""
        return
    }

    $response = Read-Host "Do you want to continue? [Y/n]"
    if ($response -match '^[nN]') {
        Write-Host "Installation cancelled." -ForegroundColor Yellow
        exit 0
    }
    Write-Host ""
}

function Ensure-PackageManager {
    # Need at least one of: winget, scoop, choco
    if ((Have winget) -or (Have scoop) -or (Have choco)) { return }

    Step "Installing Scoop (no winget/choco found)"
    try {
        Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
        Invoke-RestMethod get.scoop.sh | Invoke-Expression
        Add-PathOnce (Join-Path $HOME "scoop\shims")
        Refresh-Path
        if (-not (Have scoop)) {
            Fail "Scoop install completed but 'scoop' is not on PATH. Open a new PowerShell and re-run."
        }
        Ok "Scoop installed"
    } catch {
        Fail @"
No package manager (winget / scoop / choco) was found and Scoop install failed.
Install one of these manually, then re-run:
  • winget  — built into Windows 10/11; update from Microsoft Store
  • scoop   — https://scoop.sh
  • choco   — https://chocolatey.org/install
"@
    }
}

function Ensure-Git {
    if (Have git) { Ok "Git $(git --version | ForEach-Object { ($_ -split ' ')[2] }) already installed"; return }
    Step "Installing Git"
    if (Have winget) {
        winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
    } elseif (Have scoop) {
        scoop install git 2>&1 | Out-Null
    } elseif (Have choco) {
        choco install -y git 2>&1 | Out-Null
    } else {
        Fail "Install Git manually from https://git-scm.com/download/win and re-run this script"
    }
    Refresh-Path
    Add-PathOnce "$env:ProgramFiles\Git\cmd"
    Add-PathOnce "${env:ProgramFiles(x86)}\Git\cmd"
    Add-PathOnce "$env:LOCALAPPDATA\Programs\Git\cmd"
    if (-not (Have git)) { Fail "git is still not on PATH. Open a new PowerShell window and re-run." }
    Ok "Git installed"
}

function Ensure-Bun {
    $badVersion = "1.3.14"
    if (Have bun) {
        $ver = (bun --version 2>&1).Trim()
        if ($ver -eq $badVersion) {
            Step "Bun $ver detected — upgrading to canary (stable $badVersion has known issues)"
            try {
                $result = & bun upgrade --canary 2>&1
                if ($LASTEXITCODE -ne 0) { throw "bun upgrade --canary failed: $result" }
            } catch {
                Fail "Bun canary upgrade failed: $_"
            }
            if (Have bun) { Ok "Bun $(bun --version) (upgraded to canary)"; return }
        } else {
            Ok "Bun $ver already installed"
            return
        }
    }
    Step "Installing Bun"
    try {
        powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex" 2>&1 | Out-Null
    } catch {
        Fail "Bun install failed: $_`nIf you're behind a corporate proxy, set HTTPS_PROXY first."
    }
    Add-PathOnce (Join-Path $HOME ".bun\bin")
    Add-PathOnce (Join-Path $env:USERPROFILE ".bun\bin")
    Refresh-Path
    if (-not (Have bun)) {
        Warn "Bun installed but not on PATH yet. Open a new PowerShell and re-run this installer."
        exit 1
    }
    $freshVer = (bun --version 2>&1).Trim()
    if ($freshVer -eq $badVersion) {
        Info "Upgrading fresh install to canary..."
        & bun upgrade --canary 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Ok "Bun $(bun --version) (upgraded to canary)"
        } else {
            Warn "Canary upgrade failed (continuing with stable)"
        }
    } else {
        Ok "Bun $(bun --version) installed"
    }
}

function Ensure-Python {
    $script:PythonBin = $null
    foreach ($cand in @("python3.13","python3.12","python3.11","python3.10","python","python3")) {
        if (Have $cand) {
            if (-not (Test-RealPython $cand)) {
                Warn "$cand looks like the Microsoft Store stub — skipping"
                continue
            }
            try {
                $ver = & $cand -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
                if ($ver) {
                    $parts = $ver.Trim().Split('.')
                    if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 10) {
                        $script:PythonBin = $cand
                        Ok "Python $ver found ($cand)"
                        return
                    }
                }
            } catch {}
        }
    }
    Step "Installing Python 3.11"
    if (Have winget) {
        winget install --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
    } elseif (Have scoop) {
        scoop install python 2>&1 | Out-Null
    } elseif (Have choco) {
        choco install -y python --version=3.11 2>&1 | Out-Null
    } else {
        Fail "Install Python 3.10+ manually from https://python.org and re-run"
    }
    Refresh-Path
    foreach ($cand in @("python3.11","python","python3")) {
        if ((Have $cand) -and (Test-RealPython $cand)) { $script:PythonBin = $cand; break }
    }
    if (-not $script:PythonBin) {
        Warn "Python installed but not on PATH yet. Open a new PowerShell and re-run."
        exit 1
    }
    Ok "Python $(& $script:PythonBin --version) installed"
}

function Clone-Or-Update-Repo {
    $script:ProjectDir = $null
    if (Test-Path "package.json") {
        $pkg = Get-Content "package.json" -Raw
        if ($pkg -match '"name"\s*:\s*"etteum-pool"') {
            $script:ProjectDir = (Get-Location).Path
            Step "Using existing checkout: $($script:ProjectDir)"
            if (Test-Path ".git") {
                try { git pull --ff-only | Out-Null } catch { Warn "git pull failed (continuing)" }
            }
            return
        }
    }

    if (Test-Path (Join-Path $DefaultDir ".git")) {
        $script:ProjectDir = $DefaultDir
        Step "Updating existing checkout at $($script:ProjectDir)"
        Push-Location $script:ProjectDir
        try { git pull --ff-only | Out-Null } catch { Warn "git pull failed" }
        finally { Pop-Location }
    } else {
        $script:ProjectDir = $DefaultDir
        Step "Cloning $RepoUrl -> $($script:ProjectDir) (branch: $Branch)"
        git clone --depth=1 --branch $Branch $RepoUrl $script:ProjectDir
        if ($LASTEXITCODE -ne 0) {
            Fail "git clone failed. Check connectivity and repo URL: $RepoUrl"
        }
    }
    Set-Location $script:ProjectDir
}

function Write-EnvIfMissing {
    Step "Configuring .env"
    if (Test-Path ".env") {
        Info ".env already exists, checking for missing keys..."
    } else {
        Copy-Item ".env.example" ".env"
        Info "Created .env from .env.example"
    }

    $envContent = Get-Content ".env" -Raw

    # Generate ENCRYPTION_KEY if it's still the default placeholder
    if ($envContent -match 'ENCRYPTION_KEY=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' -or $envContent -match 'ENCRYPTION_KEY=\s*$' -or $envContent -notmatch 'ENCRYPTION_KEY=') {
        $bytes = New-Object byte[] 16
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $key = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""

        if ($envContent -match 'ENCRYPTION_KEY=') {
            (Get-Content ".env") -replace '^ENCRYPTION_KEY=.*', "ENCRYPTION_KEY=$key" | Set-Content ".env"
        } else {
            Add-Content ".env" "ENCRYPTION_KEY=$key"
        }
        Ok "Generated random ENCRYPTION_KEY"
    }

    # Auto-rotate API_KEY off the default
    $envContent = Get-Content ".env" -Raw
    if ($envContent -match 'API_KEY=pool-proxy-secret-key') {
        $bytes = New-Object byte[] 24
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $newApi = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
        (Get-Content ".env") -replace '^API_KEY=.*', "API_KEY=$newApi" | Set-Content ".env"
        Ok "Generated random API_KEY"
        Info "  Your API key: $newApi"
        Info "  Clients send this as: Authorization: Bearer <api_key>"
    }

    # PYTHON_PATH should be empty (auto-detect) — server picks the venv path per-OS at runtime
    $envContent = Get-Content ".env" -Raw
    if ($envContent -notmatch 'PYTHON_PATH=') {
        Add-Content ".env" "PYTHON_PATH="
        Info "Added PYTHON_PATH= (auto-detect)"
    } else {
        $pyPath = ((Get-Content ".env") | Where-Object { $_ -match '^PYTHON_PATH=' }) -replace '^PYTHON_PATH=', ''
        if ($pyPath -and -not (Test-Path $pyPath)) {
            Warn "PYTHON_PATH=$pyPath does not exist — clearing for auto-detect"
            (Get-Content ".env") -replace '^PYTHON_PATH=.*', 'PYTHON_PATH=' | Set-Content ".env"
        }
    }

    # Ensure other required keys exist
    $envContent = Get-Content ".env" -Raw
    $requiredKeys = @("PORT", "DASHBOARD_PORT", "API_KEY", "DATABASE_PATH", "AUTH_SCRIPT_PATH", "AUTH_SCRIPT_CWD")
    foreach ($keyName in $requiredKeys) {
        if ($envContent -notmatch "(?m)^${keyName}=") {
            $defaultVal = ""
            if (Test-Path ".env.example") {
                $exLine = (Get-Content ".env.example") | Where-Object { $_ -match "^${keyName}=" }
                if ($exLine) { $defaultVal = $exLine -replace "^${keyName}=", "" }
            }
            Add-Content ".env" "${keyName}=${defaultVal}"
            Info "Added missing ${keyName}"
        }
    }
}

function Install-NodeDeps {
    Step "Installing JS dependencies"
    if (-not (Have bun)) {
        Add-PathOnce (Join-Path $HOME ".bun\bin")
        if (-not (Have bun)) {
            Fail "bun is not on PATH. Open a new PowerShell and re-run the installer."
        }
    }

    Info "Installing root dependencies..."
    Retry-Action -Action { bun install }
    if ($LASTEXITCODE -ne 0) {
        Fail "bun install failed in project root. Try manually: bun install"
    }

    Info "Installing dashboard dependencies..."
    Push-Location "dashboard"
    try {
        Retry-Action -Action { bun install }
        if ($LASTEXITCODE -ne 0) {
            Fail "bun install failed in dashboard/. Try manually: cd dashboard && bun install"
        }
    } finally {
        Pop-Location
    }

    Ok "JS dependencies installed"
}

function Setup-PythonVenv {
    $venv = "scripts\auth\.venv"
    $venvPy  = "$venv\Scripts\python.exe"
    $venvPip = "$venv\Scripts\pip.exe"
    $usePipModule = $false  # Fallback to 'python -m pip' if pip.exe missing

    Step "Setting up Python venv at $venv"

    # Check if venv exists and is functional
    $venvFunctional = $false
    if (Test-Path $venvPy) {
        try {
            $venvCheck = & $venvPy -c "import sys; print(sys.executable)" 2>&1
            if ($LASTEXITCODE -eq 0) {
                $venvFunctional = $true
            }
        } catch {
            # python.exe doesn't work
        }
    }

    if (-not $venvFunctional) {
        if (Test-Path $venv) {
            Warn "Python venv is broken — recreating..."
            Remove-Item -Recurse -Force $venv
        }
    }

    if (-not (Test-Path $venv)) {
        Info "Creating virtual environment..."
        & $script:PythonBin -m venv $venv
        if ($LASTEXITCODE -ne 0) {
            Fail "Failed to create Python venv at $venv. Try manually: $($script:PythonBin) -m venv $venv"
        }
    }

    if (-not (Test-Path $venvPy)) {
        Fail "Python venv created but $venvPy not found! Try deleting $venv and re-running the installer."
    }
    if (-not (Test-Path $venvPip)) {
        # pip.exe might not exist, but python -m pip should work
        try {
            $pipCheck = & $venvPy -m pip --version 2>&1
            if ($LASTEXITCODE -ne 0) {
                Fail "Neither pip.exe nor 'python -m pip' found. Try deleting $venv and re-running."
            }
            $usePipModule = $true
            Ok "Using python -m pip (pip.exe not found)"
        } catch {
            Fail "pip not available. Try deleting $venv and re-running."
        }
    }

    Info "Upgrading pip..."
    # --no-input: never block on an interactive prompt (keyring, conflict).
    # --progress-bar off: clean log output (the bar breaks in piped installs).
    if ($usePipModule) {
        Retry-Action -Action { & $venvPy -m pip install --no-input --progress-bar off --upgrade pip wheel 2>&1 | Out-Null }
    } else {
        Retry-Action -Action { & $venvPip install --no-input --progress-bar off --upgrade pip wheel 2>&1 | Out-Null }
    }

    Info "Installing Python packages (this may take a minute)..."
    if ($usePipModule) {
        Retry-Action -Action { & $venvPy -m pip install --no-input --progress-bar off -r "scripts\auth\requirements.txt" }
    } else {
        Retry-Action -Action { & $venvPip install --no-input --progress-bar off -r "scripts\auth\requirements.txt" }
    }
    if ($LASTEXITCODE -ne 0) {
        Fail "pip install failed. Try manually: $venvPy -m pip install --no-input -r scripts\auth\requirements.txt"
    }
    Ok "Python deps installed"

    # Shared browser runtime for provider login + farms (one Camoufox, not per-farm).
    # Remove legacy nodriver if a previous install left it in the venv.
    try {
        & $venvPy -c "import nodriver" 2>$null
        if ($LASTEXITCODE -eq 0) {
            Info "Removing legacy nodriver package..."
            if ($usePipModule) { & $venvPy -m pip uninstall -y --no-input nodriver 2>&1 | Out-Null }
            else { & $venvPip uninstall -y --no-input nodriver 2>&1 | Out-Null }
        }
    } catch {}

    if ($env:ETTEUM_SKIP_BROWSERS -eq "1") {
        Warn "ETTEUM_SKIP_BROWSERS=1 — skipping Camoufox browser fetch."
        Warn "  Auth/farm will fail until you run: $venvPy -m camoufox fetch"
        return
    }

    Step "Fetching Camoufox browser binary (shared for auth + farms)"
    Info "python -m camoufox fetch — downloads the stealth Firefox build once..."
    # Bounded timeout: first fetch can be large. Fail open with a manual hint.
    $cfJob = Start-Job -ScriptBlock {
        param($py)
        & $py -m camoufox fetch 2>&1
    } -ArgumentList $venvPy
    if (Wait-Job -Job $cfJob -Timeout 300) {
        Receive-Job -Job $cfJob 2>&1 | Out-Null
        if ($cfJob.State -eq "Completed") {
            # Verify import still works after fetch
            & $venvPy -c "import camoufox; import playwright" 2>$null
            if ($LASTEXITCODE -eq 0) {
                Ok "Camoufox browser ready (scripts/auth/.venv)"
            } else {
                Warn "Camoufox fetch finished but import check failed — re-run: $venvPy -m pip install -r scripts\auth\requirements.txt && $venvPy -m camoufox fetch"
            }
        } else {
            Warn "Camoufox fetch failed — re-run: $venvPy -m camoufox fetch"
        }
    } else {
        Warn "Camoufox fetch timed out (>300s) — re-run: $venvPy -m camoufox fetch"
    }
    Remove-Job -Job $cfJob -Force 2>$null
}

function Build-Dashboard {
    Step "Building dashboard (production)"
    Push-Location "dashboard"
    try {
        Retry-Action -Action { bun run build }
        if ($LASTEXITCODE -ne 0) {
            Fail "Dashboard build failed. Try manually: cd dashboard && bun run build"
        }
    } finally {
        Pop-Location
    }
    Ok "Dashboard built"
}

function Run-Migrations {
    Step "Running database migrations"
    if (-not (Test-Path "data")) { New-Item -ItemType Directory -Path "data" -Force | Out-Null }
    try {
        bun src/db/migrate.ts
        if ($LASTEXITCODE -eq 0) {
            Ok "Migrations applied"
        } else {
            Warn "Migrations failed. Database will be created on first run."
            Info "After first run, you can re-run: bun src/db/migrate.ts"
        }
    } catch {
        Warn "Migrations failed. Database will be created on first run."
        Info "After first run, you can re-run: bun src/db/migrate.ts"
    }
}

function Install-CliShims {
    if ($env:ETTEUM_NO_CLI -eq "1") {
        Warn "ETTEUM_NO_CLI=1 — skipping CLI install"
        return
    }
    Step "Installing CLI commands"
    $target = Join-Path $HOME ".local\bin"
    if (-not (Test-Path $target)) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
    }

    $srcPs1 = Join-Path $script:ProjectDir "etteum.ps1"
    $srcCmd = Join-Path $script:ProjectDir "etteum.cmd"

    if (Test-Path $srcPs1) {
        Copy-Item $srcPs1 (Join-Path $target "etteum.ps1") -Force
    } else {
        Warn "etteum.ps1 not found at $srcPs1"
    }
    if (Test-Path $srcCmd) {
        Copy-Item $srcCmd (Join-Path $target "etteum.cmd") -Force
    } else {
        Warn "etteum.cmd not found at $srcCmd"
    }

    # Global shims live outside the checkout, so record where the install is.
    # etteum.ps1 reads this pointer (plus ETTEUM_HOME) so update/start work
    # from any directory for every user.
    $installRoot = [System.IO.Path]::GetFullPath($script:ProjectDir)
    $pointerBesideShim = Join-Path $target "etteum.home"
    $configDir = Join-Path $HOME ".config\etteum"
    $pointerConfig = Join-Path $configDir "home"
    Set-Content -LiteralPath $pointerBesideShim -Value $installRoot -Encoding ascii -NoNewline
    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }
    Set-Content -LiteralPath $pointerConfig -Value $installRoot -Encoding ascii -NoNewline

    # Persist ETTEUM_HOME so upgrade.ps1 / services / new shells resolve the same path.
    $env:ETTEUM_HOME = $installRoot
    try {
        [Environment]::SetEnvironmentVariable("ETTEUM_HOME", $installRoot, "User")
        Ok "Set user ETTEUM_HOME=$installRoot"
    } catch {
        Warn "Could not set user ETTEUM_HOME permanently: $_"
        Info "You can set it manually: setx ETTEUM_HOME `"$installRoot`""
    }

    Ok "Installed etteum command to $target (home pointer -> $installRoot)"

    if (($env:Path -split ';') -notcontains $target) {
        Warn "$target is not on your PATH."
        Info "Add it for this session:"
        Info "  `$env:Path = `"$target;`$env:Path`""
        Info "Or permanently:"
        Info "  setx Path `"$target;%Path%`""
    }
}

function Run-Preflight {
    Step "Running preflight check"
    try {
        bun scripts/preflight.ts
        if ($LASTEXITCODE -eq 0) { return }
    } catch {}
    Warn "Preflight reported issues — see above. The server may still start."
    Info "Run `etteum doctor` for a detailed report."
}

function Setup-SearXNG {
    # The built-in web_search tool works zero-config (DuckDuckGo backend).
    # SearXNG is an optional, more-robust self-hosted backend. Opt-in only.
    $want = $false
    if ($env:ETTEUM_SEARXNG -eq "1") { $want = $true }
    elseif (-not $env:ETTEUM_YES) {
        Write-Host ""
        Write-Host "Web search backend" -ForegroundColor White
        Write-Host "  The built-in web_search tool works zero-config (DuckDuckGo)."
        Write-Host "  Optionally install SearXNG (self-hosted, more robust) via Docker?" -NoNewline
        $reply = Read-Host " [y/N]"
        if ($reply -match '^[yY]') { $want = $true }
    }

    if (-not $want) {
        Info "SearXNG skipped — web_search will use the DuckDuckGo backend."
        Info "Add SearXNG later: run SearXNG, set SEARXNG_URL in .env, then 'etteum doctor'."
        return
    }

    if (-not (Have docker)) {
        Warn "Docker not found — cannot auto-install SearXNG."
        Info "Install Docker Desktop, then run:"
        Info "  docker run -d --name etteum-searxng -p 8080:8080 -e SEARXNG_BASE_URL=http://localhost:8080/ searxng/searxng:latest"
        Info "Then add to .env:  SEARXNG_URL=http://localhost:8080"
        Info "And enable JSON output: in the container's settings.yml add 'json' under search.formats."
        return
    }

    Step "Installing SearXNG (Docker)"
    docker pull searxng/searxng:latest 2>$null | Out-Null
    $existing = (docker ps -a --format '{{.Names}}' 2>$null) -eq 'etteum-searxng'
    if ($existing) {
        docker start etteum-searxng 2>$null | Out-Null
        Info "Existing etteum-searxng container started."
    } else {
        docker run -d --name etteum-searxng -p 8080:8080 -e SEARXNG_BASE_URL=http://localhost:8080/ searxng/searxng:latest 2>$null | Out-Null
        Info "SearXNG container started on http://localhost:8080"
        Start-Sleep -Seconds 2
        # Enable JSON output format (default SearXNG disables it).
        docker exec etteum-searxng sh -c "sed -i 's/^ \( *\)formats: \[.*\]$/\1formats: [html, json]/' /etc/searxng/settings.yml" 2>$null | Out-Null
        docker restart etteum-searxng 2>$null | Out-Null
    }

    # Write SEARXNG_URL into .env if absent.
    $envFile = Join-Path $script:ProjectDir ".env"
    if (-not (Select-String -Path $envFile -Pattern '^SEARXNG_URL=' -Quiet -ErrorAction SilentlyContinue)) {
        Add-Content -Path $envFile -Value "SEARXNG_URL=http://localhost:8080"
        Info "Added SEARXNG_URL=http://localhost:8080 to .env"
    }
    Info "Run 'etteum doctor' to verify SearXNG is reachable."
}

function Main {
    Write-Host ""
    Write-Host "Etteum Pool Installer (Windows)" -ForegroundColor Blue
    Write-Host ""

    Show-Summary

    Ensure-PackageManager
    Ensure-Git
    Ensure-Bun
    Ensure-Python
    Clone-Or-Update-Repo

    Set-Location $script:ProjectDir
    Write-EnvIfMissing
    Install-NodeDeps
    Setup-PythonVenv
    Build-Dashboard
    Run-Migrations
    Install-CliShims
    Setup-SearXNG
    Run-Preflight

    Write-Host ""
    Write-Host "✓ Installation complete!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Etteum Pool is installed at: $($script:ProjectDir)"
    Write-Host ""

    Write-Host "Quick Start:" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host ""
    Write-Host "  1. Start the server:" -ForegroundColor Cyan
    Write-Host "     etteum start"
    Write-Host "     (or: cd $($script:ProjectDir); .\etteum.ps1 start)"
    Write-Host ""
    Write-Host "  2. Open the dashboard:" -ForegroundColor Cyan
    Write-Host "     http://localhost:1931"
    Write-Host ""
    Write-Host "  3. Add accounts via the dashboard UI"
    Write-Host ""

    Write-Host "Useful Commands:" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host ""
    Write-Host "  etteum status     Check server status"
    Write-Host "  etteum logs       View server logs"
    Write-Host "  etteum stop       Stop the server"
    Write-Host "  etteum restart    Restart the server"
    Write-Host "  etteum doctor     Diagnose installation health"
    Write-Host "  etteum update     Pull latest, rebuild, restart"
    Write-Host "  etteum help       Full command reference"
    Write-Host ""

    Write-Host "Tip: re-run this installer any time to pull updates and rebuild." -ForegroundColor Gray
    Write-Host "Tip: trouble? run `etteum doctor` to get a checklist of fixes." -ForegroundColor Gray
}

Main
