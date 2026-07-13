#!/usr/bin/env bash
# Install Grok standalone farmer on a fresh VPS (Debian/Ubuntu/similar).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "=============================================="
echo "  Grok Farm — installer"
echo "  dir: $ROOT"
echo "=============================================="

# ── System deps ──────────────────────────────────────────────────────────────
if command -v apt-get >/dev/null 2>&1; then
  echo "[1/5] apt packages..."
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    python3 python3-venv python3-pip \
    curl ca-certificates \
    libgtk-3-0 libx11-xcb1 libasound2t64 libasound2 libdbus-glib-1-2 \
    libxt6 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    fonts-liberation xvfb 2>/dev/null \
    || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
      python3 python3-venv python3-pip curl ca-certificates \
      libgtk-3-0 libx11-xcb1 libasound2 libdbus-glib-1-2 \
      libxt6 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
      fonts-liberation xvfb
elif command -v dnf >/dev/null 2>&1; then
  echo "[1/5] dnf packages..."
  sudo dnf install -y python3 python3-pip curl ca-certificates \
    gtk3 xorg-x11-server-Xvfb alsa-lib || true
else
  echo "[1/5] Skipping system packages (no apt/dnf). Ensure python3 + GUI libs exist."
fi

# ── venv ─────────────────────────────────────────────────────────────────────
echo "[2/5] Python venv..."
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -U pip wheel setuptools
pip install -r requirements.txt

# ── Camoufox browser binary ──────────────────────────────────────────────────
echo "[3/5] Camoufox browser fetch..."
python -m camoufox fetch || {
  echo "WARN: camoufox fetch failed — retry: source .venv/bin/activate && python -m camoufox fetch"
}

# ── .env ─────────────────────────────────────────────────────────────────────
echo "[4/5] Config..."
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "  Created .env from .env.example — EDIT IT before farming."
else
  echo "  .env already exists (kept)."
fi
mkdir -p results screenshots

# ── Sanity ───────────────────────────────────────────────────────────────────
echo "[5/5] Sanity check..."
python - <<'PY'
import importlib
for m in ("camoufox", "dotenv"):
    try:
        importlib.import_module(m if m != "dotenv" else "dotenv")
        print(f"  OK {m}")
    except Exception as e:
        print(f"  FAIL {m}: {e}")
        raise SystemExit(1)
print("  install OK")
PY

chmod +x run.sh install.sh 2>/dev/null || true

echo
echo "=============================================="
echo "  Install complete."
echo
echo "  Next:"
echo "    1) nano .env          # set IMAP + domain"
echo "    2) ./run.sh           # start farm (CLI)"
echo
echo "  Headless VPS without display:"
echo "    GROK_HEADLESS=true in .env"
echo "    or: xvfb-run -a ./run.sh"
echo
echo "  Results:"
echo "    results/accounts.json"
echo "    results/accounts.txt   # email|password|access|refresh|expires"
echo "=============================================="
