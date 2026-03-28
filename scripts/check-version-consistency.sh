#!/bin/bash
# Verify all versioned files have the same version as package.json.
# Use in CI or pre-release to catch drift.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CANONICAL=$(grep -m1 '"version"' "$ROOT/package.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')
echo "Canonical version (package.json): $CANONICAL"

ERRORS=0

check() {
  local file="$1" actual="$2" label="$3"
  if [[ "$actual" != "$CANONICAL" ]]; then
    echo "  MISMATCH: $label has '$actual' (expected '$CANONICAL')"
    ERRORS=$((ERRORS + 1))
  else
    echo "  OK: $label = $actual"
  fi
}

CARGO=$(grep -m1 '^version = ' "$ROOT/src-tauri/Cargo.toml" | sed 's/version = "\(.*\)"/\1/')
TAURI=$(grep -m1 '"version"' "$ROOT/src-tauri/tauri.conf.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')
SNAP=$(grep -m1 '^version:' "$ROOT/snap/snapcraft.yaml" | sed "s/version: '\(.*\)'/\1/")

check "$ROOT/src-tauri/Cargo.toml" "$CARGO" "Cargo.toml"
check "$ROOT/src-tauri/tauri.conf.json" "$TAURI" "tauri.conf.json"
check "$ROOT/snap/snapcraft.yaml" "$SNAP" "snapcraft.yaml"

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "ERROR: $ERRORS file(s) have drifted versions!"
  exit 1
fi

echo ""
echo "All versions consistent: $CANONICAL"
