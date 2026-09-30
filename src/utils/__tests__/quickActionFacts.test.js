import { describe, expect, it, vi } from 'vitest';

const folders = vi.hoisted(() => ({
  'acct-b': [{ path: 'INBOX' }, { path: 'Spam', specialUse: '\\Junk' }],
  'acct-c': [{ path: 'INBOX' }],
}));
vi.mock('../../services/cacheManager', () => ({ getAccountCacheMailboxes: accountId => folders[accountId] }));
vi.mock('../../services/workflows/snooze', () => ({ canSnooze: email => !!email.messageId }));

const { rowFacts, selectionFacts, readerFacts, junkPathOf } = await import('../quickActionFacts');

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
