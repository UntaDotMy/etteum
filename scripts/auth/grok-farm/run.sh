#!/usr/bin/env bash
# Run the Grok farmer (loads .venv + .env).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Camoufox browser lives under ~/.cache/camoufox — root's copy is incomplete
# and crashes with "Couldn't load XPCOM". Always run as the install user.
if [[ "$(id -u)" -eq 0 ]]; then
  echo "ERROR: jangan jalankan farm sebagai root/sudo."
  echo "  Camoufox root broken (XPCOM). Pakai user biasa, mis.:"
  echo "  su - priyo -c 'cd ~/grok-farm && ./run.sh ...'"
  exit 1
fi

if [[ ! -d .venv ]]; then
  echo "Missing .venv — run ./install.sh first"
  exit 1
fi
# shellcheck disable=SC1091
source .venv/bin/activate

if [[ ! -f .env ]]; then
  echo "Missing .env — cp .env.example .env && edit it"
  exit 1
fi

# If no DISPLAY and headless false, try xvfb-run automatically
HEADLESS="$(grep -E '^GROK_HEADLESS=' .env 2>/dev/null | cut -d= -f2- | tr -d ' \"' | tr '[:upper:]' '[:lower:]' || true)"
if [[ -z "${DISPLAY:-}" && "${HEADLESS}" != "true" && "${HEADLESS}" != "1" ]]; then
  if command -v xvfb-run >/dev/null 2>&1; then
    echo "[run] No DISPLAY — using xvfb-run"
    exec xvfb-run -a python farm.py "$@"
  fi
  echo "[run] WARN: no DISPLAY and GROK_HEADLESS!=true — Turnstile may fail"
fi

exec python farm.py "$@"
