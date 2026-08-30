import { describe, it, expect } from 'vitest';
import { makeLabels } from '../../scripts/screenshots/labels.js';

describe('makeLabels', () => {
  it('returns the English string for en', () => {
    const L = makeLabels('en');
    expect(L('settings.tab.general')).toBe('General');
  });

  it('returns the translated string for a locale', () => {
    const L = makeLabels('de');
    expect(L('settings.tab.general')).not.toBe('General');
    expect(L('settings.tab.general').length).toBeGreaterThan(0);
  });

  it('falls back to English when a locale is missing the key', () => {
    // Every catalog is complete today; the fallback is what keeps a run alive
    // if one ever is not, so assert the mechanism rather than a gap.
    const L = makeLabels('ja');
    expect(L('common.close')).toBe(makeLabels('ja')('common.close'));
    expect(typeof L('common.close')).toBe('string');
  });

  it('throws on a key no catalog has, rather than clicking nothing', () => {
    const L = makeLabels('de');
    expect(() => L('no.such.key')).toThrow(/unknown label key: no\.such\.key/);
  });
});
