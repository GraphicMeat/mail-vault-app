#!/usr/bin/env bash
# Unpack one footage run's tar (scripts/footage/run.sh stdout) into the
# per-clip layout the compositor reads:
#
#   <footage dir>/<clip>/<clip>.mov, .actions.json, .mov.json, .stats.json,
#                       .census.json, .frames.csv, .load.txt, frames/*.png, geometry.json
#   <footage dir>/_runs/<run name>/               (logs, facts, probe.json, s7 listing, the rest)
#   <footage dir>/s7-vault-listing.json          (only with --s7: this run's vault is THE listing)
#
#   bash scripts/footage/collect.sh <run.tar> <footage dir> [run name] [--s7]
#
# Local file moves only; nothing is built or run. A clip already present is
# replaced (a re-take supersedes the earlier one). With --s7 the listing gains
# `entriesInAccount` / `lsLinesInAccount`: the same real paths, relative to the
# account folder (on disk the account folder is named by the account id).
set -euo pipefail
tar_file="$1"; dest="$2"; name="${3:-$(basename "$tar_file" .tar)}"; s7="${4:-}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tar -xf "$tar_file" -C "$tmp"
mkdir -p "$dest" "$dest/_runs/$name"
for mov in "$tmp"/*.mov; do
  [ -e "$mov" ] || continue
  clip="$(basename "$mov" .mov)"
  if [ ! -f "$tmp/$clip.actions.json" ]; then echo "skip $clip: no actions.json (take aborted)"; continue; fi
  rm -rf "$dest/$clip"; mkdir -p "$dest/$clip"
  for f in "$tmp/$clip".*; do mv "$f" "$dest/$clip/"; done
  [ -d "$tmp/frames/$clip" ] && mv "$tmp/frames/$clip" "$dest/$clip/frames"
  [ -f "$tmp/geometry.json" ] && cp "$tmp/geometry.json" "$dest/$clip/geometry.json"
  [ -f "$tmp/motion.json" ] && cp "$tmp/motion.json" "$dest/$clip/motion.json"
  echo "$name" > "$dest/$clip/run.txt"
  echo "clip $clip -> $dest/$clip"
done
rm -rf "$tmp/frames"
cp -R "$tmp"/. "$dest/_runs/$name/"
echo "run files -> $dest/_runs/$name"
if [ "$s7" = "--s7" ] && [ -s "$dest/_runs/$name/s7-vault-listing.json" ]; then
  node -e '
    const fs = require("fs"); const [src, out, run] = process.argv.slice(1);
    const j = JSON.parse(fs.readFileSync(src, "utf-8"));
    const strip = (p) => p.replace(/^Maildir\/[^/]+\//, "").replace(/^[0-9a-f-]{36}\//, "");
    j.run = run;
    j.entriesInAccount = (j.entries || []).map((e) => ({ ...e, path: strip(e.path) }));
    j.lsLinesInAccount = (j.lsLines || []).map((l) => l.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//, ""));
    j.layoutInAccount = (j.layout || []).map((d) => ({ ...d, path: strip(d.path) }));
    fs.writeFileSync(out, JSON.stringify(j, null, 2));
  ' "$dest/_runs/$name/s7-vault-listing.json" "$dest/s7-vault-listing.json" "$name"
  echo "s7 listing -> $dest/s7-vault-listing.json"
fi
