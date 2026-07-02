#!/usr/bin/env bash
# Etteum Pool — Linux/macOS Service Installer
#
# Installs Etteum as a system service.
# - Linux: systemd
# - macOS: launchd
#
# Usage:
#   bash service/install-service.sh
#
# To uninstall:
#   Linux:   sudo systemctl disable --now etteum && sudo rm /etc/systemd/system/etteum.service
#   macOS:   launchctl unload ~/Library/LaunchAgents/com.etteum.pool.plist && rm ~/Library/LaunchAgents/com.etteum.pool.plist

set -euo pipefail

PROJECT_DIR="${ETTEUM_HOME:-$HOME/etteum-pool}"
OS="$(uname -s)"

C_RESET='\033[0m'
C_BOLD='\033[1m'
C_RED='\033[31m'
C_GREEN='\033[32m'
C_CYAN='\033[36m'

step()  { printf "${C_CYAN}==>${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$*"; }
info()  { printf "    %s\n" "$*"; }
ok()    { printf "${C_GREEN}ok${C_RESET}  %s\n" "$*"; }
err()   { printf "${C_RED}xx${C_RESET}  %s\n" "$*" 1>&2; exit 1; }

# ── Linux (systemd) ──────────────────────────────────────────────────

install_systemd() {
  if ! command -v systemctl &>/dev/null; then
    err "systemctl not found — is systemd installed?"
  fi

  step "Installing Etteum as systemd service..."

  SERVICE_FILE="/etc/systemd/system/etteum.service"
  TEMPLATE_FILE="$PROJECT_DIR/service/etteum.service"

  if [[ ! -f "$TEMPLATE_FILE" ]]; then
    err "Service template not found: $TEMPLATE_FILE"
  fi

  # Replace %I with current user and %h with home directory
  sed "s|%I|$USER|g; s|%h|$HOME|g" "$TEMPLATE_FILE" | sudo tee "$SERVICE_FILE" > /dev/null

  # Reload systemd
  sudo systemctl daemon-reload

  # Enable and start service
  sudo systemctl enable etteum
  sudo systemctl start etteum

  ok "Service installed and started"
  printf "\n"
  printf "Service name: ${C_BOLD}etteum${C_RESET}\n"
  printf "Logs: ${C_CYAN}journalctl -u etteum -f${C_RESET}\n"
  printf "\n"
  printf "Commands:\n"
  printf "  ${C_CYAN}sudo systemctl stop etteum${C_RESET}\n"
  printf "  ${C_CYAN}sudo systemctl start etteum${C_RESET}\n"
  printf "  ${C_CYAN}sudo systemctl restart etteum${C_RESET}\n"
  printf "  ${C_CYAN}sudo systemctl disable --now etteum${C_RESET}  (uninstall)\n"
  printf "\n"
}

# ─ macOS (launchd) ───────────────────────────────────────────────────

install_launchd() {
  step "Installing Etteum as launchd service..."

  PLIST_FILE="$HOME/Library/LaunchAgents/com.etteum.pool.plist"
  TEMPLATE_FILE="$PROJECT_DIR/service/etteum.plist"
  LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

  if [[ ! -f "$TEMPLATE_FILE" ]]; then
    err "Service template not found: $TEMPLATE_FILE"
  fi

  mkdir -p "$LAUNCH_AGENTS_DIR"

  # Replace %USER% with actual username
  sed "s|%USER%|$USER|g" "$TEMPLATE_FILE" > "$PLIST_FILE"

  # Load the service
  launchctl unload "$PLIST_FILE" 2>/dev/null || true
  launchctl load -w "$PLIST_FILE"

  ok "Service installed and started"
  printf "\n"
  printf "Service label: ${C_BOLD}com.etteum.pool${C_RESET}\n"
  printf "Logs: ${C_CYAN}tail -f $PROJECT_DIR/logs/etteum.log${C_RESET}\n"
  printf "\n"
  printf "Commands:\n"
  printf "  ${C_CYAN}launchctl unload -w %s${C_RESET}  (stop)\n" "$PLIST_FILE"
  printf "  ${C_CYAN}launchctl load -w %s${C_RESET}    (start)\n" "$PLIST_FILE"
  printf "  ${C_CYAN}rm %s${C_RESET}                   (uninstall)\n" "$PLIST_FILE"
  printf "\n"
}

# ── Main ──────────────────────────────────────────────────────────────

printf "\n${C_BOLD}${C_CYAN}Etteum Pool — Service Installer${C_RESET}  ${C_DIM}(%s)${C_RESET}\n\n" "$OS"

if [[ ! -d "$PROJECT_DIR" ]]; then
  err "Directory not found: $PROJECT_DIR — run the installer first."
fi

case "$OS" in
  Linux)
    install_systemd
    ;;
  Darwin)
    install_launchd
    ;;
  *)
    err "Unsupported OS: $OS — service installation only supported on Linux and macOS"
    ;;
esac
