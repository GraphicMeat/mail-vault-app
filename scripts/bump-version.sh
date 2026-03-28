#!/bin/bash
# Usage: ./scripts/bump-version.sh <patch|minor|major>
# Examples:
#   ./scripts/bump-version.sh patch   # 1.0.1 → 1.0.2
#   ./scripts/bump-version.sh minor   # 1.0.1 → 1.1.0
#   ./scripts/bump-version.sh major   # 1.0.1 → 2.0.0

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

BUMP_TYPE="$1"
if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  echo "Usage: $0 <patch|minor|major>"
  exit 1
fi

# ── Read canonical version from package.json ──
CURRENT=$(grep -m1 '"version"' "$ROOT/package.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')
if [[ -z "$CURRENT" ]]; then
  echo "Error: could not read current version from package.json"
  exit 1
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP_TYPE" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac

NEW="$MAJOR.$MINOR.$PATCH"
TODAY=$(date +%Y-%m-%d)

echo "Bumping version: $CURRENT → $NEW"

# ── Deterministic version replacement ──
# Uses pattern-based sed that matches any semver, not just $CURRENT.
# This ensures drifted files are corrected.

# package.json: "version": "X.Y.Z"
sed -i '' 's/"version": *"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"/"version": "'"$NEW"'"/' "$ROOT/package.json"

# src-tauri/Cargo.toml: version = "X.Y.Z" (first occurrence only)
sed -i '' '0,/^version = "[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"/s//version = "'"$NEW"'"/' "$ROOT/src-tauri/Cargo.toml"

# src-tauri/tauri.conf.json: "version": "X.Y.Z"
sed -i '' 's/"version": *"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"/"version": "'"$NEW"'"/' "$ROOT/src-tauri/tauri.conf.json"

# snap/snapcraft.yaml: version: 'X.Y.Z'
sed -i '' "s/^version: '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*'/version: '$NEW'/" "$ROOT/snap/snapcraft.yaml"

# Update Cargo.lock
(cd "$ROOT/src-tauri" && cargo update -p mailvault 2>/dev/null || true)

# ── CHANGELOG.md ──
CHANGELOG="$ROOT/CHANGELOG.md"
if grep -q '## \[Unreleased\]' "$CHANGELOG"; then
  sed -i '' "s/## \[Unreleased\]/## [Unreleased]\n\n## [$NEW] - $TODAY/" "$CHANGELOG"
  echo "  CHANGELOG.md            → [Unreleased] → [$NEW] - $TODAY"
fi

# Regenerate website changelog
if [[ -f "$ROOT/scripts/generate-changelog.cjs" ]]; then
  node "$ROOT/scripts/generate-changelog.cjs"
  echo "  website/changelog.html  → regenerated"
fi

# ── Verify all files are consistent ──
ERRORS=0
verify_version() {
  local file="$1" pattern="$2" label="$3"
  if ! grep -q "$pattern" "$file"; then
    echo "  ERROR: $label does not contain version $NEW"
    ERRORS=$((ERRORS + 1))
  fi
}

verify_version "$ROOT/package.json" "\"version\": \"$NEW\"" "package.json"
verify_version "$ROOT/src-tauri/Cargo.toml" "version = \"$NEW\"" "Cargo.toml"
verify_version "$ROOT/src-tauri/tauri.conf.json" "\"version\": \"$NEW\"" "tauri.conf.json"
verify_version "$ROOT/snap/snapcraft.yaml" "version: '$NEW'" "snapcraft.yaml"

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "ERROR: $ERRORS file(s) have version mismatches after bump!"
  exit 1
fi

echo ""
echo "Updated files:"
echo "  package.json            → $NEW"
echo "  src-tauri/Cargo.toml    → $NEW"
echo "  src-tauri/tauri.conf.json → $NEW"
echo "  snap/snapcraft.yaml     → $NEW"
echo ""
echo "Done! Version is now $NEW"
