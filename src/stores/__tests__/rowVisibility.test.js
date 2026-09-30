// Which rows the list shows is one rule set, asked one way: `rowVisibility`.
// The derivation filters by it, and so does anything that acts on the rows the
// list holds back (the Bulk Operations pool reads the cache, which outlives the
// list's own filtering).
import { describe, it, expect, vi } from 'vitest';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

vi.mock('../../services/daemonClient', () => ({
  daemonCall: vi.fn(),
  DaemonError: class DaemonError extends Error {},
}));

const { deriveDisplayRows } = await import('../slices/messageListSlice');
const { rowVisibility } = await import('../../utils/rowVisibility');
const { tagRowKey } = await import('../tagStore');
const { localSnoozeKey } = await import('../snoozeStore');

const row = (uid, extra = {}) => ({ uid, flags: [], date: '2026-09-01T00:00:00Z', messageId: `<m${uid}>`, ...extra });
const VIEW = { activeAccountId: 'a1', activeMailbox: 'INBOX' };

describe('rowVisibility', () => {
  it('hides a \\Deleted row unless its vault copy is archived', () => {
    const visible = rowVisibility({ ...VIEW, archivedEmailIds: new Set(['a1:INBOX:2']) });
    expect(visible(row(1, { flags: ['\\Deleted'] }))).toBe(false);
    expect(visible(row(2, { flags: ['\\Deleted'] }))).toBe(true);
    expect(visible(row(3))).toBe(true);
  });

  it('hides a tombstoned row by its own folder', () => {
    const visible = rowVisibility({ ...VIEW, deleteTombstones: new Set(['a1|INBOX|1']) });
    expect(visible(row(1))).toBe(false);
    expect(visible(row(1, { _accountId: 'a1', _mailbox: 'INBOX/Sub' }))).toBe(true);
  });

  it('hides an Inbox row carrying an auto-tag "hide from Inbox" tag', () => {
    const visible = rowVisibility({
      ...VIEW, hiddenTagIds: new Set(['t']), tagsByRow: { [tagRowKey('a1', 'INBOX', 1)]: ['t'] },
    });
    expect(visible(row(1))).toBe(false);
    expect(visible(row(2))).toBe(true);
  });

  it('hides a row a local snooze holds out of its folder', () => {
    const visible = rowVisibility({ ...VIEW, localSnoozes: new Set([localSnoozeKey('a1', 'INBOX', '<m1>')]) });
    expect(visible(row(1))).toBe(false);
    expect(visible(row(2))).toBe(true);
  });

  it('shows everything when nothing is held back', () => {
    expect(rowVisibility(VIEW)(row(1))).toBe(true);
  });
});

describe('auto-tag hide in a folder branch rooted at the Inbox', () => {
  it('reads the row\'s own folder: a tag on INBOX uid 34 does not hide INBOX/Sub uid 34', () => {
    const rows = deriveDisplayRows({
      emails: [row(34, { _accountId: 'a1', _mailbox: 'INBOX' }), row(34, { _accountId: 'a1', _mailbox: 'INBOX/Sub' })],
      activeAccountId: 'a1', activeMailbox: 'INBOX',
      hiddenTagIds: new Set(['t']), tagsByRow: { [tagRowKey('a1', 'INBOX', 34)]: ['t'] },
    });
    expect(rows.map(r => r._mailbox)).toEqual(['INBOX/Sub']);
  });
});
