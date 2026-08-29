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

describe('t plurals', () => {
  it('picks the _one form at count 1', () => {
    expect(t('inbox.unread', { count: 1 })).toBe('1 unread message');
  });

  it('picks the _other form at count 2', () => {
    expect(t('inbox.unread', { count: 2 })).toBe('2 unread messages');
  });

  it('picks the _other form at count 0 in English', () => {
    expect(t('inbox.unread', { count: 0 })).toBe('0 unread messages');
  });

  it('falls back to the bare key when no plural forms exist', () => {
    expect(t('sidebar.allInboxes', { count: 3 })).toBe('All Inboxes');
  });
});
