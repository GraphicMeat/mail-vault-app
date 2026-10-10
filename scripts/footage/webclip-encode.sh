#!/usr/bin/env bash
# Web clips from recorded takes: every <clip>.mov in <src> that has a
# <clip>.webclip.json becomes <out>/<clip>.mp4 (960x660, 30 fps, H.264, no
# audio, moov first, at most 250 KB) and <out>/<clip>.jpg (poster), plus
# <out>/frames/<clip>/*.jpg (frames of the encoded file, to look at) and
# <out>/<clip>.report.json (what the encoder wrote and verified). A spec whose
# segments name their own takes ("src", e.g. the hero montage) needs no
# <clip>.mov; its size, maxBytes and posterMaxBytes come from the spec.
#
#   bash scripts/footage/webclip-encode.sh <src> <out>          # inside run.sh (FOOTAGE_WEBCLIP=1)
#   bash scripts/footage/webclip-encode.sh <src> --tar          # encode-only mini job: tar on stdout
#
# Runs on the mini only (it compiles video/capture/tools/webclip.swift, an
# AVFoundation encoder: the runners have no ffmpeg). Crop overrides come from
# scripts/footage/web-clips.crops.json (lib/webclipSpec.mjs).
# FOOTAGE_WEBCLIP_VARIANTS=1 also writes <clip>-wide.mp4 (crop 30 % wider).
# FOOTAGE_WEBCLIP_ONLY=a,b limits the clips.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$1"; OUTARG="${2:-}"
TAR=0
if [ "$OUTARG" = "--tar" ]; then
  TAR=1; exec 3>&1 1>&2
  OUTDIR="$(mktemp -d -t mvweb)"
else
  OUTDIR="$OUTARG"
fi
[ -n "$OUTDIR" ] || { echo "usage: webclip-encode.sh <src> <out>|--tar"; exit 64; }
mkdir -p "$OUTDIR"
BINDIR="$(mktemp -d -t mvwebbin)"
cleanup() {
  rm -rf "$BINDIR"
  if [ "$TAR" = 1 ]; then tar -C "$OUTDIR" -cf - . >&3; rm -rf "$OUTDIR"; fi
}
trap cleanup EXIT

# WEBCLIP_BIN: an encoder the caller already compiled (web-clips-job.sh builds it once).
if [ -n "${WEBCLIP_BIN:-}" ] && [ -x "$WEBCLIP_BIN" ]; then
  cp "$WEBCLIP_BIN" "$BINDIR/webclip"
else
  swiftc -O "$ROOT/video/capture/tools/webclip.swift" -o "$BINDIR/webclip" 2>"$BINDIR/swiftc.log" || { cat "$BINDIR/swiftc.log"; exit 1; }
fi

only=",${FOOTAGE_WEBCLIP_ONLY:-},"
status=0
for spec in "$SRC"/*.webclip.json; do
  [ -f "$spec" ] || continue
  clip="$(basename "$spec" .webclip.json)"
  [ "$only" = ",," ] || [[ "$only" == *",$clip,"* ]] || continue
  # A montage (hero-montage) names its takes per segment ("src"); the first one is its input.
  in="$SRC/$clip.mov"
  [ -f "$in" ] || in="$SRC/$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((s.segments.find((x)=>x.src)||{}).src||"")' "$spec")"
  [ -f "$in" ] || { echo "$clip: no $clip.mov"; status=1; continue; }
  variants="main"
  [ "${FOOTAGE_WEBCLIP_VARIANTS:-0}" = 1 ] && variants="main wide"
  for v in $variants; do
    name="$clip"; [ "$v" = main ] || name="$clip-$v"
    node "$ROOT/scripts/footage/lib/webclipSpec.mjs" "$SRC" "$clip" "$v" > "$OUTDIR/$name.spec.json" || { status=1; continue; }
    echo "== $name ($(date +%H:%M:%S))"
    if "$BINDIR/webclip" "$in" "$OUTDIR/$name.mp4" --spec "$OUTDIR/$name.spec.json" \
        --poster "$OUTDIR/$name.jpg" --frames-dir "$OUTDIR/frames/$name" > "$OUTDIR/$name.report.json"; then
      node -e 'const r=require(process.argv[1]); console.log(JSON.stringify({bytes:r.bytes,bitrate:r.bitrate,dur:r.durationSeconds,codec:r.codec,size:r.size,fps:r.fps,frames:r.frames,audio:r.audioTracks,moovFirst:r.moovBeforeMdat,poster:r.poster}))' "$OUTDIR/$name.report.json"
    else
      echo "$name: encode failed"; status=1
    fi
  done
done
# AVAssetWriter's safe-save leftovers next to each re-encoded file.
find "${OUTDIR:?}" -maxdepth 1 -name '*.sb-*' -exec rm -rf {} +
ls -la "$OUTDIR"
exit $status
