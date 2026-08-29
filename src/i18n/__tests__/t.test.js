import { describe, it, expect } from 'vitest';
import { t } from '../index.js';

describe('t', () => {
  it('returns the English string for a known key', () => {
    expect(t('sidebar.allInboxes')).toBe('All Inboxes');
  });

  it('interpolates {{vars}}', () => {
    expect(t('sidebar.lastNDays', { n: 7 })).toBe('Last 7 days');
  });

  it('leaves an unmatched placeholder alone rather than printing undefined', () => {
    expect(t('sidebar.lastNDays')).toBe('Last {{n}} days');
  });

  it('returns the key itself when nothing matches, so the miss is visible', () => {
    expect(t('nope.not.here')).toBe('nope.not.here');
  });
});
