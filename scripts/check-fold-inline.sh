#!/usr/bin/env bash
# The production bundle carries the shared fold detection inlined as raw text
# (Vite ?raw is a string literal, which minification never rewrites).
# Box use only (npm ci wipes node_modules).
set -euo pipefail
npm ci
npm run build
n=$(cat dist/assets/*.js | { grep -o "function quoteFoldTargets(" || true; } | wc -l | tr -d ' ')
echo "quoteFoldTargets in bundle: $n"
test "$n" -ge 1
