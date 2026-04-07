#!/bin/bash
#
# dev.sh — Build and run daemon + Tauri app together for development.
#
# Builds the daemon, starts it in the background with visible logs,
# then launches the full Tauri dev environment. Cleans up the daemon
# on exit (Ctrl+C or app close).
#
# Usage:
#   ./scripts/dev.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
DIM='\033[2m'
RESET='\033[0m'

DAEMON_PID=""

cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down...${RESET}"

  # Kill daemon if we spawned it
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo -e "${DIM}Stopping daemon (PID $DAEMON_PID)${RESET}"
    kill "$DAEMON_PID" 2>/dev/null
    wait "$DAEMON_PID" 2>/dev/null || true
  fi

  # Clean up stale socket
  local data_dir
  if [[ "$(uname)" == "Darwin" ]]; then
    data_dir="$HOME/Library/Application Support/com.mailvault.app"
  else
    data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/com.mailvault.app"
  fi
  rm -f "$data_dir/daemon.sock" "$data_dir/daemon.pid" 2>/dev/null || true

  echo -e "${GREEN}Done.${RESET}"
}
trap cleanup EXIT INT TERM

# ── Step 1: Source signing config ────────────────────────────────────────────

if [[ -f "$SCRIPT_DIR/signing-config.sh" ]]; then
  echo -e "${DIM}Sourcing signing config...${RESET}"
  source "$SCRIPT_DIR/signing-config.sh"
fi

# Sparkle framework path (macOS auto-updater build dependency)
if [[ "$(uname)" == "Darwin" && -d "$ROOT_DIR/src-tauri/Sparkle.framework" ]]; then
  export SPARKLE_FRAMEWORK_PATH="$ROOT_DIR/src-tauri"
fi

# ── Step 2: Build daemon ────────────────────────────────────────────────────

echo -e "${CYAN}Building daemon...${RESET}"
cargo build -p mailvault-daemon 2>&1 | tail -3
echo -e "${GREEN}Daemon built.${RESET}"

# ── Step 3: Symlink daemon binary for Tauri externalBin ─────────────────────

TRIPLE=$(rustc -vV | grep 'host:' | awk '{print $2}')
DAEMON_SIDECAR="$ROOT_DIR/src-tauri/binaries/mailvault-daemon-${TRIPLE}"
DAEMON_BIN="$ROOT_DIR/target/debug/mailvault-daemon"

if [[ -f "$DAEMON_BIN" ]]; then
  rm -f "$DAEMON_SIDECAR"
  cp "$DAEMON_BIN" "$DAEMON_SIDECAR"
  echo -e "${DIM}Copied daemon binary → ${DAEMON_SIDECAR}${RESET}"
fi

# ── Step 4: Stop any existing daemon ──────────────────────────────────────

# Kill any running daemon from a previous dev session
if [[ "$(uname)" == "Darwin" ]]; then
  DATA_DIR="$HOME/Library/Application Support/com.mailvault.app"
else
  DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/com.mailvault.app"
fi

if [[ -f "$DATA_DIR/daemon.pid" ]]; then
  OLD_PID=$(cat "$DATA_DIR/daemon.pid" 2>/dev/null || echo "")
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo -e "${DIM}Stopping previous daemon (PID $OLD_PID)...${RESET}"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 0.5
  fi
fi
rm -f "$DATA_DIR/daemon.sock" "$DATA_DIR/daemon.pid" 2>/dev/null || true

# ── Step 4b: Check daemon.lock for active lock holders ───────────────────

LOCK_FILE="$DATA_DIR/daemon.lock"
if [[ -f "$LOCK_FILE" ]]; then
  LOCK_HOLDER_PID=$(lsof -t "$LOCK_FILE" 2>/dev/null | head -1 || true)
  if [[ -n "$LOCK_HOLDER_PID" ]]; then
    LOCK_HOLDER_CMD=$(ps -p "$LOCK_HOLDER_PID" -o comm= 2>/dev/null || echo "unknown")
    echo -e "${DIM}Lock held by PID $LOCK_HOLDER_PID ($LOCK_HOLDER_CMD)${RESET}"

    case "$LOCK_HOLDER_CMD" in
      mailvault-daemon|mailvault|MailVault)
        echo -e "${DIM}Terminating existing $LOCK_HOLDER_CMD (PID $LOCK_HOLDER_PID)...${RESET}"
        kill "$LOCK_HOLDER_PID" 2>/dev/null || true
        # Wait for lock release
        for i in $(seq 1 15); do
          if ! kill -0 "$LOCK_HOLDER_PID" 2>/dev/null; then
            break
          fi
          sleep 0.2
        done
        if kill -0 "$LOCK_HOLDER_PID" 2>/dev/null; then
          echo -e "${RED}Failed to stop $LOCK_HOLDER_CMD (PID $LOCK_HOLDER_PID) after 3s${RESET}"
          exit 1
        fi
        ;;
      *)
        echo -e "${RED}daemon.lock held by unexpected process: $LOCK_HOLDER_CMD (PID $LOCK_HOLDER_PID)${RESET}"
        echo -e "${RED}Stop that process manually, or delete $LOCK_FILE${RESET}"
        exit 1
        ;;
    esac
  fi
fi
rm -f "$DATA_DIR/daemon.sock" "$DATA_DIR/daemon.pid" 2>/dev/null || true

# ── Step 4c: Stop any running MailVault app (avoids port/resource conflicts) ──

# Match specific MailVault binaries only — no broad name matching
for pattern in "MailVault.app/Contents/MacOS/MailVault" "mail-vault-app" "target/.*mailvault"; do
  APP_PIDS=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [[ -n "$APP_PIDS" ]]; then
    echo -e "${DIM}Stopping existing MailVault app (PIDs: $APP_PIDS)...${RESET}"
    echo "$APP_PIDS" | xargs kill 2>/dev/null || true
    sleep 0.5
  fi
done

# ── Step 5: Start daemon with logs ─────────────────────────────────────────

echo -e "${CYAN}Starting daemon...${RESET}"
RUST_LOG=debug target/debug/mailvault-daemon 2>&1 | while IFS= read -r line; do echo -e "${DIM}[daemon]${RESET} $line"; done &
DAEMON_PID=$!

# Wait for socket
for i in $(seq 1 30); do
  if [[ -S "$DATA_DIR/daemon.sock" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -S "$DATA_DIR/daemon.sock" ]]; then
  echo -e "${GREEN}Daemon running (PID $DAEMON_PID)${RESET}"
else
  echo -e "${RED}Daemon failed to start (no socket after 3s)${RESET}"
  exit 1
fi

# ── Step 6: Start Tauri dev ─────────────────────────────────────────────────

echo -e "${CYAN}Starting Tauri dev...${RESET}"
echo ""

# Run tauri dev — this blocks until the app closes
npm run tauri:dev 2>&1 | while IFS= read -r line; do echo -e "${DIM}[tauri]${RESET}  $line"; done

echo -e "${YELLOW}Tauri dev exited.${RESET}"
