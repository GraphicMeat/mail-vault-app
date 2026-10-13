#!/usr/bin/env bash
# Proves the Blitz renderer module is removable. Works on a scratch copy of the
# checkout and never edits the real tree (the only thing it writes there is the
# gitignored cargo target dir, target/blitz-removal).
#
#   Phase 1 (module present): the cfg switch-off path. The daemon and the
#   shell build with the `blitz-render` feature off.
#   Phase 2 (module deleted): the physical-deletion path. Every file of the
#   module is removed, the feature definitions go with it, and the app must
#   still build and the core tests must still pass.
#
#   Every cargo check runs with --all-targets, so the cfg(test) modules and
#   integration tests are compiled in both phases too (test-only lines such as
#   the daemon's `for_test` state build the module as well).
#
# Run in CI on every push (job `blitz-removable`). Needs node_modules in the
# checkout (`npm ci`) and a Rust toolchain; on Linux also the webkit dev
# packages the e2e job installs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The scratch copy must never be the checkout: everything below deletes files.
if [ "$(cd "$WORK" && pwd -P)" = "$(cd "$ROOT" && pwd -P)" ]; then
  echo "scratch dir is the checkout, refusing to continue" >&2
  exit 1
fi
if [ ! -d "$ROOT/node_modules" ]; then
  echo "node_modules missing in $ROOT: run npm ci first" >&2
  exit 1
fi

# Stable and outside the scratch copy so reruns and the CI cache are incremental.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target/blitz-removal}"

step() { printf '\n==> %s\n' "$*"; }

step "copy the checkout to a scratch dir"
# Bare names match at every depth: no target dir is wanted anywhere in the copy.
rsync -a \
  --exclude .git --exclude target --exclude node_modules --exclude dist \
  --exclude .claude --exclude .superpowers --exclude docs \
  "$ROOT/" "$WORK/repo/"
cd "$WORK/repo"
if [ "$(pwd -P)" = "$(cd "$ROOT" && pwd -P)" ]; then
  echo "scratch copy resolved to the checkout, refusing to continue" >&2
  exit 1
fi
# A copy, not a symlink: vitest's dev server denies files outside the project
# root, and a symlinked node_modules resolves outside it. macOS clones the files
# (copy-on-write, instant), Linux copies (reflinks where the filesystem has them).
# Copy the real directory even when node_modules is a symlink, so the cache
# cleanup below can never reach through the link into the real tree.
NM_SRC="$(cd "$ROOT/node_modules" && pwd -P)"
if [ "$(uname -s)" = "Darwin" ]; then
  cp -RPc "$NM_SRC" node_modules
else
  cp -RP --reflink=auto "$NM_SRC" node_modules
fi
rm -rf node_modules/.vite node_modules/.cache

step "scaffold what the Tauri shell build script needs"
# tauri-build wants the externalBin sidecar for the host triple and the
# frontendDist dir to exist; both are build outputs the repo does not track.
HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
mkdir -p src-tauri/binaries dist
: > "src-tauri/binaries/mailvault-daemon-$HOST_TRIPLE"
[ -f dist/app.html ] || echo '<!doctype html>' > dist/app.html
if [ "$(uname -s)" = "Darwin" ]; then
  # The sparkle plugin's build script only needs Sparkle.framework to exist
  # (cargo check never links it). It looks next to a tauri.conf.json found above
  # OUT_DIR, which is outside the scratch copy here, so point it there directly.
  mkdir -p src-tauri/Sparkle.framework
  export SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri"
fi

step "phase 1: feature off, module still present (cfg switch-off path)"
cargo check -p mailvault-daemon --no-default-features --all-targets
cargo check -p mailvault --no-default-features --features custom-protocol,sparkle --all-targets

step "phase 2: delete the module"
rm -rf src/features/blitz src-render src-daemon/src/blitz src-tauri/src/blitz_tiles.rs
sed -i.bak "/import '.\/features\/blitz';/d" src/main.jsx
sed -i.bak '/# blitz-render/d' Cargo.toml src-daemon/Cargo.toml
# src-tauri's feature is code-free (cfg only): drop it from default, its comment and its definition.
sed -i.bak -e 's/, *"blitz-render"//' -e '/^blitz-render *=/d' -e '/^# Blitz reader tiles/d' src-tauri/Cargo.toml
rm -f src/main.jsx.bak Cargo.toml.bak src-daemon/Cargo.toml.bak src-tauri/Cargo.toml.bak

if grep -q "features/blitz" src/main.jsx; then
  echo "entry import still present" >&2
  exit 1
fi
if grep -rq "blitz-render" Cargo.toml src-daemon/Cargo.toml src-tauri/Cargo.toml; then
  echo "feature definition still present in a Cargo.toml" >&2
  exit 1
fi

step "phase 2: vite build"
npx vite build --logLevel error

step "phase 2: cargo check, module deleted"
# The module's files are gone, so these prove every cfg line compiles out.
cargo check -p mailvault-daemon --all-targets
cargo check -p mailvault --all-targets

step "phase 2: core tests"
npx vitest run src/components src/stores src/features

echo
echo "blitz module removal: OK"
