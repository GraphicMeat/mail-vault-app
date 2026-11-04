/**
 * The app's side of Move folder: the daemon job's routes
 * (src-daemon/src/handlers/folder_move.rs), its codes as catalog words, the
 * event it listens to, and the reload once a move ends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send, listen, invalidateFolderStatus, store } = vi.hoisted(() => ({
  send: vi.fn(),
  listen: vi.fn(),
  invalidateFolderStatus: vi.fn(),
  store: { state: {} },
}));
vi.mock('../transport.js', () => ({ send: (...a) => send(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a) => listen(...a) }));
vi.mock('../workflows/folderStatus', () => ({ invalidateFolderStatus: (...a) => invalidateFolderStatus(...a) }));
vi.mock('../../stores/mailStore', () => ({ useMailStore: { getState: () => store.state } }));

const move = await import('../folderMove.js');
const { takeForcedMailboxRefetch } = await import('../workflows/helpers/mailboxRefetch');
const en = (await import('../../i18n/locales/en.json')).default;

// Every code src-daemon/src/folder_move_job.rs and src-core/src/folder_move.rs answer with.
const CODES = ['RESERVED', 'INTO_ITSELF', 'RUNNING', 'NOT_FOUND', 'SOURCE_MISSING', 'SIGN_IN', 'GRAPH_SUBFOLDERS', 'NO_HIERARCHY', 'NAME'];

beforeEach(() => {
  send.mockReset();
  listen.mockReset();
  invalidateFolderStatus.mockReset();
  store.state = {};
  for (const id of ['src', 'dst', 'other']) takeForcedMailboxRefetch(id);
});

describe('the daemon codes, as catalog words', () => {
  it.each(CODES)('E_FOLDER_MOVE_%s, bare or with the daemon\'s detail after it, is an English catalog entry', (code) => {
    const key = `errors.E_FOLDER_MOVE_${code}`;
    expect(en[key]).toBeTruthy();
    // A plan refusal and a failed job's `error` are bare; a refused start or
    // control carries a job id or the keychain's words after a colon.
    expect(move.errorKey(`E_FOLDER_MOVE_${code}`)).toBe(key);
    expect(move.errorKey(new Error(`E_FOLDER_MOVE_${code}: 7d1f-22`))).toBe(key);
  });

  it('passes the daemon\'s own catalog key through', () => {
    // `admit` answers a busy keychain with the key itself.
    expect(move.errorKey(new Error('errors.keychainBusy'))).toBe('errors.keychainBusy');
  });

  it('never shows the daemon\'s raw text: anything else is the fallback', () => {
    // A failed live listing ends the job with the server's own words.
    expect(move.errorKey('IMAP LIST failed: connection reset')).toBe('folderMove.failed');
    expect(move.errorKey(new Error('E_FOLDER_MOVE_RUNNINGX'))).toBe('folderMove.failed');
    expect(move.errorKey(new Error('see E_FOLDER_MOVE_RUNNING: x'))).toBe('folderMove.failed');
    expect(move.errorKey(undefined)).toBe('folderMove.failed');
    expect(move.errorKey(new Error('boom'), 'folderMove.foldersFailed')).toBe('folderMove.foldersFailed');
  });

  it('knows a job the daemon no longer has', () => {
    expect(move.isNotFound(new Error('E_FOLDER_MOVE_NOT_FOUND: 7d1f'))).toBe(true);
    expect(move.isNotFound(new Error('E_FOLDER_MOVE_RUNNING: 7d1f'))).toBe(false);
  });
});

describe('the routes', () => {
  it('plans and starts with the dialog\'s params, and steers by job id', async () => {
    send.mockResolvedValue({});
    const params = { sourceAccountId: 'src', sourcePath: 'Clients', destAccountId: 'dst', destPath: 'Archive' };
    await move.plan(params);
    await move.start(params);
    for (const verb of ['pause', 'resume', 'cancel', 'discard']) await move[verb]('j1');
    expect(send.mock.calls).toEqual([
      ['folder_move.plan', params],
      ['folder_move.start', params],
      ['folder_move.pause', { jobId: 'j1' }],
      ['folder_move.resume', { jobId: 'j1' }],
      ['folder_move.cancel', { jobId: 'j1' }],
      ['folder_move.discard', { jobId: 'j1' }],
    ]);
  });

  it('lists the jobs the daemon knows, and rejects when it cannot say', async () => {
    send.mockResolvedValueOnce({ jobs: [{ jobId: 'j1' }] });
    await expect(move.status()).resolves.toEqual([{ jobId: 'j1' }]);
    expect(send).toHaveBeenCalledWith('folder_move.status', {});
    send.mockRejectedValueOnce(new Error('errors.daemonOutdated'));
    await expect(move.status()).rejects.toThrow();
  });
});

describe('events', () => {
  it('listens to the move\'s progress and to a restarted daemon, nothing else', async () => {
    listen.mockResolvedValue(() => {});
    await Promise.all([move.onProgress(() => {}), move.onDaemonReconnected(() => {})]);
    expect(listen.mock.calls.map(([event]) => event).sort()).toEqual(['daemon-reconnected', 'folder-move-progress']);
  });

  it('hands on the payload', async () => {
    let handler = null;
    listen.mockImplementation(async (event, cb) => { handler = cb; return () => {}; });
    const seen = vi.fn();
    await move.onProgress(seen);
    handler({ payload: { jobId: 'j1', state: 'running' } });
    expect(seen).toHaveBeenCalledWith({ jobId: 'j1', state: 'running' });
  });
});

// The daemon synced the destination and marked both folder lists out of date;
// the app lists them again the way Refresh does.
describe('the reload once a move ends', () => {
  const end = (o = {}) => ({
    jobId: 'j1', sourceAccountId: 'src', destAccountId: 'dst', sourcePath: 'Clients', destPath: 'Archive',
    active: false, state: 'done', copied: 3, skipped: 0, failed: 0, foldersCreated: 2, retired: true, retiredTo: 'Trash/Clients', ...o,
  });
  const screen = (o) => {
    const s = { activeAccountId: 'other', activeMailbox: 'INBOX', unifiedInbox: false, mailboxes: [{ path: 'INBOX', delimiter: '/' }],
      refreshCurrentView: vi.fn(async () => {}), activateAccount: vi.fn(async () => {}), ...o };
    store.state = s;
    return s;
  };

  it('lists both accounts\' folders again and counts them again', async () => {
    const s = screen({ activeAccountId: 'dst' });
    await move.refreshAfter(end());
    expect(takeForcedMailboxRefetch('src')).toBe(true);
    expect(takeForcedMailboxRefetch('dst')).toBe(true);
    expect(invalidateFolderStatus.mock.calls.map(([id]) => id).sort()).toEqual(['dst', 'src']);
    expect(s.refreshCurrentView).toHaveBeenCalledTimes(1);
  });

  it('opens INBOX when the moved folder, or one inside it, was the open one', async () => {
    for (const open of ['Clients', 'Clients/2025']) {
      const s = screen({ activeAccountId: 'src', activeMailbox: open });
      await move.refreshAfter(end());
      expect(s.activateAccount).toHaveBeenCalledWith('src', 'INBOX');
      expect(s.refreshCurrentView).not.toHaveBeenCalled();
    }
  });

  it('a same-account rename is a move too: its old path is gone though nothing was retired', async () => {
    const s = screen({ activeAccountId: 'src', activeMailbox: 'Clients' });
    await move.refreshAfter(end({ destAccountId: 'src', destPath: null, copied: 0, foldersCreated: 0, retired: false, retiredTo: null }));
    expect(s.activateAccount).toHaveBeenCalledWith('src', 'INBOX');
    expect(takeForcedMailboxRefetch('src')).toBe(true);
  });

  it('a folder whose name only starts the same is not inside the moved one', async () => {
    const s = screen({ activeAccountId: 'src', activeMailbox: 'Clients 2' });
    await move.refreshAfter(end());
    expect(s.activateAccount).not.toHaveBeenCalled();
    expect(s.refreshCurrentView).toHaveBeenCalledTimes(1);
  });

  it('a kept original stays open where it is, and the view reloads', async () => {
    const s = screen({ activeAccountId: 'src', activeMailbox: 'Clients' });
    await move.refreshAfter(end({ state: 'partial', retired: false, retiredTo: null, sourceKeptReason: 'failed' }));
    expect(s.activateAccount).not.toHaveBeenCalled();
    expect(s.refreshCurrentView).toHaveBeenCalledTimes(1);
  });

  it('for accounts not on screen, only makes their next open list the folders again', async () => {
    const s = screen({ activeAccountId: 'other' });
    await move.refreshAfter(end());
    expect(s.refreshCurrentView).not.toHaveBeenCalled();
    expect(takeForcedMailboxRefetch('src')).toBe(true);
  });

  it('reloads nothing while the move runs, or for an end that changed nothing', async () => {
    const s = screen({ activeAccountId: 'src' });
    await move.refreshAfter(end({ active: true, state: 'running' }));
    await move.refreshAfter(end({ state: 'cancelled', copied: 0, foldersCreated: 0, retired: false }));
    await move.refreshAfter({ jobId: 'j1', state: 'discarded', active: false });
    expect(s.refreshCurrentView).not.toHaveBeenCalled();
    expect(invalidateFolderStatus).not.toHaveBeenCalled();
    expect(takeForcedMailboxRefetch('src')).toBe(false);
  });
});
