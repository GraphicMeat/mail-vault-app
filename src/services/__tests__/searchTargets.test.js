import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  ensureFreshToken: vi.fn(async account => account),
  hasValidCredentials: vi.fn(account => !!(account?.password || account?.oauth2AccessToken)),
  getAccountCacheMailboxes: vi.fn(() => null),
}));

vi.mock('../authUtils.js', () => ({
  ensureFreshToken: auth.ensureFreshToken,
  hasValidCredentials: auth.hasValidCredentials,
}));
vi.mock('../cacheManager.js', () => ({
  getAccountCacheMailboxes: auth.getAccountCacheMailboxes,
}));

const {
  buildSearchTargets,
  mailboxTreeFor,
  resolveLocalScope,
  resolveServerScope,
  serverSearchTargets,
} = await import('../searchTargets.js');

const account = (id, extra = {}) => ({ id, email: `${id}@example.com`, password: 'secret', ...extra });
const box = (name, path, extra = {}) => ({ name, path, children: [], ...extra });
const settings = (hiddenAccounts = {}) => ({ hiddenAccounts });
const filters = (folder) => ({ location: 'all', folder });

describe('serverSearchTargets', () => {
  it('excludes noselect and empty paths, deduplicates paths, and puts INBOX first', () => {
    expect(serverSearchTargets([
      box('Archive', 'Archive'),
      box('Container', 'Container', { noselect: true }),
      box('Inbox', 'inbox'),
      box('Duplicate archive', 'Archive'),
      box('Missing path', ''),
    ])).toEqual(['inbox', 'Archive']);
  });
});

describe('buildSearchTargets', () => {
  beforeEach(() => {
    auth.ensureFreshToken.mockReset().mockImplementation(async value => value);
    auth.hasValidCredentials.mockReset().mockImplementation(value => !!(value?.password || value?.oauth2AccessToken));
    auth.getAccountCacheMailboxes.mockReset().mockReturnValue(null);
  });

  it('maps unified current to the selected canonical folder across visible accounts', async () => {
    const accountA = account('a');
    const accountB = account('b');
    const accountC = account('c');
    const sentA = box('Sent Items', 'Sent Items', { specialUse: '\\Sent' });
    const sentC = box('Sent', 'Sent', { specialUse: '\\Sent' });
    auth.getAccountCacheMailboxes.mockImplementation(id => (id === 'c' ? [sentC] : [box('INBOX', 'INBOX')]));
    const mail = {
      accounts: [accountA, accountB, accountC],
      activeAccountId: 'a',
      activeMailbox: 'UNIFIED',
      unifiedInbox: true,
      unifiedFolder: 'Sent',
      mailboxes: [sentA],
    };

    const targets = await buildSearchTargets(mail, settings({ b: true }), filters('current'));

    expect(targets.map(target => [target.accountId, target.localMailboxes, target.serverMailboxes])).toEqual([
      ['a', ['Sent Items'], ['Sent Items']],
      ['c', ['Sent'], ['Sent']],
    ]);
    expect(targets[0].knownMailboxes).toEqual(['Sent Items']);
    expect(auth.ensureFreshToken).toHaveBeenCalledTimes(2);
  });

  it('maps unified all to every selectable server folder but all local directories', async () => {
    const tree = [
      box('Archive', 'Archive'),
      box('INBOX', 'INBOX'),
      box('Container', 'Container', { noselect: true }),
      box('Child', 'Container/Child'),
    ];
    const mail = {
      accounts: [account('a')],
      activeAccountId: 'a',
      activeMailbox: 'UNIFIED',
      unifiedInbox: true,
      unifiedFolder: 'INBOX',
      mailboxes: tree,
    };

    const [target] = await buildSearchTargets(mail, settings(), filters('all'));

    expect(target.localMailboxes).toBeNull();
    expect(target.serverMailboxes).toEqual(['INBOX', 'Archive', 'Container/Child']);
    expect(target.knownMailboxes).toEqual(['INBOX', 'Archive', 'Container/Child']);
  });

  it('keeps Graph local and emits no remote server work', async () => {
    const mail = {
      accounts: [account('graph', { oauth2Transport: 'graph', authType: 'oauth2', oauth2AccessToken: 'token' })],
      activeAccountId: 'graph',
      activeMailbox: 'INBOX',
      unifiedInbox: false,
      mailboxes: [box('INBOX', 'INBOX')],
    };

    const [target] = await buildSearchTargets(mail, settings(), filters('all'));

    expect(target.account).toBeNull();
    expect(target.serverMailboxes).toEqual([]);
    expect(target.localMailboxes).toBeNull();
    expect(auth.ensureFreshToken).not.toHaveBeenCalled();
  });

  it('keeps a named-folder search scoped to the active account in unified mode', async () => {
    const mail = {
      accounts: [account('a'), account('b')],
      activeAccountId: 'b',
      activeMailbox: 'INBOX',
      unifiedInbox: true,
      unifiedFolder: 'INBOX',
      mailboxes: [box('Archive', 'Archive'), box('INBOX', 'INBOX')],
    };
    auth.getAccountCacheMailboxes.mockReturnValue([box('Archive', 'Archive'), box('INBOX', 'INBOX')]);

    const targets = await buildSearchTargets(mail, settings(), filters('Archive'));

    expect(targets.map(target => target.accountId)).toEqual(['b']);
    expect(targets[0].localMailboxes).toEqual(['Archive']);
    expect(targets[0].serverMailboxes).toEqual(['Archive']);
  });

  it('keeps subtree local scope complete but removes noselect containers from server scope', async () => {
    const tree = [
      box('Work', 'Work', { delimiter: '/', noselect: true }),
      box('Project', 'Work/Project', { delimiter: '/' }),
      box('Old', 'Work-Old', { delimiter: '/' }),
    ];
    const mail = {
      accounts: [account('a'), account('b')],
      activeAccountId: 'a',
      activeMailbox: 'INBOX',
      unifiedInbox: false,
      mailboxes: tree,
    };

    const targets = await buildSearchTargets(mail, settings(), filters('sub:Work'));

    expect(targets.map(target => target.accountId)).toEqual(['a']);
    expect(targets[0].localMailboxes).toEqual(['Work', 'Work/Project']);
    expect(targets[0].serverMailboxes).toEqual(['Work/Project']);
  });

  it('omits hidden accounts and returns no targets when every account is hidden', async () => {
    const mail = {
      accounts: [account('a'), account('b')],
      activeAccountId: 'a',
      activeMailbox: 'INBOX',
      unifiedInbox: true,
      mailboxes: [box('INBOX', 'INBOX')],
    };

    expect(await buildSearchTargets(mail, settings({ b: true }), filters('all'))).toHaveLength(1);
    await expect(buildSearchTargets(mail, settings({ a: true, b: true }), filters('all'))).resolves.toEqual([]);
  });

  it('uses the active mailbox for current scope and the cached tree for inactive accounts', async () => {
    const activeTree = [box('INBOX', 'INBOX'), box('Archive', 'Archive')];
    const cachedTree = [box('INBOX', 'INBOX'), box('Sent', 'Sent')];
    const mail = {
      accounts: [account('a')],
      activeAccountId: 'a',
      activeMailbox: 'Archive',
      unifiedInbox: false,
      unifiedFolder: 'INBOX',
      mailboxes: activeTree,
    };
    auth.getAccountCacheMailboxes.mockReturnValue(cachedTree);

    expect(resolveServerScope(mail.accounts[0], activeTree, mail, 'current')).toEqual(['Archive']);
    expect(resolveLocalScope(activeTree, mail, 'current')).toEqual(['Archive']);
    await expect(mailboxTreeFor('a', mail)).resolves.toBe(activeTree);
    await expect(mailboxTreeFor('other', mail)).resolves.toBe(cachedTree);
  });
});
