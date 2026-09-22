import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDaemonCall = vi.fn();
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => mockDaemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));

const { tagRowKey } = await import('../../stores/tagStore');
const { filterHiddenFromInbox, rowMailbox } = await import('../autoTagInboxFilter');

beforeEach(() => {
  mockDaemonCall.mockReset();
});

// The important test: `inboxAction: 'hide'` is a fact stored in the daemon
// only — src-daemon/src/handlers/auto_tags.rs never moves or deletes a
// message. Hiding it from the Inbox listing is entirely this filter's job.
describe('filterHiddenFromInbox', () => {
  const hiddenTagIds = new Set(['hide-tag']);

  it('drops an Inbox row carrying a hidden tag', () => {
    const rows = [{ uid: 1 }, { uid: 2 }];
    const tagsByRow = { [tagRowKey('a1', 'INBOX', 1)]: ['hide-tag'] };
    const result = filterHiddenFromInbox(rows, {
      hiddenTagIds, tagsByRow, unifiedInbox: false, activeMailbox: 'INBOX', activeAccountId: 'a1',
    });
    expect(result.map(r => r.uid)).toEqual([2]);
  });

  it('leaves a row with no recorded tags visible — never hides on a guess', () => {
    const rows = [{ uid: 1 }];
    const result = filterHiddenFromInbox(rows, {
      hiddenTagIds, tagsByRow: {}, unifiedInbox: false, activeMailbox: 'INBOX', activeAccountId: 'a1',
    });
    expect(result).toHaveLength(1);
  });

  it('leaves a row with an unrelated tag visible', () => {
    const rows = [{ uid: 1 }];
    const tagsByRow = { [tagRowKey('a1', 'INBOX', 1)]: ['some-other-tag'] };
    const result = filterHiddenFromInbox(rows, {
      hiddenTagIds, tagsByRow, unifiedInbox: false, activeMailbox: 'INBOX', activeAccountId: 'a1',
    });
    expect(result).toHaveLength(1);
  });

  it('never touches a non-Inbox mailbox — the message stays reachable in its own folder', () => {
    const rows = [{ uid: 1 }];
    const tagsByRow = { [tagRowKey('a1', 'Archive', 1)]: ['hide-tag'] };
    const result = filterHiddenFromInbox(rows, {
      hiddenTagIds, tagsByRow, unifiedInbox: false, activeMailbox: 'Archive', activeAccountId: 'a1',
    });
    expect(result).toHaveLength(1);
  });

  it('resolves a unified-inbox row default mailbox the same way _resolveUnifiedContext does', () => {
    const rows = [{ uid: 1, _accountId: 'a1' }]; // no _mailbox -> defaults to INBOX
    const tagsByRow = { [tagRowKey('a1', 'INBOX', 1)]: ['hide-tag'] };
    const result = filterHiddenFromInbox(rows, {
      hiddenTagIds, tagsByRow, unifiedInbox: true, activeMailbox: 'UNIFIED', activeAccountId: null,
    });
    expect(result).toHaveLength(0);
  });

  it('a unified row explicitly in Sent is never hidden by an Inbox-only rule', () => {
    const rows = [{ uid: 1, _accountId: 'a1', _mailbox: 'Sent' }];
    const tagsByRow = { [tagRowKey('a1', 'Sent', 1)]: ['hide-tag'] };
    const result = filterHiddenFromInbox(rows, {
      hiddenTagIds, tagsByRow, unifiedInbox: true, activeMailbox: 'UNIFIED', activeAccountId: null,
    });
    expect(result).toHaveLength(1);
  });

  it('is a no-op with no hide rule at all — the common case pays nothing', () => {
    const rows = [{ uid: 1 }];
    const result = filterHiddenFromInbox(rows, {
      hiddenTagIds: new Set(), tagsByRow: {}, unifiedInbox: false, activeMailbox: 'INBOX', activeAccountId: 'a1',
    });
    expect(result).toBe(rows);
  });

  it('is a no-op when tagsByRow was never supplied', () => {
    const rows = [{ uid: 1 }];
    const result = filterHiddenFromInbox(rows, {
      hiddenTagIds, tagsByRow: null, unifiedInbox: false, activeMailbox: 'INBOX', activeAccountId: 'a1',
    });
    expect(result).toBe(rows);
  });
});

describe('rowMailbox', () => {
  it('is the active mailbox outside unified inbox', () => {
    expect(rowMailbox({ uid: 1 }, false, 'Archive')).toBe('Archive');
  });

  it('defaults an unstamped unified row to INBOX', () => {
    expect(rowMailbox({ uid: 1 }, true, 'UNIFIED')).toBe('INBOX');
  });

  it('honors a unified rows own _mailbox stamp', () => {
    expect(rowMailbox({ uid: 1, _mailbox: 'Sent' }, true, 'UNIFIED')).toBe('Sent');
  });
});
