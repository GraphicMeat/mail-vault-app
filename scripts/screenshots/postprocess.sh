#!/usr/bin/env bash
# Post-process raw window captures into the two sets the project ships:
#
#   website/screenshots/*.png   — 2x, capped at 2880px wide, quantised
#   .github/images/*.webp       — the README subset, same pixels, smaller file
#
# Idempotent: re-running on already-processed files is a no-op beyond a rewrite.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SHOTS="$ROOT/website/screenshots"
README_IMAGES="$ROOT/.github/images"
MAX_WIDTH=2880

# README image name → screenshot name. Numbered so they sort in reading order.
README_MAP=(
  "01-inbox:email-list-view"
  "02-vault:state-icons"
  "03-chat:chat-view-thread"
  "04-bulk:selection-dialog"
  "05-security:link-safety-modal"
  "06-accounts:unified-inbox"
)

have() { command -v "$1" >/dev/null 2>&1; }

mkdir -p "$README_IMAGES"

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

if have cwebp; then
  echo "→ writing README webp set"
  for entry in "${README_MAP[@]}"; do
    out="${entry%%:*}"
    src="$SHOTS/${entry##*:}.png"
    if [ -f "$src" ]; then
      cwebp -quiet -q 84 -alpha_q 90 "$src" -o "$README_IMAGES/$out.webp"
      echo "   $out.webp ← $(basename "$src")"
    else
      echo "   MISSING $src — skipped $out.webp" >&2
    fi
  done
else
  echo "cwebp not installed (brew install webp) — README images not regenerated" >&2
fi

du -sh "$SHOTS" "$README_IMAGES"
