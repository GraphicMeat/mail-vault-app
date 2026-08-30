#!/usr/bin/env bash
# Derive the three webp sizes the website serves from each raw PNG capture.
#
#   scripts/screenshots/responsive.sh                  # English set, in place
#   scripts/screenshots/responsive.sh de               # website/screenshots/de
#   scripts/screenshots/responsive.sh de --prune-png   # and drop the PNGs after
#
# This did not exist before the localized set: postprocess.sh only quantises the
# PNGs and derives the six README images, so the 54 `-720/-1440/-2880.webp`
# files under website/screenshots were made by hand. 672 more cannot be.
#
# Locale directories ship webp only — eight sets of 2880px PNGs is ~70MB of git
# nobody serves. English keeps its PNGs: they are the README's source and the
# only thing a re-encode can start from.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCALE="${1:-en}"
PRUNE="${2:-}"
DIR="$ROOT/website/screenshots"
[ "$LOCALE" = "en" ] || DIR="$DIR/$LOCALE"

command -v cwebp >/dev/null || { echo "cwebp missing (brew install webp)" >&2; exit 1; }
[ -d "$DIR" ] || { echo "no such directory: $DIR" >&2; exit 1; }

shopt -s nullglob
count=0
for png in "$DIR"/*.png; do
  base="$(basename "$png" .png)"
  for width in 720 1440 2880; do
    tmp="$(mktemp -t shots).png"
    cp "$png" "$tmp"
    # `sips -Z` only ever shrinks, so a capture narrower than the target keeps
    # its own width instead of being upscaled into a soft file.
    sips -Z "$width" "$tmp" >/dev/null
    cwebp -quiet -q 84 -alpha_q 90 "$tmp" -o "$DIR/${base}-${width}.webp"
    rm -f "$tmp"
  done
  count=$((count + 1))
done
echo "→ $count captures → $((count * 3)) webp in $DIR"

if [ "$PRUNE" = "--prune-png" ]; then
  rm -f "$DIR"/*.png
  echo "→ pruned PNGs in $DIR"
fi

du -sh "$DIR"
