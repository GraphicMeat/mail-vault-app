/**
 * The app's side of "Import and restore to the server" (MBOX import mode 1):
 * the daemon job's routes, its codes as catalog words, the file re-pick a
 * sandboxed resume needs, the event filter, and the reload once it is done.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send, open, listen, invalidateFolderStatus, resolveServerAccount, store } = vi.hoisted(() => ({
  send: vi.fn(),
  open: vi.fn(),
  listen: vi.fn(),
  invalidateFolderStatus: vi.fn(),
  resolveServerAccount: vi.fn(),
  store: { state: {} },
}));
vi.mock('../transport.js', () => ({ send: (...a) => send(...a) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...a) => open(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a) => listen(...a) }));
vi.mock('../workflows/folderStatus', () => ({ invalidateFolderStatus: (...a) => invalidateFolderStatus(...a) }));
vi.mock('../authUtils', () => ({ resolveServerAccount: (...a) => resolveServerAccount(...a) }));
vi.mock('../../stores/mailStore', () => ({ useMailStore: { getState: () => store.state } }));

const upload = await import('../mboxUpload.js');
const { takeForcedMailboxRefetch } = await import('../workflows/helpers/mailboxRefetch');
const en = (await import('../../i18n/locales/en.json')).default;

const UNREADABLE = 'Failed to read mbox file: Operation not permitted (os error 1)';

beforeEach(() => {
  send.mockReset();
  open.mockReset();
  listen.mockReset();
  invalidateFolderStatus.mockReset();
  resolveServerAccount.mockReset().mockImplementation(async (id, account) => ({ ok: !!account, account }));
  store.state = {};
  for (const id of ['acct-a', 'acct-b']) takeForcedMailboxRefetch(id);
});

describe('the daemon codes, as catalog words', () => {
  it.each([
    ['E_MBOX_UPLOAD_RUNNING: 0b8c', 'errors.E_MBOX_UPLOAD_RUNNING'],
    ['E_MBOX_UPLOAD_RESUMABLE: 0b8c', 'errors.E_MBOX_UPLOAD_RESUMABLE'],
    ['E_MBOX_UPLOAD_NOT_FOUND: 0b8c', 'errors.E_MBOX_UPLOAD_NOT_FOUND'],
    ['E_MBOX_UPLOAD_SIGN_IN: keychain: no password stored', 'errors.E_MBOX_UPLOAD_SIGN_IN'],
    ['E_MBOX_UPLOAD_READ: No such file or directory (os error 2)', 'errors.E_MBOX_UPLOAD_READ'],
    ['E_MBOX_SERVER_GRAPH: an Outlook account takes no upload over IMAP', 'errors.E_MBOX_SERVER_GRAPH'],
    // The app's own refusal of a re-picked file that is not the job's.
    ['E_MBOX_UPLOAD_OTHER_FILE:', 'mboxUpload.otherFile'],
  ])('%s is %s, an English catalog entry', (message, key) => {
    expect(upload.errorKey(new Error(message))).toBe(key);
    // A bare string (the payload's `error`) reads the same way.
    expect(upload.errorKey(message)).toBe(key);
    expect(en[key]).toBeTruthy();
  });

  it('matches the code only at the start, and anything else is the fallback key', () => {
    // A path or detail that merely mentions a code is not that code.
    expect(upload.errorKey(new Error('Failed to read mbox file: /x/E_MBOX_UPLOAD_READ: y'))).toBe('settings.backup.restore.mboxImportFailed');
    expect(upload.errorKey(new Error('custody store unavailable: closed'))).toBe('settings.backup.restore.mboxImportFailed');
    expect(upload.errorKey(new Error('custody store unavailable: closed'), 'mboxUpload.actionFailed')).toBe('mboxUpload.actionFailed');
    expect(upload.errorKey(undefined)).toBe('settings.backup.restore.mboxImportFailed');
  });

  it('reads the job id of an upload that can be resumed, and nothing from another error', () => {
    expect(upload.resumableJobId(new Error('E_MBOX_UPLOAD_RESUMABLE: 7d1f-22'))).toBe('7d1f-22');
    expect(upload.resumableJobId(new Error('E_MBOX_UPLOAD_RUNNING: 7d1f-22'))).toBe(null);
    expect(upload.resumableJobId(new Error('boom'))).toBe(null);
  });

  it('knows a job the daemon no longer has', () => {
    expect(upload.isNotFound(new Error('E_MBOX_UPLOAD_NOT_FOUND: 7d1f'))).toBe(true);
    expect(upload.isNotFound(new Error('E_MBOX_UPLOAD_RUNNING: 7d1f'))).toBe(false);
  });
});

describe('the routes', () => {
  it('sends each control to its own route with the job id', async () => {
    send.mockResolvedValue({});
    await upload.pause('j1');
    await upload.cancel('j1');
    await upload.discard('j1');
    expect(send.mock.calls).toEqual([
      ['mbox_upload_pause', { jobId: 'j1' }],
      ['mbox_upload_cancel', { jobId: 'j1' }],
      ['mbox_upload_discard', { jobId: 'j1' }],
    ]);
  });

  it('lists the jobs the daemon knows, and none when it cannot answer', async () => {
    send.mockResolvedValueOnce({ jobs: [{ jobId: 'j1' }] });
    await expect(upload.status()).resolves.toEqual([{ jobId: 'j1' }]);
    expect(send).toHaveBeenCalledWith('mbox_upload_status', {});
    send.mockRejectedValueOnce(new Error('errors.daemonOutdated'));
    await expect(upload.status()).rejects.toThrow();
  });
});

// After a restart a sandboxed build may not let the daemon open the file the
// journal names: the resume route opens it before anything starts, and says
// "Failed to read mbox file". The user picks the file again and the daemon
// gets its path. The panel names the file it wants, and a file by another
// name is refused here: the daemon would take it as the job's file changed,
// start over from byte 0 and upload it, which cannot be undone.
describe('resume', () => {
  const TITLE = en['mboxUpload.pickAgainTitle'].replace('{{file}}', 'Takeout.mbox');

  it('asks the daemon once, with no path, when it can read the file', async () => {
    send.mockResolvedValue({ jobId: 'j1', resumed: true, restarted: false });
    await expect(upload.resume({ jobId: 'j1', fileName: 'Takeout.mbox' })).resolves.toMatchObject({ resumed: true });
    expect(send.mock.calls).toEqual([['mbox_upload_resume', { jobId: 'j1' }]]);
    expect(open).not.toHaveBeenCalled();
  });

  it('asks for the file again, by name, when the daemon cannot read it, and resumes with that path', async () => {
    send.mockRejectedValueOnce(new Error(UNREADABLE)).mockResolvedValueOnce({ jobId: 'j1', resumed: true });
    open.mockResolvedValue('/Users/me/Downloads/Takeout.mbox');
    await expect(upload.resume({ jobId: 'j1', fileName: 'Takeout.mbox' })).resolves.toMatchObject({ resumed: true });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toMatchObject({ title: TITLE, multiple: false, filters: [{ extensions: ['mbox'] }] });
    expect(send.mock.calls).toEqual([
      ['mbox_upload_resume', { jobId: 'j1' }],
      ['mbox_upload_resume', { jobId: 'j1', sourcePath: '/Users/me/Downloads/Takeout.mbox' }],
    ]);
  });

  it('takes the same name from another folder, Windows paths included', async () => {
    send.mockRejectedValueOnce(new Error(UNREADABLE)).mockResolvedValueOnce({ jobId: 'j1', resumed: true });
    open.mockResolvedValue('C:\\Users\\me\\Moved\\Takeout.mbox');
    await upload.resume({ jobId: 'j1', fileName: 'Takeout.mbox' });
    expect(send.mock.calls[1]).toEqual(['mbox_upload_resume', { jobId: 'j1', sourcePath: 'C:\\Users\\me\\Moved\\Takeout.mbox' }]);
  });

  it('refuses a file by another name and sends nothing that would upload it', async () => {
    send.mockRejectedValueOnce(new Error(UNREADABLE));
    open.mockResolvedValue('/Users/me/Downloads/Takeout-002.mbox');
    const refusal = await upload.resume({ jobId: 'j1', fileName: 'Takeout-001.mbox' }).catch((e) => e);
    expect(refusal).toBeInstanceOf(Error);
    expect(upload.errorKey(refusal)).toBe('mboxUpload.otherFile');
    expect(send.mock.calls).toEqual([['mbox_upload_resume', { jobId: 'j1' }]]);
  });

  it('does nothing more when that pick is cancelled', async () => {
    send.mockRejectedValueOnce(new Error(UNREADABLE));
    open.mockResolvedValue(null);
    await expect(upload.resume({ jobId: 'j1', fileName: 'Takeout.mbox' })).resolves.toBe(null);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never asks for the file over any other refusal, or when it was given a path', async () => {
    send.mockRejectedValueOnce(new Error('E_MBOX_UPLOAD_SIGN_IN: keychain'));
    await expect(upload.resume({ jobId: 'j1', fileName: 'Takeout.mbox' })).rejects.toThrow(/^E_MBOX_UPLOAD_SIGN_IN:/);
    send.mockRejectedValueOnce(new Error(UNREADABLE));
    await expect(upload.resume({ jobId: 'j1', sourcePath: '/picked/a.mbox' })).rejects.toThrow(/^Failed to read mbox file/);
    expect(send.mock.calls[1]).toEqual(['mbox_upload_resume', { jobId: 'j1', sourcePath: '/picked/a.mbox' }]);
    expect(open).not.toHaveBeenCalled();
  });
});

// The daemon never refreshes an OAuth token: a job held for a refused sign-in
// re-reads the stored credentials and holds again on the same expired token.
// So the app resolves the account first, as the backup and the vault-gap save
// do (keychain rehydration when the store's copy has no credentials, then the
// token refresh, written where the daemon reads it).
describe('the account\'s sign-in, before a start or a resume', () => {
  const GMAIL = { id: 'acct-a', email: 'me@gmail.test', authType: 'oauth2', oauth2RefreshToken: 'r', oauth2ExpiresAt: 1 };
  const order = [];
  beforeEach(() => {
    order.length = 0;
    store.state = { accounts: [GMAIL, { id: 'acct-b', email: 'me@plain.test' }] };
    resolveServerAccount.mockImplementation(async (id, a) => { order.push(`resolve ${id}`); return { ok: true, account: a }; });
    send.mockImplementation(async (cmd) => { order.push(cmd); return {}; });
  });

  it('refreshes the token of the job\'s account before the resume goes to the daemon', async () => {
    await upload.resume({ jobId: 'j1', accountId: 'acct-a' });
    expect(resolveServerAccount).toHaveBeenCalledWith('acct-a', GMAIL);
    expect(order).toEqual(['resolve acct-a', 'mbox_upload_resume']);
  });

  it('refreshes it before a start too, with the store\'s account', async () => {
    await upload.start({ sourcePath: '/x.mbox', accountId: 'acct-a', mode: 'server', mailbox: 'INBOX', useLabels: false });
    expect(resolveServerAccount).toHaveBeenCalledWith('acct-a', GMAIL);
    expect(order).toEqual(['resolve acct-a', 'import_mbox']);
    expect(send).toHaveBeenCalledWith('import_mbox', { sourcePath: '/x.mbox', accountId: 'acct-a', mode: 'server', mailbox: 'INBOX', useLabels: false });
  });

  it('a resolve that fails, or throws, still sends the resume: the daemon says what is wrong', async () => {
    resolveServerAccount.mockImplementationOnce(async () => { order.push('resolve refused'); return { ok: false, reason: 'refresh_failed' }; });
    await upload.resume({ jobId: 'j1', accountId: 'acct-a' });
    resolveServerAccount.mockImplementationOnce(async () => { order.push('resolve threw'); throw new Error('invalid_grant'); });
    await upload.resume({ jobId: 'j1', accountId: 'acct-a' });
    expect(order).toEqual(['resolve refused', 'mbox_upload_resume', 'resolve threw', 'mbox_upload_resume']);
  });

  it('an account the store does not know is still resolved, from the keychain', async () => {
    await upload.resume({ jobId: 'j1', accountId: 'gone' });
    expect(resolveServerAccount).toHaveBeenCalledWith('gone', undefined);
    expect(order).toEqual(['resolve gone', 'mbox_upload_resume']);
  });
});

describe('events', () => {
  it('passes on only the upload job\'s progress, not the other import modes\'', async () => {
    let handler = null;
    listen.mockImplementation(async (event, cb) => { if (event === 'mbox-import-progress') handler = cb; return () => {}; });
    const seen = vi.fn();
    await upload.onProgress(seen);
    handler({ payload: { total: 0, completed: 5, active: true, bytesDone: 10, bytesTotal: 20 } });
    handler({ payload: { mode: 'server', jobId: 'j1', active: true, state: 'running' } });
    handler({ payload: null });
    expect(seen.mock.calls).toEqual([[{ mode: 'server', jobId: 'j1', active: true, state: 'running' }]]);
  });

  // Both listeners are asked for in the same tick when the chip mounts. Under
  // vitest two overlapping dynamic imports of one mocked module can load the
  // real module for the second (the real `listen` then throws without Tauri,
  // silently): the event API is loaded once and shared.
  it('registers every listener asked for in the same tick', async () => {
    listen.mockResolvedValue(() => {});
    await Promise.all([upload.onProgress(() => {}), upload.onDaemonReconnected(() => {})]);
    expect(listen.mock.calls.map(([event]) => event).sort()).toEqual(['daemon-reconnected', 'mbox-import-progress']);
  });

  it('listens for a restarted daemon', async () => {
    listen.mockResolvedValue(() => {});
    await upload.onDaemonReconnected(() => {});
    expect(listen.mock.calls[0][0]).toBe('daemon-reconnected');
  });
});

// The daemon syncs what it uploaded and marks the cached folder list out of
// date; the app reloads the list on screen the way Refresh does. Any last
// event (active: false) that uploaded something or made a folder: a done
// run, a cancel, a read error, a discard.
describe('the reload once an upload ends', () => {
  const done = (o = {}) => ({ mode: 'server', jobId: 'j1', accountId: 'acct-a', active: false, state: 'done', uploadedCount: 3, foldersChanged: false, ...o });

  it('refreshes the account on screen, its folder list and its counts', async () => {
    const refreshCurrentView = vi.fn(async () => {});
    store.state = { activeAccountId: 'acct-a', unifiedInbox: false, refreshCurrentView };
    await upload.refreshAfter(done({ foldersChanged: true }));
    expect(refreshCurrentView).toHaveBeenCalledTimes(1);
    expect(invalidateFolderStatus).toHaveBeenCalledWith('acct-a');
    expect(takeForcedMailboxRefetch('acct-a')).toBe(true);
  });

  it('for an account not on screen, only makes its next open list its folders again', async () => {
    const refreshCurrentView = vi.fn(async () => {});
    store.state = { activeAccountId: 'acct-b', unifiedInbox: false, refreshCurrentView };
    await upload.refreshAfter(done({ foldersChanged: true }));
    expect(refreshCurrentView).not.toHaveBeenCalled();
    expect(takeForcedMailboxRefetch('acct-a')).toBe(true);
    expect(takeForcedMailboxRefetch('acct-b')).toBe(false);
  });

  it('refreshes the unified view too, which shows every account', async () => {
    const refreshCurrentView = vi.fn(async () => {});
    store.state = { activeAccountId: 'acct-b', unifiedInbox: true, refreshCurrentView };
    await upload.refreshAfter(done());
    expect(refreshCurrentView).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a cancel', { state: 'cancelled' }],
    ['a read error', { state: 'paused', paused: true, error: 'E_MBOX_UPLOAD_READ: gone' }],
    ['a discard of a live run', { state: 'discarded' }],
    ['a cancel that only made a folder', { state: 'cancelled', uploadedCount: 0, foldersChanged: true }],
  ])('%s that changed the server reloads too', async (_, over) => {
    const refreshCurrentView = vi.fn(async () => {});
    store.state = { activeAccountId: 'acct-a', unifiedInbox: false, refreshCurrentView };
    await upload.refreshAfter(done(over));
    expect(refreshCurrentView).toHaveBeenCalledTimes(1);
    expect(takeForcedMailboxRefetch('acct-a')).toBe(true);
  });

  it('reloads nothing for a run that uploaded nothing and made no folder, or one still running', async () => {
    const refreshCurrentView = vi.fn(async () => {});
    store.state = { activeAccountId: 'acct-a', unifiedInbox: false, refreshCurrentView };
    await upload.refreshAfter(done({ uploadedCount: 0, skippedCount: 4 }));
    await upload.refreshAfter(done({ state: 'cancelled', uploadedCount: 0 }));
    // A journal discarded with no worker: the daemon's event names the job alone.
    await upload.refreshAfter({ mode: 'server', jobId: 'j1', state: 'discarded', active: false });
    await upload.refreshAfter(done({ active: true, state: 'running' }));
    await upload.refreshAfter(done({ active: true, state: 'paused', paused: true }));
    expect(refreshCurrentView).not.toHaveBeenCalled();
    expect(invalidateFolderStatus).not.toHaveBeenCalled();
    expect(takeForcedMailboxRefetch('acct-a')).toBe(false);
  });

  it('a run that made a folder but uploaded nothing new still lists the folders again', async () => {
    const refreshCurrentView = vi.fn(async () => {});
    store.state = { activeAccountId: 'acct-a', unifiedInbox: false, refreshCurrentView };
    await upload.refreshAfter(done({ uploadedCount: 0, foldersChanged: true }));
    expect(refreshCurrentView).toHaveBeenCalledTimes(1);
  });
});
