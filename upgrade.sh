#!/usr/bin/env bash
# Etteum Pool Upgrader for Linux and macOS.
#
# Safely upgrades the installation: backs up the database, pulls latest code,
# rebuilds, and restores if anything fails.
#
# Usage:
#   bash upgrade.sh
#
# Environment variables (all optional):
#   ETTEUM_HOME          Install directory (default: ~/etteum-pool)
#   ETTEUM_YES=1         Skip confirmation (CI / unattended)
#   ETTEUM_BRANCH        Branch to pull (default: current branch)

set -euo pipefail

INSTALL_DIR_DEFAULT="${ETTEUM_HOME:-$HOME/etteum-pool}"
ASSUME_YES="${ETTEUM_YES:-0}"
BRANCH="${ETTEUM_BRANCH:-}"

C_RESET='\033[0m'
C_BOLD='\033[1m'
C_RED='\033[31m'
C_GREEN='\033[32m'
C_YELLOW='\033[33m'
C_CYAN='\033[36m'

step()  { printf "${C_CYAN}==>${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$*"; }
info()  { printf "    %s\n" "$*"; }
warn()  { printf "${C_YELLOW}!!${C_RESET}  %s\n" "$*"; }
err()   { printf "${C_RED}xx${C_RESET}  %s\n" "$*" 1>&2; exit 1; }
ok()    { printf "${C_GREEN}ok${C_RESET}  %s\n" "$*"; }

confirm_action() {
  if [[ "$ASSUME_YES" == "1" ]]; then
    info "$1"
    return 0
  fi
  printf "%s [y/N] " "$1"
  read -r answer
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

# ── Main ──────────────────────────────────────────────────────────────

printf "\n${C_BOLD}${C_CYAN}Etteum Pool — Upgrader${C_RESET}  ${C_DIM}(%s)${C_RESET}\n\n" "$(uname -s)"

if [[ ! -d "$INSTALL_DIR_DEFAULT" ]]; then
  err "Directory not found: $INSTALL_DIR_DEFAULT — run the installer first."
fi

PROJECT_DIR="$INSTALL_DIR_DEFAULT"
cd "$PROJECT_DIR"

# 1. Check prerequisites
step "Checking prerequisites..."
if ! command -v git &>/dev/null; then
  err "git not found in PATH"
fi
if ! command -v bun &>/dev/null; then
  err "bun not found in PATH — reinstall Bun"
fi
ok "Prerequisites OK"

# 2. Stop server if running
step "Stopping server..."
PID_FILE="$PROJECT_DIR/.etteum.pid"
SERVER_WAS_RUNNING=false
if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 2
    SERVER_WAS_RUNNING=true
    ok "Stopped server (PID $PID)"
  else
    info "No running server (stale PID file)"
  fi
  rm -f "$PID_FILE"
else
  info "No PID file found"
fi

# 3. Backup database
step "Backing up database..."
DB_FILE="$PROJECT_DIR/data/poolprox3.db"
BACKUP_DIR="$PROJECT_DIR/backups"
mkdir -p "$BACKUP_DIR"

if [[ -f "$DB_FILE" ]]; then
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  BACKUP_FILE="$BACKUP_DIR/poolprox3-$TIMESTAMP.db"
  cp "$DB_FILE" "$BACKUP_FILE"
  ok "Backed up to $BACKUP_FILE"

  # Also backup WAL/SHM if they exist
  for ext in -shm -wal; do
    if [[ -f "$DB_FILE$ext" ]]; then
      cp "$DB_FILE$ext" "$BACKUP_FILE$ext"
    fi
  done

  # Prune old backups (keep last 5)
  cd "$BACKUP_DIR"
  ls -t poolprox3-*.db 2>/dev/null | tail -n +6 | while read -r old_backup; do
    rm -f "$old_backup" "${old_backup}-shm" "${old_backup}-wal"
  done
  cd "$PROJECT_DIR"
else
  info "No database file to backup"
fi

# 4. Git pull
step "Pulling latest code..."
if [[ -n "$BRANCH" ]]; then
  git pull origin "$BRANCH" --ff-only || {
    warn "git pull failed, trying rebase..."
    git pull --rebase || err "git pull/rebase failed. Resolve conflicts manually."
  }
else
  git pull --ff-only || {
    warn "git pull failed, trying rebase..."
    git pull --rebase || err "git pull/rebase failed. Resolve conflicts manually."
  }
fi
ok "Code updated"

# 5. Install dependencies (only if package.json changed)
step "Checking dependencies..."
PKG_CHANGED=false
if [ -f package.json ]; then
  PKG_MTIME=$(stat -c%Y package.json 2>/dev/null || stat -f%m package.json 2>/dev/null || echo 0)
  LOCK_MTIME=$(stat -c%Y node_modules/.package-lock.json 2>/dev/null || stat -f%m node_modules/.package-lock.json 2>/dev/null || echo 0)
  if [ "$PKG_MTIME" -gt "$LOCK_MTIME" ]; then
    PKG_CHANGED=true
  fi
fi

if [ "$PKG_CHANGED" = "true" ]; then
  info "package.json changed — reinstalling dependencies..."
  if ! bun install; then
    err "bun install failed"
  fi
  (cd dashboard && bun install) || err "dashboard bun install failed"
  ok "Dependencies installed"
else
  ok "Dependencies up to date — skipping install"
fi

# 6. Build dashboard (only if source changed)
step "Checking dashboard build..."
DASH_CHANGED=false
if [ -d dashboard/src ]; then
  # Check if any dashboard source file is newer than the build output
  if [ -f dashboard/dist/index.html ]; then
    BUILD_MTIME=$(stat -c%Y dashboard/dist/index.html 2>/dev/null || stat -f%m dashboard/dist/index.html 2>/dev/null || echo 0)
    # Find newest source file
    NEWEST_SRC=$(find dashboard/src -type f -newer dashboard/dist/index.html 2>/dev/null | head -1)
    if [ -n "$NEWEST_SRC" ]; then
      DASH_CHANGED=true
    fi
  else
    DASH_CHANGED=true
  fi
else
  DASH_CHANGED=true
fi

if [ "$DASH_CHANGED" = "true" ]; then
  info "Dashboard source changed — rebuilding..."
  cd "$PROJECT_DIR/dashboard"
  if ! bun run build; then
    warn "Dashboard build failed — rolling back..."
    cd "$PROJECT_DIR"
    git checkout -- . 2>/dev/null || true
    err "Dashboard build failed. Check dashboard/ for errors."
  fi
  cd "$PROJECT_DIR"
  ok "Dashboard built"
else
  ok "Dashboard up to date — skipping build"
fi

# 7. Run migrations
step "Running migrations..."
if ! bun run migrate; then
  warn "Migration failed — database backup is at: $BACKUP_DIR"
  err "Migration failed. Restore from backup if needed."
fi
ok "Migrations complete"

# 8. Rebuild Python venv (if needed)
step "Checking Python venv..."
VENV_PY="$PROJECT_DIR/scripts/auth/.venv/bin/python"
if [[ ! -f "$VENV_PY" ]]; then
  info "Rebuilding Python venv..."
  python3 -m venv "$PROJECT_DIR/scripts/auth/.venv" || err "Failed to create venv"
  "$VENV_PY" -m pip install --upgrade pip wheel >/dev/null 2>&1 || true
  "$VENV_PY" -m pip install -r "$PROJECT_DIR/scripts/auth/requirements.txt" || err "pip install failed"
  ok "Python venv rebuilt"
else
  ok "Python venv OK"
fi

# 9. Restart server if it was running
if [[ "$SERVER_WAS_RUNNING" == "true" ]]; then
  step "Restarting server..."
  nohup bun scripts/production.ts > "$PROJECT_DIR/.etteum.log.stdout" 2> "$PROJECT_DIR/.etteum.log.stderr" &
  echo $! > "$PID_FILE"
  ok "Server restarted (PID $!)"
fi

printf "\n${C_GREEN}${C_BOLD}ok  Upgrade complete!${C_RESET}\n\n"
printf "Database backup: ${C_BOLD}%s${C_RESET}\n" "$BACKUP_DIR"
printf "To rollback: ${C_CYAN}git checkout <previous-commit> && bun run migrate${C_RESET}\n\n"
