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

# Read current version from package.json
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

echo "Bumping version: $CURRENT → $NEW"

# package.json
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$ROOT/package.json"

# src-tauri/Cargo.toml
sed -i '' "s/^version = \"$CURRENT\"/version = \"$NEW\"/" "$ROOT/src-tauri/Cargo.toml"

# src-tauri/tauri.conf.json
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$ROOT/src-tauri/tauri.conf.json"

# Update Cargo.lock by running cargo check
(cd "$ROOT/src-tauri" && cargo update -p mailvault 2>/dev/null || true)

echo "Updated files:"
echo "  package.json            → $NEW"
echo "  src-tauri/Cargo.toml    → $NEW"
echo "  src-tauri/tauri.conf.json → $NEW"
echo ""
echo "Done! Version is now $NEW"
