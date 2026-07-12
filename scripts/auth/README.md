# Browser login (Camoufox)

Python Camoufox adapters for providers that require a real browser login
(Google OAuth / SSO). The TypeScript server spawns `camoufox_flow.py` over stdio.

## Setup

```bash
python -m pip install -r scripts/auth/requirements.txt
python -m camoufox fetch   # download browser binary once
```

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
