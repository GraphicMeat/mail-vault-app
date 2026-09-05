import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDaemonCall = vi.fn().mockResolvedValue({});
vi.mock('../daemonClient.js', () => ({ daemonCall: (...a) => mockDaemonCall(...a) }));
vi.mock('../../stores/settingsStore.js', () => ({
  useSettingsStore: { getState: () => ({ billingProfile: null }) },
  hasPremiumAccess: () => true,
}));

const { syncNow, waitForSync, toSyncAccount, watchAccount, unwatchAccount, waitForSyncChanges } = await import('../syncService.js');

describe('syncService', () => {
  beforeEach(() => {
    mockDaemonCall.mockReset();
    mockDaemonCall.mockResolvedValue({});
  });

  it('hands back the ticket sync.now issued', async () => {
    mockDaemonCall.mockResolvedValue({ started: true, accountId: 'acc-1', mailbox: 'INBOX', ticket: 7 });

    const result = await syncNow({ id: 'acc-1' }, 'INBOX');

    expect(mockDaemonCall).toHaveBeenCalledWith('sync.now', {
      account: { id: 'acc-1' }, mailbox: 'INBOX', autoClassify: true,
    });
    expect(result.ticket).toBe(7);
  });

  it('waits on the ticket, not on the account', async () => {
    await waitForSync(7, 5000);

    expect(mockDaemonCall).toHaveBeenCalledWith('sync.wait', { ticket: 7, timeoutMs: 5000 });
  });

  // A caller that forgot the ticket used to wait on an accountId and get the
  // previous sync's result. Failing loudly beats answering with stale data.
  it('refuses to wait without a ticket', async () => {
    await expect(waitForSync(undefined)).rejects.toThrow(/ticket/);
    expect(mockDaemonCall).not.toHaveBeenCalled();
  });
});

// The daemon's SyncAccount/ImapConfig deserialize is by field name — a rename
// here and the account silently stops being watchable. The twelve names are
// pinned so `toSyncAccount` and the daemon struct can never drift apart, and
// so the UI-only keys a store account carries never reach the socket.
describe('toSyncAccount', () => {
  const IMAP_FIELDS = [
    'email', 'password', 'imapHost', 'imapPort', 'imapSecure', 'authType',
    'oauth2AccessToken', 'smtpHost', 'smtpPort', 'smtpSecure', 'name',
    'oauth2Transport',
  ];

  const storeAccount = {
    id: 'acc-1', email: 'a@b.co', password: 'pw',
    imapHost: 'imap.b.co', imapPort: 993, imapSecure: true, authType: 'password',
    oauth2AccessToken: 'tok', smtpHost: 'smtp.b.co', smtpPort: 465, smtpSecure: true,
    name: 'A B', oauth2Transport: null,
    // UI-only keys the store carries around
    color: '#fff', unreadCount: 3, previousImapHost: 'old.b.co', _dirty: true,
  };

  it('maps the twelve IMAP fields and drops everything else', () => {
    const sync = toSyncAccount(storeAccount);

    expect(sync.id).toBe('acc-1');
    expect(sync.email).toBe('a@b.co');
    expect(Object.keys(sync).sort()).toEqual(['email', 'id', 'imapConfig']);
    expect(Object.keys(sync.imapConfig).sort()).toEqual([...IMAP_FIELDS].sort());
    expect(sync.imapConfig).toEqual({
      email: 'a@b.co', password: 'pw',
      imapHost: 'imap.b.co', imapPort: 993, imapSecure: true, authType: 'password',
      oauth2AccessToken: 'tok', smtpHost: 'smtp.b.co', smtpPort: 465, smtpSecure: true,
      name: 'A B', oauth2Transport: null,
    });
  });

  // activateAccount knows the account id before the store row does.
  it('takes an explicit id over the account\'s own', () => {
    expect(toSyncAccount(storeAccount, 'other-id').id).toBe('other-id');
  });
});

describe('the IDLE watcher RPCs', () => {
  beforeEach(() => {
    mockDaemonCall.mockReset();
    mockDaemonCall.mockResolvedValue({});
  });

  it('watches an account by its sync shape', async () => {
    mockDaemonCall.mockResolvedValue({ watching: true });

    const r = await watchAccount({ id: 'acc-1', email: 'a@b.co', password: 'pw', color: '#fff' });

    expect(mockDaemonCall).toHaveBeenCalledWith('sync.watch', {
      account: toSyncAccount({ id: 'acc-1', email: 'a@b.co', password: 'pw' }),
    });
    expect(r).toEqual({ watching: true });
  });

  // The daemon is optional: no daemon means no IDLE, not a broken app and not
  // a warning per account per refresh.
  it('swallows a daemon that is not there, quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = Object.assign(new Error('not running'), { code: 'DAEMON_OFFLINE' });
    mockDaemonCall.mockRejectedValue(err);

    await expect(watchAccount({ id: 'acc-1', email: 'a@b.co' })).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('unwatches by account id and never throws', async () => {
    mockDaemonCall.mockRejectedValue(new Error('boom'));
    await expect(unwatchAccount('acc-1')).resolves.toBeNull();
    expect(mockDaemonCall).toHaveBeenCalledWith('sync.unwatch', { accountId: 'acc-1' });
  });

  it('long-polls the change feed from a cursor', async () => {
    mockDaemonCall.mockResolvedValue({ gen: 9, changes: [] });

    const r = await waitForSyncChanges(7, 1000);

    expect(mockDaemonCall).toHaveBeenCalledWith('sync.events', { since: 7, timeoutMs: 1000 });
    expect(r).toEqual({ gen: 9, changes: [] });
  });

  it('defaults the long poll to 25s', async () => {
    await waitForSyncChanges(0);
    expect(mockDaemonCall).toHaveBeenCalledWith('sync.events', { since: 0, timeoutMs: 25000 });
  });
});
