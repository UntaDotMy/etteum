# Etteum Pool

**AI Proxy Pool** — Load balancing, auto-warmup, credit tracking, and model-aware routing across multiple AI providers.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun)](https://bun.sh)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](https://python.org)

---

## ⚡ Quick Start

### Linux / macOS / WSL

```bash
git clone https://github.com/UntaDotMy/etteum.git ~/etteum-pool
cd ~/etteum-pool
bash install.sh
```

### Windows (PowerShell)

```powershell
git clone https://github.com/UntaDotMy/etteum.git $HOME\etteum-pool
cd $HOME\etteum-pool
powershell -ExecutionPolicy Bypass -File install.ps1
```

### Then start the server

```bash
etteum start
```

Open the dashboard at **http://localhost:1931** and you're done.

> ** Bun 1.3.14 warning:** This version has known issues. The installer detects it and automatically upgrades to canary via `bun upgrade --canary`.

> **Tip:** the installer is fully idempotent — re-run it any time to pull updates and rebuild.

---

## What the installer does

The installer takes you from a clean machine to a running proxy in one shot:

1. ✅ Installs **Git, Bun, Python 3.10+** (via your distro's package manager)
2. ✅ Auto-upgrades Bun **1.3.14** → canary via `bun upgrade --canary`
3. ✅ Clones the repo to `~/etteum-pool` (or `$ETTEUM_HOME`)
4. ✅ Generates a random `ENCRYPTION_KEY` and a fresh `API_KEY` in `.env`
5. ✅ Installs JS deps (root + dashboard) via Bun
6. ✅ Creates a Python venv and installs requirements
7. ✅ Downloads **Playwright Chromium** + **Camoufox** browsers
8. ✅ Builds the dashboard for production
9. ✅ Runs database migrations
10. ✅ Symlinks the `etteum` CLI into `~/.local/bin`
11. ✅ Runs a **preflight check** — every step is verified before exiting

### Supported OS

| OS                 | Status     |
|--------------------|------------|
| Ubuntu / Debian    | ✅ Tested  |
| Fedora / RHEL      | ✅ Tested  |
| Arch / Manjaro     | ✅ Tested  |
| openSUSE           | ✅ Tested  |
| Alpine             | ✅ Tested  |
| WSL                | ✅ Works   |
| macOS              | ✅ Tested  |
| Windows 10/11      | ✅ Tested  |

### Environment variables

All optional. Set before running for unattended installs.

| Variable               | Default            | Purpose                              |
|------------------------|--------------------|--------------------------------------|
| `ETTEUM_HOME`          | `~/etteum-pool`    | Install directory                    |
| `ETTEUM_BRANCH`        | `main`             | Branch to clone                      |
| `ETTEUM_YES`           | unset              | `=1` skips confirmation prompts      |
| `ETTEUM_NO_CLI`        | unset              | `=1` skips the CLI symlink           |
| `ETTEUM_SKIP_BROWSERS` | unset              | `=1` skips browser downloads         |

---

## CLI Commands

```bash
# Server
etteum start              # Start backend + dashboard in background
etteum stop               # Stop this instance
etteum restart            # Stop + start
etteum status             # PID, ports, listening state
etteum dev                # Foreground with HMR

# Logs & maintenance
etteum logs               # Tail logs (follow)
etteum logs 100           # Print last 100 lines
etteum build              # Rebuild dashboard and restart
etteum migrate            # Run DB migrations
etteum doctor             # Diagnose installation health
etteum doctor --json      # Same, machine-readable
etteum preflight          # Quick smoke test

# Configuration
etteum port 8080 8081     # Change ports
etteum update             # Pull latest, rebuild, restart

# Help
etteum help               # Full command reference
```

> **Windows:** if `etteum` isn't recognised, use `.\etteum.ps1 <cmd>` from the install dir.

---

## Lifecycle Management

### Upgrading

```bash
# Linux/macOS
bash upgrade.sh

# Windows
powershell -ExecutionPolicy Bypass -File upgrade.ps1
```

The upgrade script backs up the database, pulls latest code, rebuilds, runs migrations, and restarts.

### Uninstalling

```bash
# Linux/macOS
bash uninstall.sh

# Windows
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

Removes CLI shims, Python venv, node_modules, build artifacts, and logs. Database is kept by default.

### Running as a Service

**Linux (systemd):**
```bash
bash service/install-service.sh
journalctl -u etteum -f
```

**macOS (launchd):**
```bash
bash service/install-service.sh
tail -f ~/etteum-pool/logs/etteum.log
```

**Windows (NSSM):**
```powershell
powershell -ExecutionPolicy Bypass -File service/install-service.ps1
```

---

## Features

- **Model-aware routing** — Accounts are filtered by which models they can actually query
- **Aggregated quotas** — Dashboard shows total tokens available per model across all eligible accounts
- **Auto-warmup** — Periodic health checks keep accounts fresh; new accounts are verified immediately
- **Thinking model support** — Proper configuration for models with extended reasoning
- **Web search shim** — Local search tool so clients get results through any upstream
- **Log rotation** — Automatic rotation when logs exceed 10MB
- **Secret masking** — API keys are masked in logs
- **Multi-provider** — Supports session-based, API key, PAT, and OAuth auth methods
- **Load balancing** — Round-robin, sequential, and least-inflight strategies
- **Proxy pool** — Route traffic through proxies for geo-restricted providers

---

## Configuration

The installer creates `.env` with sensible defaults.

```bash
PORT=1930                    # API port
DASHBOARD_PORT=1931          # Dashboard port
API_KEY=...                  # Auto-generated; clients send as Bearer
ENCRYPTION_KEY=...           # Auto-generated; encrypts stored tokens
DATABASE_PATH=./data/poolprox3.db
BROWSER_ENGINE=camoufox      # or chromium
HEADLESS=true
```

| Variable          | Default              | Description                         |
|-------------------|----------------------|-------------------------------------|
| `PORT`            | `1930`               | Backend API port                    |
| `DASHBOARD_PORT`  | `1931`               | Dashboard web UI port               |
| `API_KEY`         | auto-generated       | API auth                            |
| `ENCRYPTION_KEY`  | auto-generated       | Encrypts saved tokens               |
| `DATABASE_PATH`   | `./data/poolprox3.db`| SQLite database location            |
| `PYTHON_PATH`     | auto-detect          | Override venv Python                |
| `BROWSER_ENGINE`  | `camoufox`           | `camoufox` or `chromium`            |
| `PROXY_URL`       | empty                | Outbound proxy for the auth bot     |

---

## API

OpenAI-compatible.

```bash
# List models
curl http://localhost:1930/v1/models \
  -H "Authorization: Bearer $API_KEY"

# Chat completions
curl http://localhost:1930/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Health check (no auth required)
curl http://localhost:1930/api/health
```

### Health Endpoint

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "uptimeHuman": "1h",
  "timestamp": "2026-07-02T12:00:00Z",
  "memory": { "rss": "128MB", "heap": "64MB" },
  "platform": "linux",
  "node": "v22.0.0"
}
```

---

## Troubleshooting

**First step:** run `etteum doctor`.

```bash
etteum doctor
```

### Common fixes

<details>
<summary><b>Playwright / Camoufox not installed</b></summary>

```bash
scripts/auth/.venv/bin/python -m playwright install chromium
scripts/auth/.venv/bin/python -m camoufox fetch
```
</details>

<details>
<summary><b>Port already in use</b></summary>

```bash
etteum port 8080 8081
```
</details>

<details>
<summary><b>Bun 1.3.14 detected</b></summary>

```bash
bun upgrade --canary
```
</details>

<details>
<summary><b>"bun: command not found"</b></summary>

```bash
export PATH="$HOME/.bun/bin:$PATH"
```
</details>

<details>
<summary><b>Behind a corporate proxy</b></summary>

```bash
export HTTPS_PROXY=http://user:pass@proxy:port
export HTTP_PROXY=$HTTPS_PROXY
bash install.sh
```
</details>

<details>
<summary><b>"No active accounts available for model"</b></summary>

Run warmup to populate model access data:

```bash
etteum doctor --fix
```
</details>

---

## Development

```bash
# Backend with hot reload
bun run dev

# Dashboard with HMR (separate terminal)
cd dashboard && bun run dev
```

### Project structure

```
etteum-pool/
├── src/                  # Backend (Hono + Bun)
│   ├── api/              # API routes
│   ├── auth/             # Login automation & warmup
│   ├── db/               # Schema & migrations
│   ├── proxy/            # Provider implementations
│   ├── utils/            # Helpers
│   └── ws/               # WebSocket server
├── dashboard/            # React + Vite + Tailwind
├── scripts/
│   ├── auth/             # Python automation
│   ├── doctor.ts         # Health diagnostic
│   └── production.ts     # Production server
├── service/              # Service templates
├── etteum               # Linux/macOS CLI
├── etteum.ps1           # Windows CLI
├── install.sh           # Linux/macOS installer
├── install.ps1          # Windows installer
├── uninstall.sh         # Linux/macOS uninstaller
├── uninstall.ps1        # Windows uninstaller
├── upgrade.sh           # Linux/macOS upgrader
└── upgrade.ps1          # Windows upgrader
```

---

## License

MIT License.

---

**Modified by [UntaDotMy](https://github.com/UntaDotMy)**
