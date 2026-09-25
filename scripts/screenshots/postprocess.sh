#!/usr/bin/env bash
# Post-process raw window captures: website/screenshots/*.png at 2x, capped at
# 2880px wide, quantised. responsive.sh derives the webp sizes the website and
# the README serve.
#
# Idempotent: re-running on already-processed files is a no-op beyond a rewrite.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SHOTS="$ROOT/website/screenshots"
MAX_WIDTH=2880

have() { command -v "$1" >/dev/null 2>&1; }

echo "→ resizing to max ${MAX_WIDTH}px and optimising PNGs"
for png in "$SHOTS"/*.png; do
  [ -e "$png" ] || continue
  width=$(sips -g pixelWidth "$png" | awk '/pixelWidth/ {print $2}')
  if [ "$width" -gt "$MAX_WIDTH" ]; then
    sips -Z "$MAX_WIDTH" "$png" >/dev/null
  fi
  if have pngquant; then
    # --skip-if-larger keeps the original when quantisation does not pay off.
    pngquant --force --skip-if-larger --quality 70-92 --strip --output "$png" -- "$png" || true
  fi
done

du -sh "$SHOTS"
