import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const INFO_PLIST = 'src-daemon/Info.plist';
const cargo = readFileSync('src-daemon/Cargo.toml', 'utf8');
const main = readFileSync('src-daemon/src/main.rs', 'utf8');
const dmgSmoke = readFileSync('tests/integration/dmg-smoke.test.js', 'utf8');

describe('mailvault-daemon macOS process classification', () => {
  it('declares exactly one daemon-specific Info.plist key: LSBackgroundOnly=true', () => {
    expect(existsSync(INFO_PLIST)).toBe(true);
    const plist = readFileSync(INFO_PLIST, 'utf8');
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
    expect(keys).toEqual(['LSBackgroundOnly']);
    expect(plist).toMatch(/<key>LSBackgroundOnly<\/key>\s*<true\/>/);
    expect(plist).not.toContain('<key>LSUIElement</key>');
  });

  it('embeds that plist only in macOS daemon builds', () => {
    const macTarget = cargo.indexOf('[target.\'cfg(target_os = "macos")\'.dependencies]');
    const nextTarget = cargo.indexOf('\n[target.', macTarget + 1);
    const macDependencies = cargo.slice(macTarget, nextTarget);
    expect(macDependencies).toMatch(/^embed_plist\s*=\s*"1\.2\.2"$/m);
    expect(main).toMatch(
      /#\[cfg\(target_os = "macos"\)\]\s*embed_plist::embed_info_plist!\("\.\.\/Info\.plist"\);/,
    );
  });

  it('checks the requested release target and fails when its bundle is missing', () => {
    expect(dmgSmoke).toMatch(/process\.env\.BUILD_TARGET/);
    expect(dmgSmoke).toMatch(/expect\(\s*bundleExists,[\s\S]*?\)\.toBe\(true\)/);
  });
});
