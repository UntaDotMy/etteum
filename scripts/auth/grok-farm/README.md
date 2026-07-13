# Grok farm (vendored into etteum)

Port of the standalone `grok-farm` CLI. Etteum spawns `farm.py` from **Automation → Grok** with env built from the dashboard form (temp-mail or Gmail/IMAP).

On exit, etteum imports `results/batch_*/accounts.json` into the **Grok** provider (`auth_method: oauth` + absolute free Build credits when present).

## Python / Camoufox — use etteum’s env (no separate farm venv)

Farm reuses the same interpreter as other auth scripts:

| Priority | Source |
|----------|--------|
| 1 | `config.pythonPath` → `scripts/auth/.venv` |
| 2 | `PYTHON_PATH` / `ETTEUM_PYTHON` / `BATCHER_PYTHON` |
| 3 | System Python that already has `camoufox` + `playwright` |

Deps are listed in **`scripts/auth/requirements.txt`** (already includes `camoufox[geoip]` + `playwright`).

```bash
# from repo root — one env for all Python auth (including farm)
python -m venv scripts/auth/.venv
# Windows:
scripts\auth\.venv\Scripts\python.exe -m pip install -r scripts/auth/requirements.txt
# Linux/macOS:
scripts/auth/.venv/bin/python -m pip install -r scripts/auth/requirements.txt
```

Do **not** create `scripts/auth/grok-farm/.venv`. Prefer `bun scripts/doctor.ts --fix` to heal the shared env.

### Headless multi-worker frames (Bot Logs)

When run from etteum, env sets `GROK_HEADLESS=true` and `ETTEUM_FRAME_RELAY=true`. Each worker emits:

- `ETTEUM_JSON:{"type":"frame","workerId":N,"email":"...","base64":"..."}`
- `ETTEUM_JSON:{"type":"progress","workerId":N,"step":"...","message":"..."}`

Etteum registers `grok-farm-*-wN` sessions so concurrency 3 → 3 live previews.

Optional `proxies.txt` next to `farm.py` (see `proxies.txt.example`).

## Manual run (debug)

```bash
# use the etteum auth venv
scripts/auth/.venv/Scripts/python.exe farm.py -m tempmail -n 2 -c 1 -y
```
