/**
 * A standalone binary signed with app-sandbox and WITHOUT inherit aborts in
 * libsystem_secinit before main(). The MAS build must give the daemon exactly
 * app-sandbox + inherit, and never re-sign it with the app's entitlements via --deep.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const script = readFileSync('scripts/build-appstore.sh', 'utf8');
const plist = readFileSync('src-daemon/entitlements-appstore.plist', 'utf8');

describe('MAS daemon signing', () => {
  it('the daemon plist holds exactly app-sandbox and inherit, both true', () => {
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]).sort();
    expect(keys).toEqual(['com.apple.security.app-sandbox', 'com.apple.security.inherit']);
    expect([...plist.matchAll(/<key>/g)].length).toBe(2);
  });

  it('signs the daemon with its own plist, not the app entitlements', () => {
    const block = script.slice(script.indexOf('DAEMON_PATH='), script.indexOf('# Sign any frameworks'));
    expect(block).toContain('src-daemon/entitlements-appstore.plist');
    expect(block).not.toContain('"$ENTITLEMENTS"');
  });

  it('never signs with --deep', () => {
    expect(script).not.toMatch(/codesign[^\n]*--deep/);
  });

  it('fails the build when the signed daemon lacks inherit', () => {
    expect(script).toMatch(/codesign -d --entitlements - "\$DAEMON_PATH"[^\n]*\n?[^\n]*com\.apple\.security\.inherit/);
    expect(script).toMatch(/inherit[\s\S]{0,200}exit 1/);
  });
});
