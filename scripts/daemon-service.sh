#!/bin/bash
#
# daemon-service.sh — install, uninstall, start, stop, and check the mailvault-daemon service.
#
# Usage:
#   ./scripts/daemon-service.sh install [--daemon-bin PATH]
#   ./scripts/daemon-service.sh uninstall
#   ./scripts/daemon-service.sh start
#   ./scripts/daemon-service.sh stop
#   ./scripts/daemon-service.sh restart
#   ./scripts/daemon-service.sh status
#
# On macOS: uses launchd (~/Library/LaunchAgents)
# On Linux: uses systemd user units (~/.config/systemd/user)

set -euo pipefail

LABEL="com.mailvault.daemon"

# ── Resolve daemon binary path ──────────────────────────────────────────────

resolve_daemon_bin() {
  local bin=""

  # Explicit --daemon-bin flag
  for arg in "$@"; do
    if [[ "$prev" == "--daemon-bin" ]]; then
      bin="$arg"
      break
    fi
    prev="$arg"
  done

  # Fallback: look next to this script (release layout)
  if [[ -z "$bin" ]]; then
    local script_dir
    script_dir="$(cd "$(dirname "$0")" && pwd)"

    if [[ -x "$script_dir/../mailvault-daemon" ]]; then
      bin="$script_dir/../mailvault-daemon"
    elif [[ -x "$script_dir/../target/debug/mailvault-daemon" ]]; then
      bin="$script_dir/../target/debug/mailvault-daemon"
    elif [[ -x "$script_dir/../target/release/mailvault-daemon" ]]; then
      bin="$script_dir/../target/release/mailvault-daemon"
    fi
  fi

  if [[ -z "$bin" || ! -x "$bin" ]]; then
    echo "Error: mailvault-daemon binary not found. Build it first or pass --daemon-bin PATH." >&2
    exit 1
  fi

  # Return absolute path
  echo "$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"
}

# ── macOS (launchd) ─────────────────────────────────────────────────────────

macos_plist_path() {
  echo "$HOME/Library/LaunchAgents/${LABEL}.plist"
}

macos_install() {
  local daemon_bin="$1"
  local plist
  plist="$(macos_plist_path)"
  local log_dir="$HOME/Library/Application Support/com.mailvault.app/logs"

  mkdir -p "$(dirname "$plist")"
  mkdir -p "$log_dir"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${daemon_bin}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${log_dir}/daemon-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${log_dir}/daemon-stderr.log</string>
</dict>
</plist>
EOF

  echo "Installed launchd plist at $plist"
  echo "Daemon binary: $daemon_bin"

  # Load the service
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || \
    launchctl load "$plist" 2>/dev/null || true

  echo "Service loaded. Checking status..."
  sleep 1
  macos_status
}

macos_uninstall() {
  local plist
  plist="$(macos_plist_path)"

  if [[ ! -f "$plist" ]]; then
    echo "Service not installed (no plist at $plist)"
    return
  fi

  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || \
    launchctl unload "$plist" 2>/dev/null || true

  rm -f "$plist"
  echo "Service uninstalled"
}

macos_start() {
  launchctl kickstart "gui/$(id -u)/${LABEL}" 2>/dev/null || \
    launchctl start "$LABEL" 2>/dev/null || true
  echo "Start signal sent"
  sleep 1
  macos_status
}

macos_stop() {
  launchctl kill SIGTERM "gui/$(id -u)/${LABEL}" 2>/dev/null || \
    launchctl stop "$LABEL" 2>/dev/null || true
  echo "Stop signal sent"
}

macos_status() {
  local data_dir="$HOME/Library/Application Support/com.mailvault.app"
  local pid_file="$data_dir/daemon.pid"
  local socket_file="$data_dir/daemon.sock"
  local token_file="$data_dir/daemon.token"

  echo "=== mailvault-daemon status ==="

  # Check launchd
  if launchctl print "gui/$(id -u)/${LABEL}" &>/dev/null; then
    echo "launchd:  registered"
  else
    echo "launchd:  not registered"
  fi

  # Check PID file
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "process:  running (PID $pid)"
    else
      echo "process:  stale PID file ($pid not running)"
    fi
  else
    echo "process:  no PID file"
  fi

  # Check socket
  if [[ -S "$socket_file" ]]; then
    echo "socket:   $socket_file (exists)"
  else
    echo "socket:   not found"
  fi

  # Check token
  if [[ -f "$token_file" ]]; then
    local perms
    perms="$(stat -f '%A' "$token_file" 2>/dev/null || stat -c '%a' "$token_file" 2>/dev/null)"
    echo "token:    $token_file (permissions: $perms)"
  else
    echo "token:    not found"
  fi
}

# ── Linux (systemd) ─────────────────────────────────────────────────────────

linux_unit_dir() {
  echo "$HOME/.config/systemd/user"
}

linux_unit_path() {
  echo "$(linux_unit_dir)/${LABEL}.service"
}

linux_install() {
  local daemon_bin="$1"
  local unit_dir
  unit_dir="$(linux_unit_dir)"
  local unit_path
  unit_path="$(linux_unit_path)"

  mkdir -p "$unit_dir"

  cat > "$unit_path" <<EOF
[Unit]
Description=MailVault Background Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${daemon_bin}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

  echo "Installed systemd unit at $unit_path"
  echo "Daemon binary: $daemon_bin"

  systemctl --user daemon-reload
  systemctl --user enable "$LABEL"
  systemctl --user start "$LABEL"

  echo "Service enabled and started. Checking status..."
  sleep 1
  linux_status
}

linux_uninstall() {
  local unit_path
  unit_path="$(linux_unit_path)"

  if [[ ! -f "$unit_path" ]]; then
    echo "Service not installed (no unit at $unit_path)"
    return
  fi

  systemctl --user stop "$LABEL" 2>/dev/null || true
  systemctl --user disable "$LABEL" 2>/dev/null || true
  rm -f "$unit_path"
  systemctl --user daemon-reload
  echo "Service uninstalled"
}

linux_start() {
  systemctl --user start "$LABEL"
  echo "Service started"
  sleep 1
  linux_status
}

linux_stop() {
  systemctl --user stop "$LABEL"
  echo "Service stopped"
}

linux_status() {
  local data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/com.mailvault.app"
  local pid_file="$data_dir/daemon.pid"
  local socket_file="$data_dir/daemon.sock"
  local token_file="$data_dir/daemon.token"

  echo "=== mailvault-daemon status ==="

  systemctl --user status "$LABEL" --no-pager 2>/dev/null || echo "systemd: not registered"

  if [[ -S "$socket_file" ]]; then
    echo "socket:   $socket_file (exists)"
  else
    echo "socket:   not found"
  fi

  if [[ -f "$token_file" ]]; then
    local perms
    perms="$(stat -c '%a' "$token_file" 2>/dev/null || stat -f '%A' "$token_file" 2>/dev/null)"
    echo "token:    $token_file (permissions: $perms)"
  else
    echo "token:    not found"
  fi
}

# ── Dispatch ────────────────────────────────────────────────────────────────

ACTION="${1:-}"
shift || true

case "$(uname)" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      echo "Unsupported platform: $(uname)" >&2; exit 1 ;;
esac

case "$ACTION" in
  install)
    DAEMON_BIN="$(resolve_daemon_bin "$@")"
    "${PLATFORM}_install" "$DAEMON_BIN"
    ;;
  uninstall)
    "${PLATFORM}_uninstall"
    ;;
  start)
    "${PLATFORM}_start"
    ;;
  stop)
    "${PLATFORM}_stop"
    ;;
  restart)
    "${PLATFORM}_stop"
    sleep 1
    "${PLATFORM}_start"
    ;;
  status)
    "${PLATFORM}_status"
    ;;
  *)
    echo "Usage: $0 {install|uninstall|start|stop|restart|status} [--daemon-bin PATH]"
    exit 1
    ;;
esac
