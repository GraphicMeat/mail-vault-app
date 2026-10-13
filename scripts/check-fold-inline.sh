#!/usr/bin/env bash
# The production bundle carries the shared fold detection inlined as raw text
# (Vite ?raw is a string literal, which minification never rewrites).
set -euo pipefail
npm ci
npm run build
n=$(cat dist/assets/*.js | grep -o "function quoteFoldTargets(" | wc -l | tr -d ' ')
echo "quoteFoldTargets in bundle: $n"
test "$n" -ge 1
