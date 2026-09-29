/**
 * The app's side of "Import and restore to the server" (MBOX import mode 1):
 * the daemon job's routes, its codes as catalog words, the file re-pick a
 * sandboxed resume needs, the event filter, and the reload once it is done.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send, open, listen, invalidateFolderStatus, ensureFreshToken, store } = vi.hoisted(() => ({
  send: vi.fn(),
  open: vi.fn(),
  listen: vi.fn(),
  invalidateFolderStatus: vi.fn(),
  ensureFreshToken: vi.fn(),
  store: { state: {} },
}));
vi.mock('../transport.js', () => ({ send: (...a) => send(...a) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...a) => open(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a) => listen(...a) }));
vi.mock('../workflows/folderStatus', () => ({ invalidateFolderStatus: (...a) => invalidateFolderStatus(...a) }));
vi.mock('../authUtils', () => ({ ensureFreshToken: (...a) => ensureFreshToken(...a) }));
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
  ensureFreshToken.mockReset();
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
// gets its path.
describe('resume', () => {
  it('asks the daemon once, with no path, when it can read the file', async () => {
    send.mockResolvedValue({ jobId: 'j1', resumed: true, restarted: false });
    await expect(upload.resume({ jobId: 'j1' })).resolves.toMatchObject({ resumed: true });
    expect(send.mock.calls).toEqual([['mbox_upload_resume', { jobId: 'j1' }]]);
    expect(open).not.toHaveBeenCalled();
  });

  it('asks for the file again when the daemon cannot read it, and resumes with that path', async () => {
    send.mockRejectedValueOnce(new Error(UNREADABLE)).mockResolvedValueOnce({ jobId: 'j1', resumed: true });
    open.mockResolvedValue('/Users/me/Downloads/Takeout.mbox');
    await expect(upload.resume({ jobId: 'j1' })).resolves.toMatchObject({ resumed: true });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toMatchObject({ multiple: false, filters: [{ extensions: ['mbox'] }] });
    expect(send.mock.calls).toEqual([
      ['mbox_upload_resume', { jobId: 'j1' }],
      ['mbox_upload_resume', { jobId: 'j1', sourcePath: '/Users/me/Downloads/Takeout.mbox' }],
    ]);
  });

  it('does nothing more when that pick is cancelled', async () => {
    send.mockRejectedValueOnce(new Error(UNREADABLE));
    open.mockResolvedValue(null);
    await expect(upload.resume({ jobId: 'j1' })).resolves.toBe(null);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never asks for the file over any other refusal, or when it was given a path', async () => {
    send.mockRejectedValueOnce(new Error('E_MBOX_UPLOAD_SIGN_IN: keychain'));
    await expect(upload.resume({ jobId: 'j1' })).rejects.toThrow(/^E_MBOX_UPLOAD_SIGN_IN:/);
    send.mockRejectedValueOnce(new Error(UNREADABLE));
    await expect(upload.resume({ jobId: 'j1', sourcePath: '/picked/a.mbox' })).rejects.toThrow(/^Failed to read mbox file/);
    expect(send.mock.calls[1]).toEqual(['mbox_upload_resume', { jobId: 'j1', sourcePath: '/picked/a.mbox' }]);
    expect(open).not.toHaveBeenCalled();
  });
});

// The daemon never refreshes an OAuth token: a job held for a refused sign-in
// re-reads the stored credentials and holds again on the same expired token.
// So the app refreshes the account's token, where the daemon reads it, first.
describe('the account\'s sign-in, before a start or a resume', () => {
  const GMAIL = { id: 'acct-a', email: 'me@gmail.test', authType: 'oauth2', oauth2RefreshToken: 'r', oauth2ExpiresAt: 1 };
  const order = [];
  beforeEach(() => {
    order.length = 0;
    store.state = { accounts: [GMAIL, { id: 'acct-b', email: 'me@plain.test' }] };
    ensureFreshToken.mockImplementation(async (a) => { order.push(`refresh ${a.id}`); return a; });
    send.mockImplementation(async (cmd) => { order.push(cmd); return {}; });
  });

  it('refreshes the token of the job\'s account before the resume goes to the daemon', async () => {
    await upload.resume({ jobId: 'j1', accountId: 'acct-a' });
    expect(ensureFreshToken).toHaveBeenCalledWith(GMAIL);
    expect(order).toEqual(['refresh acct-a', 'mbox_upload_resume']);
  });

  it('refreshes it before a start too, with the store\'s account', async () => {
    await upload.start({ sourcePath: '/x.mbox', accountId: 'acct-a', mode: 'server', mailbox: 'INBOX', useLabels: false });
    expect(order).toEqual(['refresh acct-a', 'import_mbox']);
    expect(send).toHaveBeenCalledWith('import_mbox', { sourcePath: '/x.mbox', accountId: 'acct-a', mode: 'server', mailbox: 'INBOX', useLabels: false });
  });

  it('a refresh that fails still sends the resume: the daemon says what is wrong', async () => {
    ensureFreshToken.mockImplementation(async () => { order.push('refresh failed'); throw new Error('invalid_grant'); });
    await upload.resume({ jobId: 'j1', accountId: 'acct-a' });
    expect(order).toEqual(['refresh failed', 'mbox_upload_resume']);
  });

  it('an account the store does not know goes straight to the daemon', async () => {
    await upload.resume({ jobId: 'j1', accountId: 'gone' });
    expect(ensureFreshToken).not.toHaveBeenCalled();
    expect(order).toEqual(['mbox_upload_resume']);
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

  it('listens for a restarted daemon', async () => {
    listen.mockResolvedValue(() => {});
    await upload.onDaemonReconnected(() => {});
    expect(listen.mock.calls[0][0]).toBe('daemon-reconnected');
  });
});

// The daemon syncs what it uploaded and marks the cached folder list out of
// date; the app reloads the list on screen the way Refresh does.
describe('the reload once an upload is done', () => {
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

  it('reloads nothing for a run that uploaded nothing and made no folder, or one that did not finish', async () => {
    const refreshCurrentView = vi.fn(async () => {});
    store.state = { activeAccountId: 'acct-a', unifiedInbox: false, refreshCurrentView };
    await upload.refreshAfter(done({ uploadedCount: 0, skippedCount: 4 }));
    await upload.refreshAfter(done({ state: 'cancelled' }));
    await upload.refreshAfter(done({ state: 'paused', error: 'E_MBOX_UPLOAD_READ: gone' }));
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
