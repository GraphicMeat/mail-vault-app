import { describe, expect, it, vi } from 'vitest';

const folders = vi.hoisted(() => ({
  'acct-b': [{ path: 'INBOX' }, { path: 'Spam', specialUse: '\\Junk' }],
  'acct-c': [{ path: 'INBOX' }],
}));
vi.mock('../../services/cacheManager', () => ({ getAccountCacheMailboxes: accountId => folders[accountId] }));
vi.mock('../../services/workflows/snooze', () => ({ canSnooze: email => !!email.messageId }));

const { rowFacts, selectionFacts, archivedSelectionKeys, readerFacts, junkPathOf } = await import('../quickActionFacts');

const STATE = {
  activeAccountId: 'acct-a', activeMailbox: 'INBOX', mailboxScope: null,
  mailboxes: [{ path: 'INBOX' }, { name: 'Junk', specialUse: '\\Junk' }],
  localFolders: { 'acct-a': [{ name: 'Imported' }] },
};
const mail = (uid, overrides = {}) => ({
  uid, messageId: `<${uid}@x>`, date: `2026-01-0${uid}T00:00:00Z`, from: { address: `s${uid}@x.test`, name: `S${uid}` },
  flags: [], isArchived: false, source: 'server', _accountId: 'acct-a', _mailbox: 'INBOX', ...overrides,
});

describe('junkPathOf', () => {
  it('names the Junk folder by path, or by name when it has none', () => {
    expect(junkPathOf(STATE, 'acct-a')).toBe('Junk');
    expect(junkPathOf(STATE, 'acct-b')).toBe('Spam');
    expect(junkPathOf(STATE, 'acct-c')).toBeNull();
  });
});

describe('rowFacts', () => {
  it('a thread acts through its newest message and one account', () => {
    const facts = rowFacts([mail(1, { flags: ['\\Seen'] }), mail(3), mail(2, { listUnsubscribe: '<mailto:u@x>' })], STATE, { canConfirm: true });
    expect(facts.primary.uid).toBe(3);
    expect(facts.sender).toBe('s3@x.test');
    expect(facts.has).toMatchObject({ markRead: true, markUnread: true });
    expect(facts).toMatchObject({ resolved: true, accountId: 'acct-a', mailbox: 'INBOX', junkPath: 'Junk', serverActions: true });
    expect(facts.unsubscribe.email.uid).toBe(2);
    expect(facts.can.delete).toBe(true);
  });

  it('two accounts: no one account and no junk to move to', () => {
    const facts = rowFacts([mail(1), mail(2, { _accountId: 'acct-b' })], STATE);
    expect(facts).toMatchObject({ accountId: null, junkPath: null, mailbox: 'INBOX' });
  });

  // Server view writes isArchived false on every row it lists; the open
  // folder's archived uids still name what the vault holds. Another folder's
  // or account's uid is never read there.
  it('reads a row of the open folder as archived when the folder\'s archived uids hold it', () => {
    const state = { ...STATE, archivedEmailIds: new Set(['acct-a:INBOX:1']) };
    const facts = rowFacts([mail(1)], state);
    expect(facts.has).toMatchObject({ archive: false, unarchive: true });
    expect(facts.purge).toMatchObject({ label: 'Delete from server and vault' });
    expect(rowFacts([mail(1, { _accountId: 'acct-b' })], state).has).toMatchObject({ archive: true, unarchive: false });
  });

  it('a vault-only folder: no server action and no purge', () => {
    const facts = rowFacts([mail(1, { _mailbox: 'Imported', isArchived: true })], STATE);
    expect(facts).toMatchObject({ localFolder: true, serverActions: false, purge: null });
  });
});

describe('selectionFacts', () => {
  it('counts archived keys by uid and needs every key resolved', () => {
    const rows = [mail(1, { isArchived: true }), mail(2)];
    const facts = selectionFacts(new Set([1, 2]), rows, rows, new Set([1]), STATE);
    expect(facts).toMatchObject({ archivedCount: 1, totalCount: 2, fullyResolved: true, resolved: true, serverActions: true });
    expect(facts.has).toMatchObject({ archive: true, unarchive: true });
    const partial = selectionFacts(new Set([1, 2, 9]), rows, rows, new Set(), STATE);
    expect(partial).toMatchObject({ fullyResolved: false, resolved: false, serverActions: false, snooze: false, accountId: null });
  });

  // `archivedIds` is the open folder's uids; a message of another account or
  // folder is keyed `account:mailbox:uid` and its row says whether the vault
  // holds it, as the row menu reads it.
  it('reads a resolved row\'s archived state off the row, whatever its key', () => {
    const other = mail(12, { _accountId: 'acct-b', isArchived: true });
    const facts = selectionFacts(new Set(['acct-b:INBOX:12']), [other], [other], new Set(), STATE);
    expect(facts.has).toMatchObject({ archive: false, unarchive: true });
    expect(facts).toMatchObject({ archivedCount: 1, totalCount: 1 });
  });

  // The row's rule: a purge names the places beyond the server it reaches,
  // and there is none while the server holds the only copy.
  it('offers a purge only where a vault or backup copy exists, never in a vault-only folder', () => {
    const server = [mail(1), mail(2)];
    expect(selectionFacts(new Set([1, 2]), server, server, new Set(), STATE).purge).toBeNull();
    expect(selectionFacts(new Set([1, 2]), server, server, new Set(), STATE, { backedUp: true }).purge)
      .toMatchObject({ label: 'Delete from server and backup' });
    const archived = [mail(1, { isArchived: true }), mail(2)];
    expect(selectionFacts(new Set([1, 2]), archived, archived, new Set(['acct-a:INBOX:1']), STATE).purge)
      .toMatchObject({ label: 'Delete from server and vault' });
    const local = [mail(1, { _mailbox: 'Imported', isArchived: true })];
    expect(selectionFacts(new Set(['acct-a:Imported:1']), local, local, new Set(), STATE, { backedUp: true }).purge).toBeNull();
  });

  it('offers Unarchive for a bare key the open folder holds archived, whatever its row says (Server view)', () => {
    const rows = [mail(1), mail(2)];
    const facts = selectionFacts(new Set([1, 2]), rows, rows, new Set(['acct-a:INBOX:1']), STATE);
    expect(facts).toMatchObject({ archivedCount: 1, totalCount: 2 });
    expect(facts.has).toMatchObject({ archive: true, unarchive: true });
  });

  it('falls back to the vault\'s keys only for a key no row resolves, each in its own folder', () => {
    const rows = [mail(1)];
    const facts = selectionFacts(new Set([1, 9, 'acct-b:INBOX:9']), rows, rows, new Set(['acct-a:INBOX:9']), STATE);
    expect(facts).toMatchObject({ archivedCount: 1, totalCount: 3 });
    expect(facts.has).toMatchObject({ archive: true, unarchive: true });
  });
});

// The bulk modal's counts and its Unarchive run read the ticked keys by the
// selection bar's rule, not by the open folder's uids alone.
describe('archivedSelectionKeys', () => {
  it('names the ticked keys the vault holds: a row by its own state, a key no row resolves by its own folder', () => {
    const rows = [mail(1), mail(3, { isArchived: true }), mail(12, { _accountId: 'acct-b', isArchived: true })];
    const keys = new Set([1, 3, 9, 7, 'acct-b:INBOX:12', 'acct-b:INBOX:9']);
    expect(archivedSelectionKeys(keys, rows, new Set(['acct-a:INBOX:9']), STATE)).toEqual([3, 9, 'acct-b:INBOX:12']);
  });

  // Server view writes isArchived false on every row it lists, while the vault's
  // keys still name what it holds.
  it('counts a bare key the open folder holds archived even when its row says not', () => {
    const rows = [mail(1), mail(2)];
    expect(archivedSelectionKeys(new Set([1, 2]), rows, new Set(['acct-a:INBOX:1']), STATE)).toEqual([1]);
  });

  // The list's row comes first and carries the derived state; a vault row the
  // server row shadows is never re-derived, so it must not win the key.
  it('reads the first loaded row a key names, as the selection bar resolves it', () => {
    const rows = [mail(4, { isArchived: true }), mail(4, { isArchived: undefined })];
    expect(archivedSelectionKeys(new Set([4]), rows, new Set(), STATE)).toEqual([4]);
  });
});

describe('readerFacts', () => {
  it('reads the host: its handlers, its read state and the configured pairs', () => {
    const facts = readerFacts(mail(1, { flags: ['\\Flagged'] }), STATE, { onReply: () => {}, isRead: true, isLocalOnly: false },
      [{ action: 'star' }, { action: 'unstar' }, { action: 'archive' }]);
    expect(facts.can).toMatchObject({ reply: true, replyAll: false, tag: false });
    expect(facts.has).toMatchObject({ markRead: false, markUnread: true, unstar: true });
    expect(facts.explicit).toEqual({ star: true, archive: false });
  });

  it('no message: not present, nothing placed', () => {
    expect(readerFacts(null, STATE, {})).toMatchObject({ present: false, resolved: false, snooze: false });
  });
});
