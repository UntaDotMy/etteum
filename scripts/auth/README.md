# Browser login (Camoufox)

Python Camoufox adapters for providers that require a real browser login
(Google OAuth / SSO). The TypeScript server spawns `camoufox_flow.py` over stdio.

## Setup (shared env for provider login **and** farms)

One Python venv only: `scripts/auth/.venv`. Do **not** create per-farm venvs.

```bash
# preferred self-heal
bun scripts/doctor.ts --fix

# or manually
python -m venv scripts/auth/.venv
# Windows:
scripts\auth\.venv\Scripts\python.exe -m pip install -r scripts/auth/requirements.txt
scripts\auth\.venv\Scripts\python.exe -m camoufox fetch
# Linux/macOS:
scripts/auth/.venv/bin/python -m pip install -r scripts/auth/requirements.txt
scripts/auth/.venv/bin/python -m camoufox fetch
```

Installers keep `camoufox[geoip]` + Playwright and remove legacy `nodriver`.

Optional env:

| Variable | Default | Meaning |
|----------|---------|---------|
| `ETTEUM_PYTHON` | PATH / `py -3` | Interpreter path |
| `BATCHER_ENABLE_CAMOUFOX` | `true` | Must stay true for real logins |
| `BATCHER_CAMOUFOX_HEADLESS` | `true` | `false` = visible browser |
| `BATCHER_PROXY_URL` | unset | Proxy for browser session |
| `BATCHER_CAPTCHA_MODE` | `skip` | `handle` waits for manual input |

## Supported providers

- `kiro` / `kiro-pro`
- `codebuddy`

Codex and other OAuth providers use the TypeScript automation services path.

## Protocol

Line-delimited JSON on stdin/stdout. See the header of `camoufox_flow.py`.
