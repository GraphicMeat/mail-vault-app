#!/usr/bin/env bash
# Derive the three webp sizes the website serves from each raw PNG capture.
#
#   scripts/screenshots/responsive.sh                  # English set, in place
#   scripts/screenshots/responsive.sh de               # website/screenshots/de
#   scripts/screenshots/responsive.sh de --prune-png   # and drop the PNGs after
#
# This did not exist before the localized set: postprocess.sh only quantises the
# PNGs, so the 54 `-720/-1440/-2880.webp`
# files under website/screenshots were made by hand. 672 more cannot be.
#
# Locale directories ship webp only — eight sets of 2880px PNGs is ~70MB of git
# nobody serves. English keeps its PNGs: they are the only thing a re-encode
# can start from. The README shows the English `-1440.webp` files directly.
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
  src_width=$(sips -g pixelWidth "$png" | awk '/pixelWidth/ {print $2}')
  produced=0
  for width in 720 1440 2880; do
    # `sips -Z` only ever shrinks. A close-up detail crop (scripts/screenshots/
    # shots.js DETAILS) can be narrower than a breakpoint — skip it rather than
    # emitting a `*-1440.webp` that is secretly still 480px: a `srcset ...
    # 1440w` descriptor is a promise about the file's actual pixel width, and
    # `sips -Z` on a too-small source would silently break that promise instead
    # of upscaling.
    [ "$width" -le "$src_width" ] || continue
    tmp="$(mktemp -t shots).png"
    cp "$png" "$tmp"
    sips -Z "$width" "$tmp" >/dev/null
    cwebp -quiet -q 84 -alpha_q 90 "$tmp" -o "$DIR/${base}-${width}.webp"
    rm -f "$tmp"
    produced=1
  done
  # A detail crop between breakpoints (say 1000px) would otherwise top out at
  # its 720 variant and look soft wherever it is shown larger. Keep one more
  # variant at the crop's own width, named by that width like the others
  # (`<name>-1000.webp`), so a srcset can offer the full-resolution pixels.
  case "$src_width" in 720|1440|2880) ;; *)
    [ "$src_width" -lt 2880 ] && cwebp -quiet -q 84 -alpha_q 90 "$png" -o "$DIR/${base}-${src_width}.webp"
  ;; esac
  # Narrower than 720: the native-width file above is the only variant; keep the
  # plain `<name>.webp` alias too, which pages written before this referenced.
  if [ "$produced" -eq 0 ]; then
    cwebp -quiet -q 84 -alpha_q 90 "$png" -o "$DIR/${base}.webp"
  fi
  count=$((count + 1))
done
echo "→ $count captures processed in $DIR"

if [ "$PRUNE" = "--prune-png" ]; then
  rm -f "$DIR"/*.png
  echo "→ pruned PNGs in $DIR"
fi

du -sh "$DIR"
