#!/usr/bin/env bash
# Generate the Dark Reader golden vectors inside an anyjob clone.
set -euo pipefail
npm ci --no-audit --no-fund >&2
node src-render/tools/dr-vectors/gen.mjs
