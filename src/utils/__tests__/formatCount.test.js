import { describe, it, expect, afterEach } from 'vitest';
import { setLocale } from '../../i18n/index.js';
import { formatCount } from '../formatCount.js';

afterEach(async () => { await setLocale('en'); });

describe('formatCount', () => {
  it('groups thousands for the current app locale', () => {
    expect(formatCount(15067)).toBe('15,067');
  });

  it('follows the app locale, not whatever the runtime defaults to', async () => {
    await setLocale('de');
    expect(formatCount(15067)).toBe('15.067');
  });
});

/**
 * A bare `n.toLocaleString()` groups thousands by the RUNTIME's default
 * locale, not the one the user picked in Settings — same class of bug
 * collation.js's compareNames guards against for sorting (see
 * `no bare localeCompare survives in src`). A Windows box whose OS locale is
 * lt-LT showed "15 067" instead of "15,067" to a user with the app set to
 * English before every call site below went through formatCount.
 */
describe('no bare toLocaleString survives in src', () => {
  it('routes every count through formatCount', async () => {
    const { grepSource } = await import('../../../scripts/lib/sourceFiles.mjs');
    const out = grepSource(['src'], ['.js', '.jsx'], /\.toLocaleString\(\)/, {
      exclude: ['__tests__', 'formatCount.js', 'console.log'],
    });
    expect(out).toEqual([]);
  });
});
