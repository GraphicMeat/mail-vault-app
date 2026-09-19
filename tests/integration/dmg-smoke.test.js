import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { execFileSync, execSync } from 'child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const APP_BUNDLE = resolve(ROOT, 'target/release/bundle/macos/MailVault.app');
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
    if (!bundleExists) {
      console.log('Skipping: app bundle not found');
      return;
    }
    const value = execFileSync(
      'plutil',
      ['-extract', 'LSBackgroundOnly', 'raw', '-o', '-', DAEMON_BIN],
      { encoding: 'utf8' },
    );
    expect(value.trim()).toBe('true');
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
