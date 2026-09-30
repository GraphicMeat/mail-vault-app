// What the vault holds is known per (account, folder), and a uid names a
// message only inside one of those. The two sets the list reads it from
// (`archivedEmailIds`, `savedEmailIds`) were flat Set<uid> unions across every
// account and folder in view: account A archiving its uid 5 put the vault glyph
// on account B's uid 5, let B's `\Deleted` uid 5 skip the \Deleted hiding, and
// pulled a vault row of B's uid 5 into the list.
import { describe, it, expect, beforeEach } from 'vitest';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const {
  deriveDisplayRows, deriveArchivedUnion, setArchivedGroup, _resetArchivedGroupsForTest,
} = await import('../slices/messageListSlice');

const row = (uid, mailbox, accountId, extra = {}) => ({
  uid, flags: [], date: '2026-09-01T00:00:00Z', _accountId: accountId, _mailbox: mailbox, ...extra,
});

beforeEach(() => _resetArchivedGroupsForTest());

describe('the vault sets are scoped to the folder that holds the message', () => {
  it('account A\'s archived uid 5 does not mark account B\'s uid 5 in All inboxes', () => {
    setArchivedGroup('a', 'INBOX', new Set([5]));
    setArchivedGroup('b', 'INBOX', new Set());
    const archivedEmailIds = deriveArchivedUnion(new Set(), [['a', 'INBOX'], ['b', 'INBOX']]);
    const rows = deriveDisplayRows({
      emails: [row(5, 'INBOX', 'a'), row(5, 'INBOX', 'b')],
      archivedEmailIds, unifiedInbox: true, activeAccountId: 'a', activeMailbox: 'UNIFIED',
    });
    expect(rows.map(r => `${r._accountId}:${r.isArchived}`).sort()).toEqual(['a:true', 'b:false']);
  });

  it('B\'s server-\\Deleted uid 5 stays hidden although A archived its own uid 5', () => {
    setArchivedGroup('a', 'INBOX', new Set([5]));
    const archivedEmailIds = deriveArchivedUnion(new Set(), [['a', 'INBOX'], ['b', 'INBOX']]);
    const rows = deriveDisplayRows({
      emails: [row(5, 'INBOX', 'b', { flags: ['\\Deleted'] })],
      archivedEmailIds, unifiedInbox: true, activeAccountId: 'a', activeMailbox: 'UNIFIED',
    });
    expect(rows).toEqual([]);
  });

  it('a vault row of B\'s uid 5 is not pulled into the list by A\'s archived uid 5', () => {
    setArchivedGroup('a', 'INBOX', new Set([5]));
    const archivedEmailIds = deriveArchivedUnion(new Set(), [['a', 'INBOX'], ['b', 'INBOX']]);
    const rows = deriveDisplayRows({
      emails: [], localEmails: [row(5, 'INBOX', 'b', { source: 'local' })],
      archivedEmailIds, unifiedInbox: true, activeAccountId: 'a', activeMailbox: 'UNIFIED',
    });
    expect(rows).toEqual([]);
  });

  it('the vault glyph of one folder\'s uid stays off the same uid in a sibling folder of a branch', () => {
    setArchivedGroup('a', 'Projects', new Set([34]));
    const archivedEmailIds = deriveArchivedUnion(new Set(), [['a', 'Projects']]);
    const savedEmailIds = new Set();
    const rows = deriveDisplayRows({
      emails: [row(34, 'Projects', 'a'), row(34, 'Projects/Alpha', 'a')],
      archivedEmailIds, savedEmailIds, activeAccountId: 'a', activeMailbox: 'Projects',
    });
    expect(rows.map(r => `${r._mailbox}:${r.isArchived}`).sort()).toEqual(['Projects/Alpha:false', 'Projects:true']);
  });
});
