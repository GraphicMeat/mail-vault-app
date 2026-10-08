#!/usr/bin/env bash
# Upload localized website clips to the site host. They are not in git (about
# 180 MB for 8 languages x 2 themes) and the deploy leaves /assets/clips/<locale>/
# alone (deploy-website.yml). English ships from git.
#
#   python3 scripts/footage/site-set.py "<published set>" "$OUT/<dir>" --accept clip,clip
#   scripts/website-clips-upload.sh <out dir> <locale dir>  [--dry-run]
#
# <out dir>   what site-set.py wrote (mp4, jpg, posters, manifest.json)
# <locale dir> the website directory: de es fr it ja ko pt-br zh
# SITE_HOST   ssh target (default hetzner-root); SITE_ROOT the web root.
# Run it after the English-only pages are deployed and before a locale page
# starts referencing its clips. Never run it from CI: the media is on a Mac.
set -euo pipefail
src="${1:?out dir from site-set.py}"; loc="${2:?locale dir (de es fr it ja ko pt-br zh)}"; shift 2
case "$loc" in de|es|fr|it|ja|ko|pt-br|zh) ;; *) echo "locale dir: de es fr it ja ko pt-br zh (English ships from git)"; exit 64 ;; esac
[ -f "$src/manifest.json" ] || { echo "$src has no manifest.json: run site-set.py first"; exit 1; }
host="${SITE_HOST:-hetzner-root}"; root="${SITE_ROOT:-/var/www/mailvaultapp}"
n=$(node -e 'console.log(require(process.argv[1]).files.length)' "$src/manifest.json")
echo "== $n files -> $host:$root/assets/clips/$loc/ ${*:-}"
ssh "$host" "mkdir -p '$root/assets/clips/$loc'"
rsync -av --delete --chmod=D755,F644 "$@" --exclude=manifest.json "$src/" "$host:$root/assets/clips/$loc/"
echo "== check: curl -sI https://mailvaultapp.com/assets/clips/$loc/layouts.mp4 | head -1"
