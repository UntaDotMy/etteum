# Grok farm (vendored into etteum)

Port of the standalone `grok-farm` CLI. Etteum spawns `farm.py` from **Automation → Grok** with env built from the dashboard form (temp-mail or Gmail/IMAP).

On exit, etteum imports `results/batch_*/accounts.json` into the **Grok** provider (`auth_method: oauth` + absolute free Build credits when present).

## Setup

```bash
cd scripts/auth/grok-farm
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r requirements.txt
# Camoufox browser binary may need a first-run download
```

Point etteum at this Python if needed:

```bash
set ETTEUM_PYTHON=C:\path\to\python.exe
```

Optional `proxies.txt` next to `farm.py` (see `proxies.txt.example`).

## Manual run (debug)

```bash
python farm.py -m tempmail -n 2 -c 1 -y
# or Gmail/IMAP (requires env vars from .env.example)
python farm.py -m google -n 2 -c 1 -y
```
