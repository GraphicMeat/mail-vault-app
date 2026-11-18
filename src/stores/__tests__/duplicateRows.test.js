// The list shows one row per message, whichever merge path wrote `emails`.
// A user saw the same message three times in the inbox: the delta sync had
// re-added a uid the cache drain had already put in the list. The sync is
// fixed at its source (loadEmailsDrainCache.test.js); this is the last line
// of defense, so a future merge path that forgets to check the live list
// still cannot draw a message twice.
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

const row = (uid, extra = {}) => ({ uid, flags: [], date: `2026-11-17T09:${String(uid % 60).padStart(2, '0')}:00Z`, ...extra });
const VIEW = { activeAccountId: 'a1', activeMailbox: 'INBOX' };
const uids = (rows) => rows.map((e) => e.uid);

describe('deriveDisplayRows: one row per message', () => {
  for (const viewMode of ['all', 'server']) {
    it(`draws a uid repeated in emails once (${viewMode})`, () => {
      const fresh = row(7, { subject: 'fresh' });
      const out = deriveDisplayRows({ ...VIEW, viewMode, emails: [fresh, row(6), row(7), row(7)] });
      expect(uids(out).sort()).toEqual([6, 7]);
      // The first copy wins: merges prepend the row they just fetched.
      expect(out.find((e) => e.uid === 7)).toBe(fresh);
    });
  }

  it('keeps the vault copy out when the server row is already there twice', () => {
    const out = deriveDisplayRows({
      ...VIEW,
      emails: [row(7), row(7)],
      localEmails: [row(7)],
      archivedEmailIds: new Set(['a1:INBOX:7']),
    });
    expect(uids(out)).toEqual([7]);
  });

  it('keeps two messages that share a uid in different accounts (unified inbox)', () => {
    const out = deriveDisplayRows({
      ...VIEW,
      unifiedInbox: true,
      emails: [row(7, { _accountId: 'a1', _mailbox: 'INBOX' }), row(7, { _accountId: 'a2', _mailbox: 'INBOX' })],
    });
    expect(out).toHaveLength(2);
  });

  it('keeps two messages that share a uid in different folders of one account', () => {
    const out = deriveDisplayRows({
      ...VIEW,
      emails: [row(7, { _accountId: 'a1', _mailbox: 'INBOX' }), row(7, { _accountId: 'a1', _mailbox: 'Work' })],
    });
    expect(out).toHaveLength(2);
  });

  it('still collapses a true duplicate in the unified inbox', () => {
    const out = deriveDisplayRows({
      ...VIEW,
      unifiedInbox: true,
      emails: [row(7, { _accountId: 'a2', _mailbox: 'INBOX' }), row(7, { _accountId: 'a2', _mailbox: 'INBOX' })],
    });
    expect(out).toHaveLength(1);
  });

  it('never merges rows without a uid', () => {
    const out = deriveDisplayRows({ ...VIEW, emails: [{ date: '2026-11-17T09:00:00Z' }, { date: '2026-11-17T09:01:00Z' }] });
    expect(out).toHaveLength(2);
  });

  it('returns the same rows untouched when nothing repeats', () => {
    const emails = [row(3), row(2), row(1)];
    const out = deriveDisplayRows({ ...VIEW, emails });
    expect(out).toHaveLength(3);
    for (const e of emails) expect(out).toContain(e);
  });
});
