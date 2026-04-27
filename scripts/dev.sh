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
IPC_DIR="$HOME/.mailvault"
SOCKET_PATH="$IPC_DIR/mv.sock"

# Daemon data dir (holds daemon.pid / daemon.lock). Needed by cleanup trap,
# so resolve before any signal can fire.
if [[ "$(uname)" == "Darwin" ]]; then
  DATA_DIR="$HOME/Library/Application Support/com.mailvault.app"
else
  DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/com.mailvault.app"
fi

cleanup() {
  # Guard against double-invocation (EXIT + INT both fire on Ctrl+C).
  if [[ -n "${_CLEANUP_DONE:-}" ]]; then return; fi
  _CLEANUP_DONE=1

  echo ""
  echo -e "${YELLOW}Shutting down...${RESET}"

  # Kill daemon if we spawned it. Fall back to pidfile/pgrep in case $DAEMON_PID
  # wasn't captured correctly (e.g. when stdout was piped).
  local pids_to_kill=()
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    pids_to_kill+=("$DAEMON_PID")
  fi
  if [[ -f "$DATA_DIR/daemon.pid" ]]; then
    local pid_from_file
    pid_from_file=$(cat "$DATA_DIR/daemon.pid" 2>/dev/null || true)
    if [[ -n "$pid_from_file" ]] && kill -0 "$pid_from_file" 2>/dev/null; then
      pids_to_kill+=("$pid_from_file")
    fi
  fi
  # Belt-and-suspenders: any stray daemon spawned by this session's binary.
  local stray
  stray=$(pgrep -f "target/debug/mailvault-daemon" 2>/dev/null || true)
  if [[ -n "$stray" ]]; then
    while IFS= read -r p; do
      [[ -n "$p" ]] && pids_to_kill+=("$p")
    done <<< "$stray"
  fi

  if [[ ${#pids_to_kill[@]} -gt 0 ]]; then
    # Deduplicate
    local uniq_pids
    uniq_pids=$(printf '%s\n' "${pids_to_kill[@]}" | sort -u | tr '\n' ' ')
    echo -e "${DIM}Stopping daemon (PIDs:$uniq_pids)${RESET}"
    # shellcheck disable=SC2086
    kill -TERM $uniq_pids 2>/dev/null || true
    # Wait up to 3s for graceful exit, then SIGKILL survivors.
    for i in $(seq 1 15); do
      local alive=""
      for p in $uniq_pids; do
        if kill -0 "$p" 2>/dev/null; then alive="1"; break; fi
      done
      [[ -z "$alive" ]] && break
      sleep 0.2
    done
    # shellcheck disable=SC2086
    kill -KILL $uniq_pids 2>/dev/null || true
  fi

  # Clean up stale socket + pidfile
  rm -f "$SOCKET_PATH" "$DATA_DIR/daemon.pid" 2>/dev/null || true

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
if [[ -f "$DATA_DIR/daemon.pid" ]]; then
  OLD_PID=$(cat "$DATA_DIR/daemon.pid" 2>/dev/null || echo "")
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo -e "${DIM}Stopping previous daemon (PID $OLD_PID)...${RESET}"
    kill -TERM "$OLD_PID" 2>/dev/null || true
    # Graceful shutdown grace period
    for i in $(seq 1 10); do
      if ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi
      sleep 0.2
    done
    # Escalate to SIGKILL if SIGTERM didn't take
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo -e "${YELLOW}SIGTERM ignored — SIGKILL PID $OLD_PID${RESET}"
      kill -KILL "$OLD_PID" 2>/dev/null || true
    fi
  fi
fi
rm -f "$SOCKET_PATH" "$DATA_DIR/daemon.pid" 2>/dev/null || true

# ── Step 4b: Check daemon.lock for active lock holders ───────────────────

LOCK_FILE="$DATA_DIR/daemon.lock"
if [[ -f "$LOCK_FILE" ]]; then
  LOCK_HOLDER_PID=$(lsof -t "$LOCK_FILE" 2>/dev/null | head -1 || true)
  if [[ -n "$LOCK_HOLDER_PID" ]]; then
    LOCK_HOLDER_CMD=$(ps -p "$LOCK_HOLDER_PID" -o comm= 2>/dev/null || echo "unknown")
    echo -e "${DIM}Lock held by PID $LOCK_HOLDER_PID ($LOCK_HOLDER_CMD)${RESET}"

    case "$LOCK_HOLDER_CMD" in
      *mailvault-daemon*|*mailvault*|*MailVault*)
        echo -e "${DIM}Terminating existing $LOCK_HOLDER_CMD (PID $LOCK_HOLDER_PID)...${RESET}"
        kill -TERM "$LOCK_HOLDER_PID" 2>/dev/null || true
        # Wait for graceful exit
        for i in $(seq 1 15); do
          if ! kill -0 "$LOCK_HOLDER_PID" 2>/dev/null; then
            break
          fi
          sleep 0.2
        done
        # Escalate to SIGKILL if SIGTERM ignored
        if kill -0 "$LOCK_HOLDER_PID" 2>/dev/null; then
          echo -e "${YELLOW}SIGTERM ignored — sending SIGKILL to PID $LOCK_HOLDER_PID${RESET}"
          kill -KILL "$LOCK_HOLDER_PID" 2>/dev/null || true
          for i in $(seq 1 10); do
            if ! kill -0 "$LOCK_HOLDER_PID" 2>/dev/null; then
              break
            fi
            sleep 0.2
          done
        fi
        if kill -0 "$LOCK_HOLDER_PID" 2>/dev/null; then
          echo -e "${RED}Failed to stop $LOCK_HOLDER_CMD (PID $LOCK_HOLDER_PID) even after SIGKILL${RESET}"
          exit 1
        fi
        # Lock holder dead — clear stale lock file
        rm -f "$LOCK_FILE" 2>/dev/null || true
        ;;
      *)
        echo -e "${RED}daemon.lock held by unexpected process: $LOCK_HOLDER_CMD (PID $LOCK_HOLDER_PID)${RESET}"
        echo -e "${RED}Stop that process manually, or delete $LOCK_FILE${RESET}"
        exit 1
        ;;
    esac
  fi
fi
rm -f "$SOCKET_PATH" "$DATA_DIR/daemon.pid" 2>/dev/null || true

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
# Use process substitution so `$!` captures the daemon's PID (not the reader
# subshell's). Piping via `cmd | while read` would have assigned the PID of
# the while-loop, leaving the actual daemon orphaned on cleanup.
RUST_LOG=debug target/debug/mailvault-daemon \
  > >(while IFS= read -r line; do echo -e "${DIM}[daemon]${RESET} $line"; done) \
  2>&1 &
DAEMON_PID=$!

# Wait for socket
for i in $(seq 1 30); do
  if [[ -S "$SOCKET_PATH" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -S "$SOCKET_PATH" ]]; then
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
