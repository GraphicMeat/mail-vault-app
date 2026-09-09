#!/bin/bash
set -euo pipefail
export PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/Users/unicorn/.cargo/bin:$PATH
cd /Users/unicorn/Repos/mv-insights-20260909-01a08694
mode=$1
shift
case "$mode" in
  unit) npm test -- "$@" ;;
  rust)
    if [[ ! -f dist/index.html ]]; then VITE_E2E=1 npm run build; fi
    DAEMON_PROFILE=debug npm run build:daemon
    SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri" DYLD_FRAMEWORK_PATH="$PWD/src-tauri" cargo test --locked "$@"
    ;;
  build)
    VITE_E2E=1 npm run build
    DAEMON_PROFILE=debug npm run build:daemon
    SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri" cargo build -p mailvault --features webdriver --locked
    cp .insights-source-manifest.json .insights-build-manifest.json
    ;;
  e2e) node scripts/testing/insights/assert-build.mjs; DYLD_FRAMEWORK_PATH="$PWD/src-tauri" caffeinate -di npx wdio run wdio.insights.conf.js "$@" ;;
  e2e-large) node scripts/testing/insights/assert-build.mjs; E2E_INSIGHTS_LARGE=1 DYLD_FRAMEWORK_PATH="$PWD/src-tauri" caffeinate -di npx wdio run wdio.insights.conf.js "$@" ;;
  regression) node scripts/testing/insights/assert-build.mjs; DYLD_FRAMEWORK_PATH="$PWD/src-tauri" caffeinate -di npx wdio run wdio.conf.js "$@" ;;
  *) exit 64 ;;
esac
