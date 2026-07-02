#!/usr/bin/env bash
# Etteum Pool Uninstaller for Linux and macOS.
#
# Removes CLI shims, Python venv, node_modules, and optionally the database.
# Does NOT remove the project directory itself (you can re-install into it).
#
# Usage:
#   bash uninstall.sh
#
# Environment variables (all optional):
#   ETTEUM_HOME          Install directory (default: ~/etteum-pool)
#   ETTEUM_YES=1         Skip confirmation (CI / unattended)
#   ETTEUM_KEEP_DATA=1   Keep the database file (default: keep)
#   ETTEUM_REMOVE_DATA=1 Also remove the database file

set -euo pipefail

INSTALL_DIR_DEFAULT="${ETTEUM_HOME:-$HOME/etteum-pool}"
ASSUME_YES="${ETTEUM_YES:-0}"
KEEP_DATA="${ETTEUM_REMOVE_DATA:-0}"

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

printf "\n${C_BOLD}${C_RED}Etteum Pool — Uninstaller${C_RESET}  ${C_DIM}(%s)${C_RESET}\n\n" "$(uname -s)"

if [[ ! -d "$INSTALL_DIR_DEFAULT" ]]; then
  warn "Directory not found: $INSTALL_DIR_DEFAULT"
  info "Nothing to uninstall."
  exit 0
fi

PROJECT_DIR="$INSTALL_DIR_DEFAULT"

# 1. Stop running server
step "Stopping server..."
PID_FILE="$PROJECT_DIR/.etteum.pid"
if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 2
    kill -9 "$PID" 2>/dev/null || true
    ok "Stopped server (PID $PID)"
  else
    info "No running server found (stale PID file)"
  fi
  rm -f "$PID_FILE"
else
  info "No PID file found"
fi

# 2. Remove CLI shims
step "Removing CLI shims..."
LOCAL_BIN="$HOME/.local/bin"
SHIMS_REMOVED=0
for shim in etteum etteum.ps1 etteum.cmd; do
  if [[ -L "$LOCAL_BIN/$shim" || -f "$LOCAL_BIN/$shim" ]]; then
    rm -f "$LOCAL_BIN/$shim"
    ((SHIMS_REMOVED++))
  fi
done
ok "Removed $SHIMS_REMOVED CLI shim(s) from $LOCAL_BIN"

# 3. Remove Python venv
step "Removing Python venv..."
VENV_PATH="$PROJECT_DIR/scripts/auth/.venv"
if [[ -d "$VENV_PATH" ]]; then
  rm -rf "$VENV_PATH"
  ok "Removed $VENV_PATH"
else
  info "No venv found"
fi

# 4. Remove node_modules
step "Removing node_modules..."
NM_COUNT=0
if [[ -d "$PROJECT_DIR/node_modules" ]]; then
  rm -rf "$PROJECT_DIR/node_modules"
  ((NM_COUNT++))
fi
if [[ -d "$PROJECT_DIR/dashboard/node_modules" ]]; then
  rm -rf "$PROJECT_DIR/dashboard/node_modules"
  ((NM_COUNT++))
fi
ok "Removed $NM_COUNT node_modules directory(ies)"

# 5. Remove dashboard dist
step "Removing dashboard build..."
DIST_PATH="$PROJECT_DIR/dashboard/dist"
if [[ -d "$DIST_PATH" ]]; then
  rm -rf "$DIST_PATH"
  ok "Removed $DIST_PATH"
else
  info "No dist found"
fi

# 6. Remove log files
step "Removing log files..."
LOG_COUNT=0
for log_file in .etteum.log .etteum.log.stdout .etteum.log.stderr .aiproxy.log .etteum.pid; do
  if [[ -f "$PROJECT_DIR/$log_file" ]]; then
    rm -f "$PROJECT_DIR/$log_file"
    ((LOG_COUNT++))
  fi
done
ok "Removed $LOG_COUNT log file(s)"

# 7. Database — optional
if [[ "$KEEP_DATA" == "0" ]]; then
  info "Keeping database file (data/poolprox3.db)"
else
  step "Removing database..."
  DB_COUNT=0
  for db_file in data/poolprox3.db data/poolprox3.db-shm data/poolprox3.db-wal; do
    if [[ -f "$PROJECT_DIR/$db_file" ]]; then
      rm -f "$PROJECT_DIR/$db_file"
      ((DB_COUNT++))
    fi
  done
  ok "Removed $DB_COUNT database file(s)"
fi

# 8. .env — keep by default (contains user's API key)
info "Keeping .env file (contains your API key and settings)"
info "Delete it manually if you want a full clean: rm $PROJECT_DIR/.env"

printf "\n${C_GREEN}${C_BOLD}ok  Uninstall complete!${C_RESET}\n\n"
printf "The project directory still exists at: ${C_BOLD}%s${C_RESET}\n" "$PROJECT_DIR"
printf "To fully remove it: ${C_CYAN}rm -rf '%s'${C_RESET}\n\n" "$PROJECT_DIR"
