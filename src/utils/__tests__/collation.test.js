import { describe, it, expect, afterEach } from 'vitest';
import { setLocale } from '../../i18n/index.js';
import { compareNames } from '../collation.js';

afterEach(async () => { await setLocale('en'); });

describe('compareNames', () => {
  it('sorts German umlauts as their base letter, not after Z', async () => {
    await setLocale('de');
    expect(['Zebra', 'Über', 'Apfel'].sort(compareNames)).toEqual(['Apfel', 'Über', 'Zebra']);
  });

  it('is case-insensitive, so a lowercase name is not exiled to the end', () => {
    expect(['beta', 'Alpha', 'gamma'].sort(compareNames)).toEqual(['Alpha', 'beta', 'gamma']);
  });

  it('orders digits naturally, so Folder 10 follows Folder 9', () => {
    expect(['Folder 10', 'Folder 9', 'Folder 1'].sort(compareNames))
      .toEqual(['Folder 1', 'Folder 9', 'Folder 10']);
  });

  it('differs from a code-point sort, which is the whole point', async () => {
    await setLocale('de');
    const input = ['Zebra', 'Über', 'Apfel'];
    expect([...input].sort(compareNames)).not.toEqual([...input].sort());
  });
});

/**
 * A bare `localeCompare(x)` uses the RUNTIME's default locale, not the app's —
 * so a German reader gets German ordering only by accident of their OS. Every
 * human-name sort must go through compareNames, which passes getLocale().
 */
describe('no bare localeCompare survives in src', () => {
  it('routes every name comparison through compareNames', async () => {
    const { execSync } = await import('node:child_process');
    const out = execSync(
      "grep -rn 'localeCompare(' src --include='*.js' --include='*.jsx' | grep -v __tests__ | grep -v getLocale || true",
      { encoding: 'utf8' }
    ).trim();
    expect(out).toBe('');
  });
});
