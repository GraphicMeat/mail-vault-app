#!/usr/bin/env bash
# Linux screenshot run (Snap Store listing): the real app on Ubuntu, in an
# Xvfb display at 2x with the Yaru GTK theme, driven by the same harness as the
# macOS set.
#
#   scripts/screenshots/run-linux.sh [dark|light] [out-dir]
#
# Needs a webdriver build (see prepare-build.sh), `tauri-wd` on PATH, and:
#   xvfb dbus-x11 metacity yaru-theme-gtk yaru-theme-icon x11-utils xdotool
#   imagemagick fonts-ubuntu fonts-noto-color-emoji
# SHOTS_ONLY=a,b,c narrows the run exactly as on macOS.
set -euo pipefail

# Under WSL, WSLg exports a Wayland socket that answers nothing in a session
# without a desktop: gtk_init blocks on it before the app logs a line, past
# tauri-wd's 30s launch deadline. Pin GTK (app, WM, portal backend) to the Xvfb.
unset WAYLAND_DISPLAY
export GDK_BACKEND=x11

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
THEME="${1:-dark}"
OUT="${2:-$ROOT/snap-screenshots}"
mkdir -p "$OUT"

if [ -z "${SHOTS_IN_SESSION:-}" ]; then
  # A run that died leaves its app up, and capture.js refuses to guess which
  # of two identical apps is the driven one.
  pkill -f "$ROOT/target/debug/mailvault" 2>/dev/null || true
  # -br: a black root that repaints, so a moved window leaves no ghost behind.
  exec env SHOTS_IN_SESSION=1 dbus-run-session -- \
    xvfb-run --auto-servernum --server-args="-screen 0 3200x2100x24 -br" "$0" "$@"
fi

# No XSETTINGS daemon runs here, so GTK reads settings.ini rather than the
# gsettings a GNOME session would hand it. That is what themes the titlebar
# (Yaru, Ubuntu's button layout) and sets Ubuntu's default font rendering.
# A private XDG_CONFIG_HOME carries it to the app, whose HOME is the harness's
# temp dir, and keeps it off the user's own ~/.config.
YARU=Yaru; DARK=false
[ "$THEME" = dark ] && YARU=Yaru-dark && DARK=true
export XDG_CONFIG_HOME="$(mktemp -d)"
mkdir -p "$XDG_CONFIG_HOME/gtk-3.0"
cat > "$XDG_CONFIG_HOME/gtk-3.0/settings.ini" <<INI
[Settings]
gtk-theme-name=$YARU
gtk-application-prefer-dark-theme=$DARK
gtk-icon-theme-name=Yaru
gtk-font-name=Ubuntu 11
gtk-decoration-layout=:minimize,maximize,close
gtk-xft-antialias=1
gtk-xft-hinting=1
gtk-xft-hintstyle=hintslight
gtk-xft-rgba=none
INI

export GDK_SCALE=2
# Only for focus and stacking: with GTK_CSD=1 the app draws its own titlebar.
metacity --replace >/tmp/metacity.log 2>&1 &
sleep 2

# GTK_CSD=1: GTK draws the titlebar itself, as it does for every GTK3 app on
# Ubuntu's Wayland session. Compositing off matches snap/snapcraft.yaml.
cd "$ROOT"
SHOTS_THEME="$THEME" SHOTS_OUT="$OUT" SHOTS_TAURI_WD="${SHOTS_TAURI_WD:-tauri-wd}" \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 NO_AT_BRIDGE=1 \
  WEBKIT_DISABLE_COMPOSITING_MODE=1 GTK_CSD=1 \
  npx wdio run wdio.screenshots.conf.js
