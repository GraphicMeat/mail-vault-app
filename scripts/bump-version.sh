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
# Store build number: one integer for CFBundleVersion and Android versionCode. It only ever
# grows with the version; BUILD (0..99, env MV_BUILD at release time) re-sends a rejected upload.
if (( MINOR > 99 || PATCH > 99 )); then
  echo "Error: minor and patch must stay <= 99 for the mobile build number ($NEW)"
  exit 1
fi
MOBILE_CODE=$((MAJOR * 1000000 + MINOR * 10000 + PATCH * 100))
TODAY=$(date +%Y-%m-%d)

echo "Bumping version: $CURRENT → $NEW"

# ── Deterministic version replacement ──
# Uses pattern-based sed that matches any semver, not just $CURRENT.
# This ensures drifted files are corrected.

# package.json: "version": "X.Y.Z"
sed -i '' 's/"version": *"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"/"version": "'"$NEW"'"/' "$ROOT/package.json"

# package-lock.json: top-level .version and .packages[""].version
# JSON-parsed rather than sed'd — the file has a "version" line for every dependency
node -e '
  const fs = require("fs"), p = process.argv[1], o = JSON.parse(fs.readFileSync(p, "utf8"));
  o.version = process.argv[2];
  if (o.packages && o.packages[""]) o.packages[""].version = process.argv[2];
  fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
' "$ROOT/package-lock.json" "$NEW"

# src-tauri/Cargo.toml: version = "X.Y.Z" under [package] (first occurrence)
# macOS sed doesn't support 0, address — use awk for first-match-only replacement
awk -v new="$NEW" '!done && /^version = "[0-9]+\.[0-9]+\.[0-9]+"/ { sub(/version = "[0-9]+\.[0-9]+\.[0-9]+"/, "version = \"" new "\""); done=1 } 1' "$ROOT/src-tauri/Cargo.toml" > "$ROOT/src-tauri/Cargo.toml.tmp" && mv "$ROOT/src-tauri/Cargo.toml.tmp" "$ROOT/src-tauri/Cargo.toml"

# src-tauri/tauri.conf.json: "version": "X.Y.Z"
sed -i '' 's/"version": *"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"/"version": "'"$NEW"'"/' "$ROOT/src-tauri/tauri.conf.json"

# snap/snapcraft.yaml: version: 'X.Y.Z'
sed -i '' "s/^version: '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*'/version: '$NEW'/" "$ROOT/snap/snapcraft.yaml"

# Mobile shell: iOS version keys (xcodegen source and the generated plist) and the Android
# properties file that build.gradle.kts reads. The build number is the BUILD 0 value.
MOBILE="$ROOT/src-tauri-mobile"
sed -i '' "s/^\( *CFBundleShortVersionString:\) .*/\1 $NEW/; s/^\( *CFBundleVersion:\) .*/\1 \"$MOBILE_CODE\"/" "$MOBILE/gen/apple/project.yml"
perl -0pi -e 's|(<key>CFBundleShortVersionString</key>\s*<string>)[^<]*|${1}'"$NEW"'|; s|(<key>CFBundleVersion</key>\s*<string>)[^<]*|${1}'"$MOBILE_CODE"'|' "$MOBILE/gen/apple/mailvault-mobile_iOS/Info.plist"
printf '# Written by scripts/bump-version.sh. versionCode is the build 0 number; MV_BUILD (0..99) is added at release time.\nversionName=%s\nversionCode=%s\n' "$NEW" "$MOBILE_CODE" > "$MOBILE/version.properties"

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

# ── Homepage JSON-LD and the locale pages built from it ──
# Locale homepages copy these two values, and a test compares them byte for byte.
sed -i '' 's/"softwareVersion": *"[^"]*"/"softwareVersion": "'"$NEW"'"/; s/"datePublished": *"[^"]*"/"datePublished": "'"$TODAY"'"/' "$ROOT/website/index.html"
cp "$ROOT/website/index.html" "$ROOT/index.html"
node "$ROOT/website/i18n/i18n.mjs" build

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
verify_version "$ROOT/package-lock.json" "\"version\": \"$NEW\"" "package-lock.json"
verify_version "$ROOT/website/index.html" "\"softwareVersion\": \"$NEW\"" "website/index.html"
verify_version "$MOBILE/gen/apple/project.yml" "CFBundleShortVersionString: $NEW" "mobile project.yml"
verify_version "$MOBILE/gen/apple/project.yml" "CFBundleVersion: \"$MOBILE_CODE\"" "mobile project.yml build number"
verify_version "$MOBILE/gen/apple/mailvault-mobile_iOS/Info.plist" "<string>$NEW</string>" "mobile Info.plist"
verify_version "$MOBILE/gen/apple/mailvault-mobile_iOS/Info.plist" "<string>$MOBILE_CODE</string>" "mobile Info.plist build number"
verify_version "$MOBILE/version.properties" "versionCode=$MOBILE_CODE" "mobile version.properties"
# A frozen page or a broken build leaves a locale homepage on the old version.
for page in $(git -C "$ROOT" grep -l '"softwareVersion"' -- index.html 'website/*/index.html'); do
  verify_version "$ROOT/$page" "\"softwareVersion\": \"$NEW\"" "$page"
done

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "ERROR: $ERRORS file(s) have version mismatches after bump!"
  exit 1
fi

# The release commit's own file list does not name these, so they go in here.
git -C "$ROOT" add -- 'website/*/index.html' website/sitemap.xml

echo ""
echo "Updated files:"
echo "  package.json            → $NEW"
echo "  package-lock.json       → $NEW"
echo "  src-tauri/Cargo.toml    → $NEW"
echo "  src-tauri/tauri.conf.json → $NEW"
echo "  snap/snapcraft.yaml     → $NEW"
echo "  src-tauri-mobile (project.yml, Info.plist, version.properties) → $NEW, build number $MOBILE_CODE"
echo "  website/index.html, index.html → softwareVersion $NEW, datePublished $TODAY"
echo "  website/*/index.html, website/sitemap.xml → rebuilt and staged"
echo ""
echo "Done! Version is now $NEW"
