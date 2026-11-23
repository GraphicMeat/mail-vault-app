import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { previousDmgName } from '../../scripts/nightly-previous-dmg.mjs';

// 2026-11-23: a Sparkle session opened by its own scheduled check held the
// 03:28 nightly for 20 hours. The next nightly replaced the prerelease and its
// DMG, so "Update" downloaded a 404. Two guards, one per side.

describe('nightly publish keeps the DMG the old feed points at', () => {
  const appcast = (url) => `<?xml version="1.0"?><rss><channel><item>
    <sparkle:version>2.25.0.20261122.0328</sparkle:version>
    <enclosure url="${url}" sparkle:edSignature="x" length="1" type="application/octet-stream"/>
  </item></channel></rss>`;

  it('names the DMG of the feed being replaced', () => {
    expect(previousDmgName(appcast('https://github.com/GraphicMeat/mail-vault-app/releases/download/nightly/MailVault-v2.25.0-nightly.202611220328.geaec8c3.dmg')))
      .toBe('MailVault-v2.25.0-nightly.202611220328.geaec8c3.dmg');
  });

  it('names nothing for a feed with no DMG or no feed at all', () => {
    expect(previousDmgName('')).toBe('');
    expect(previousDmgName(appcast('https://example.com/a/../../etc/passwd'))).toBe('');
  });

  it('re-uploads that DMG beside the new one', () => {
    const yml = readFileSync('.github/workflows/nightly.yml', 'utf8');
    const read = yml.indexOf('nightly-previous-dmg.mjs');
    const del = yml.indexOf('gh release delete nightly');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(del);
    expect(yml.slice(del)).toMatch(/gh release create nightly[\s\S]*\$\{PREV_DMG_PATH/);
  });
});

describe('Sparkle never holds an update session of its own', () => {
  // Sparkle's scheduler opens a session that waits on the user indefinitely,
  // pinned to the item it found. The app runs its own daily probe instead.
  it('turns off Sparkle scheduled checks without a permission prompt', () => {
    const plist = readFileSync('src-tauri/Info.plist', 'utf8');
    expect(plist).toMatch(/<key>SUEnableAutomaticChecks<\/key>\s*<false\/>/);
  });
});
