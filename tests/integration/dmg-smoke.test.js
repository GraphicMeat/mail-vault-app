import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { execFileSync, execSync } from 'child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const RELEASE_DIR = process.env.BUILD_TARGET
  ? resolve(ROOT, 'target', process.env.BUILD_TARGET, 'release')
  : resolve(ROOT, 'target/release');
const APP_BUNDLE = resolve(RELEASE_DIR, 'bundle/macos/MailVault.app');
const DAEMON_BIN = resolve(APP_BUNDLE, 'Contents/MacOS/mailvault-daemon');

const bundleExists = existsSync(APP_BUNDLE);

describe('Post-Build DMG Smoke Tests', () => {
  it('app bundle exists and is signed', () => {
    if (!bundleExists) {
      console.log('Skipping: app bundle not found — run build-developer-id.sh first');
      return;
    }
    expect(existsSync(APP_BUNDLE)).toBe(true);
    const result = execSync(`codesign -v --strict "${APP_BUNDLE}" 2>&1`, {
      encoding: 'utf-8',
    });
    // codesign -v outputs nothing on success, throws on failure
    expect(result.trim()).toBe('');
  });

  it('daemon binary exists and is signed', () => {
    if (!bundleExists) {
      console.log('Skipping: app bundle not found');
      return;
    }
    expect(existsSync(DAEMON_BIN)).toBe(true);
    const result = execSync(`codesign -v --strict "${DAEMON_BIN}" 2>&1`, {
      encoding: 'utf-8',
    });
    expect(result.trim()).toBe('');
  });

  it('packaged daemon declares itself background-only', () => {
    expect(
      bundleExists,
      `App bundle not found at ${APP_BUNDLE}; set BUILD_TARGET for targeted release builds`,
    ).toBe(true);
    const section = execFileSync('otool', ['-s', '__TEXT', '__info_plist', DAEMON_BIN], {
      encoding: 'utf8',
    });
    const words = section.split('\n').flatMap((line) => {
      const match = line.match(/^\s*[0-9a-f]{12,16}\s+((?:[0-9a-f]{8}\s*)+)$/i);
      return match ? match[1].trim().split(/\s+/) : [];
    });
    const plist = Buffer.concat(
      words.map((word) => Buffer.from(word.match(/../g).reverse().join(''), 'hex')),
    ).toString('utf8');
    expect(plist).toMatch(/<key>LSBackgroundOnly<\/key>\s*<true\/>/);
  });

  it('legacy mailvault-server sidecar is absent', () => {
    if (!bundleExists) {
      console.log('Skipping: app bundle not found');
      return;
    }
    const legacy = resolve(APP_BUNDLE, 'Contents/MacOS/mailvault-server');
    expect(existsSync(legacy)).toBe(false);
  });
});
