# Grok farm (vendored into etteum)

Port of `refer/grok-farm`. Etteum spawns `farm.py` from **Automation → Grok** with env built from the dashboard form (temp-mail or Gmail/IMAP).

On exit, etteum imports `results/batch_*/accounts.json` into the **Grok** provider (`auth_method: oauth` + absolute free Build credits when present).

## Layout (from refer)

| File | Role |
|------|------|
| `farm.py` | Main farmer (signup / tempmail / refresh) |
| `farm_helpers.py` | Pure helpers (proxy, OTP, JWT, batch meta) — unit-tested |
| `requirements.txt` | Farm deps (also covered by `scripts/auth/requirements.txt`) |
| `.env.example` | Standalone env knobs |
| `tests/` | `unittest` for helpers |

## Python / Camoufox — use etteum’s env (no separate farm venv)

Farm reuses the same interpreter as other auth scripts:

| Priority | Source |
|----------|--------|
| 1 | `config.pythonPath` → `scripts/auth/.venv` |
| 2 | `PYTHON_PATH` / `ETTEUM_PYTHON` / `BATCHER_PYTHON` |
| 3 | System Python that already has `camoufox` + `playwright` |

Deps are listed in **`scripts/auth/requirements.txt`** (includes `camoufox[geoip]` + `playwright` + `browserforge`). Farm-local `requirements.txt` matches refer.

```bash
# from repo root — one env for all Python auth (including farm)
python -m venv scripts/auth/.venv
# Windows:
scripts\auth\.venv\Scripts\python.exe -m pip install -r scripts/auth/requirements.txt
# Linux/macOS:
scripts/auth/.venv/bin/python -m pip install -r scripts/auth/requirements.txt
```

Do **not** create `scripts/auth/grok-farm/.venv`. Prefer `bun scripts/doctor.ts --fix` to heal the shared env.

Optional SOCKS for CLI probe / token exchange (browser already supports SOCKS):

```bash
pip install PySocks
```

## Headless multi-worker frames (Bot Logs)

When run from etteum, env sets `GROK_HEADLESS=true` and `ETTEUM_FRAME_RELAY=true`. Each worker emits:

- `ETTEUM_JSON:{"type":"frame","workerId":N,"email":"...","base64":"..."}`
- `ETTEUM_JSON:{"type":"progress","workerId":N,"step":"...","message":"..."}`
- `ETTEUM_JSON:{"type":"worker_start"|"worker_done",...}`

Etteum registers `grok-farm-*-wN` sessions so concurrency 3 → 3 live previews.  
(`ETTEUM_*` hooks live only in this vendored copy — not in bare `refer/`.)

Optional `proxies.txt` next to `farm.py` (see `proxies.txt.example`).

## Manual run (debug)

```bash
# use the etteum auth venv
scripts/auth/.venv/Scripts/python.exe farm.py -m tempmail -n 2 -c 1 -y
scripts/auth/.venv/Scripts/python.exe farm.py --diagnose
python -m unittest discover -s scripts/auth/grok-farm/tests -v
```

See `refer/grok-farm/README.md` for full CLI / env reference (HEADLESS_MODE, HUMANIZE, probe retries, etc.).
