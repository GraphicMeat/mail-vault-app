// @vitest-environment jsdom
/**
 * The app's side of Archive & delete jobs (`services/abd.js` + `stores/abdStore.js`):
 * the launch/reconnect protocol, the drive re-attach, and the OAuth token
 * lease the daemon can not refresh for itself (part-d design 6.4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  order: [],
  listeners: new Map(),
  // Something callable from the first import on: the settings store also reaches the daemon client.
  daemon: vi.fn(async () => ({})),
  attach: vi.fn(async () => ({ attached: true })),
  start: vi.fn(async () => ({})),
  resolve: vi.fn(async () => ({ ok: false })),
  accounts: [],
  status: { jobs: [] },
}));

vi.mock('../../src/services/daemonClient', () => ({
  daemonCall: (...args) => h.daemon(...args),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, cb) => {
    h.order.push(`listen:${name}`);
    h.listeners.set(name, cb);
    return () => h.listeners.delete(name);
  },
}));
vi.mock('../../src/services/api', () => ({
  abdAttach: (...args) => h.attach(...args),
  abdStart: (...args) => h.start(...args),
  abdSummarize: vi.fn(),
}));
vi.mock('../../src/services/authUtils', () => ({ resolveServerAccount: (...args) => h.resolve(...args) }));
vi.mock('../../src/stores/accountStore', () => ({
  getAccounts: () => h.accounts,
  useAccountStore: (selector) => selector({ accounts: h.accounts }),
}));

const abd = await import('../../src/services/abd.js');
const { useAbdStore } = await import('../../src/stores/abdStore.js');
const { useSettingsStore } = await import('../../src/stores/settingsStore.js');
const { t } = await import('../../src/i18n/index.js');

const TOKEN = 'ya29.SECRET-ACCESS-TOKEN-1';
const OAUTH = { id: 'acc-oauth', email: 'o@outlook.test', authType: 'oauth2', oauth2Transport: 'graph' };
const PASSWORD = { id: 'acc-pass', email: 'p@mail.test', authType: 'password' };

const frame = (over = {}) => ({
  jobId: 'abd-acc-1', accountId: OAUTH.id, accountEmail: OAUTH.email, mode: 'archive_delete',
  timing: 'after_all', deleteMode: 'move_to_trash', provider: 'graph',
  status: { state: 'running', phase: 'download' },
  counts: { scoped: 10, stored: 0, vaultVerified: 0, onDrive: 0, deleted: 0, emptied: 0, kept: 0, keptByReason: {} },
  finished: false, outcome: null, error: null, updatedMs: 1000, ...over,
});

const calls = (method) => h.daemon.mock.calls.filter(([m]) => m === method).map(([, p]) => p);
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  h.order = [];
  h.listeners.clear();
  h.accounts = [OAUTH, PASSWORD];
  h.status = { jobs: [] };
  h.daemon = vi.fn(async (method) => {
    h.order.push(`call:${method}`);
    if (method === 'abd.status') return h.status;
    if (method === 'abd.pause' || method === 'abd.resume' || method === 'abd.cancel') return { status: { state: 'paused', reason: 'user' } };
    return {};
  });
  h.attach = vi.fn(async () => ({ attached: true }));
  h.start = vi.fn(async () => ({ jobId: 'abd-acc-1' }));
  h.resolve = vi.fn(async (id) => ({
    ok: true,
    account: { id, authType: 'oauth2', oauth2AccessToken: TOKEN, oauth2ExpiresAt: 4_000_000_000_000 },
  }));
  useSettingsStore.setState({ billingProfile: { hasSubscription: true, status: 'active', premiumAccess: true } });
  abd.__resetAbdForTests();
});
afterEach(() => {
  abd.__resetAbdForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('launch and reconnect', () => {
  it('wires every listener before it asks the daemon for the jobs', async () => {
    await abd.initAbd();
    const ask = h.order.indexOf('call:abd.status');
    expect(ask).toBeGreaterThan(-1);
    for (const name of ['abd-progress', 'abd-preview', 'abd-token-needed', 'daemon-reconnected', 'daemon-events-lagged']) {
      const at = h.order.indexOf(`listen:${name}`);
      expect(at, name).toBeGreaterThan(-1);
      expect(at, name).toBeLessThan(ask);
    }
  });

  it('asks again on daemon-reconnected and on daemon-events-lagged, not otherwise', async () => {
    await abd.initAbd();
    expect(calls('abd.status')).toHaveLength(1);
    h.listeners.get('daemon-reconnected')();
    await flush();
    expect(calls('abd.status')).toHaveLength(2);
    h.listeners.get('daemon-events-lagged')();
    await flush();
    expect(calls('abd.status')).toHaveLength(3);
  });

  it('runs once: a second initAbd adds no listener and no ask', async () => {
    await abd.initAbd();
    await abd.initAbd();
    expect(calls('abd.status')).toHaveLength(1);
  });

  it('shows an unfinished job as a minimized panel and a finished one as nothing to open', async () => {
    h.status = { jobs: [frame(), frame({ jobId: 'abd-p-1', accountId: PASSWORD.id, finished: true, outcome: 'completed', status: { state: 'completed' } })] };
    await abd.initAbd();
    const s = useAbdStore.getState();
    expect(Object.keys(s.jobs).sort()).toEqual([OAUTH.id, PASSWORD.id].sort());
    expect(s.panel).toEqual({ accountId: OAUTH.id, minimized: true });
  });

  it('re-attaches the backup drive for a backup-mode job only, and never for a finished one', async () => {
    h.status = {
      jobs: [
        frame({ jobId: 'a', accountId: 'acc-b1', mode: 'archive_backup_delete' }),
        frame({ jobId: 'b', accountId: 'acc-a1', mode: 'archive_delete' }),
        frame({ jobId: 'c', accountId: 'acc-b2', mode: 'archive_backup_delete', finished: true, outcome: 'completed', status: { state: 'completed' } }),
      ],
    };
    await abd.initAbd();
    await flush();
    expect(h.attach.mock.calls.map(([id]) => id)).toEqual(['acc-b1']);
  });

  it('survives a daemon that is not answering yet', async () => {
    h.daemon = vi.fn(async () => { throw new Error('not running'); });
    await expect(abd.initAbd()).resolves.toBeUndefined();
  });
});

describe('the OAuth token lease', () => {
  it('hands the daemon a token at launch and every 10 minutes while an OAuth job is unfinished', async () => {
    h.status = { jobs: [frame()] };
    await abd.initAbd();
    await flush();
    expect(calls('abd.set_token')).toHaveLength(1);
    expect(calls('abd.set_token')[0]).toEqual({ accountId: OAUTH.id, accessToken: TOKEN, expiresAtMs: 4_000_000_000_000 });

    await vi.advanceTimersByTimeAsync(abd.TOKEN_REFRESH_MS - 1);
    expect(calls('abd.set_token')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls('abd.set_token')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(abd.TOKEN_REFRESH_MS);
    expect(calls('abd.set_token')).toHaveLength(3);
  });

  it('never pushes a token for a password account, and runs no timer for it', async () => {
    h.status = { jobs: [frame({ jobId: 'p', accountId: PASSWORD.id, provider: 'gmail' })] };
    await abd.initAbd();
    await vi.advanceTimersByTimeAsync(abd.TOKEN_REFRESH_MS * 3);
    expect(calls('abd.set_token')).toHaveLength(0);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('answers abd-token-needed at once, without waiting for the timer', async () => {
    h.status = { jobs: [frame()] };
    await abd.initAbd();
    await flush();
    expect(calls('abd.set_token')).toHaveLength(1);
    h.listeners.get('abd-token-needed')({ payload: { accountId: OAUTH.id, jobId: 'abd-acc-1', provider: 'graph' } });
    await flush();
    expect(calls('abd.set_token')).toHaveLength(2);
  });

  it('stops handing over tokens once the job ends', async () => {
    h.status = { jobs: [frame()] };
    await abd.initAbd();
    await flush();
    expect(calls('abd.set_token')).toHaveLength(1);
    h.listeners.get('abd-progress')({ payload: frame({ finished: true, outcome: 'completed', status: { state: 'completed' }, updatedMs: 2000 }) });
    await vi.advanceTimersByTimeAsync(abd.TOKEN_REFRESH_MS * 3);
    expect(calls('abd.set_token')).toHaveLength(1);
  });

  it('keeps the token out of the store and out of every log line', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    h.status = { jobs: [frame()] };
    await abd.initAbd();
    await flush();
    await abd.startJob({ accountId: OAUTH.id, previewId: 'p1', mode: 'archive_delete' });
    // A failing push logs too; it must not print the token either.
    h.daemon.mockImplementationOnce(async () => { throw Object.assign(new Error(`bad request ${TOKEN}`), { code: 'RPC_ERROR' }); });
    await abd.pushToken(OAUTH.id);
    await flush();

    expect(JSON.stringify(useAbdStore.getState())).not.toContain(TOKEN);
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
  });

  it('tells a failed sign-in apart from a push: nothing is sent for it', async () => {
    h.resolve = vi.fn(async () => ({ ok: false, reason: 'refresh_failed', message: 'x' }));
    expect(await abd.pushToken(OAUTH.id)).toBe(false);
    expect(calls('abd.set_token')).toHaveLength(0);
  });
});

describe('start, pause, resume, cancel, dismiss', () => {
  it('pushes the token before the shell starts the job, then opens the panel', async () => {
    const order = [];
    h.daemon = vi.fn(async (m) => { order.push(m); return m === 'abd.status' ? h.status : {}; });
    h.start = vi.fn(async () => { order.push('abd_start'); return { jobId: 'j' }; });
    await abd.startJob({ accountId: OAUTH.id, previewId: 'p1', mode: 'archive_delete', confirmed: true });
    expect(order.indexOf('abd.set_token')).toBeLessThan(order.indexOf('abd_start'));
    expect(h.start).toHaveBeenCalledWith({ accountId: OAUTH.id, previewId: 'p1', mode: 'archive_delete', confirmed: true });
    expect(useAbdStore.getState().panel).toEqual({ accountId: OAUTH.id, minimized: false });
  });

  it('refuses to start without Premium, before anything reaches the shell or the daemon', async () => {
    useSettingsStore.setState({ billingProfile: null });
    await expect(abd.startJob({ accountId: OAUTH.id, mode: 'archive_delete', confirmed: true }))
      .rejects.toThrow(t('errors.abdPremiumRequired'));
    expect(h.start).not.toHaveBeenCalled();
    expect(calls('abd.set_token')).toHaveLength(0);
    expect(useAbdStore.getState().panel).toBeNull();
  });

  it('clears a finished job of the account before it starts the next one', async () => {
    const order = [];
    h.daemon = vi.fn(async (m) => { order.push(m); return m === 'abd.status' ? h.status : {}; });
    h.start = vi.fn(async () => { order.push('abd_start'); return { jobId: 'j2' }; });
    useAbdStore.getState().applyFrame(frame({ finished: true, outcome: 'completed', status: { state: 'completed' } }));
    await abd.startJob({ accountId: OAUTH.id, previewId: 'p2', mode: 'archive_delete', confirmed: true });
    expect(order.indexOf('abd.dismiss')).toBeGreaterThan(-1);
    expect(order.indexOf('abd.dismiss')).toBeLessThan(order.indexOf('abd_start'));
    // A running one is never dismissed by a start.
    order.length = 0;
    useAbdStore.getState().applyFrame(frame({ jobId: 'abd-acc-2', updatedMs: 9000 }));
    await abd.startJob({ accountId: OAUTH.id, previewId: 'p3', mode: 'archive_delete', confirmed: true });
    expect(order).not.toContain('abd.dismiss');
  });

  it('does not open a panel when the start is refused', async () => {
    h.start = vi.fn(async () => { throw new Error('E_ABD_NO_BACKUP_DRIVE: no drive'); });
    await expect(abd.startJob({ accountId: PASSWORD.id, mode: 'archive_backup_delete' })).rejects.toThrow('E_ABD_NO_BACKUP_DRIVE');
    expect(useAbdStore.getState().panel).toBeNull();
  });

  it('pause and cancel are daemon calls that show the new status straight away', async () => {
    useAbdStore.getState().applyFrame(frame());
    await abd.pause(OAUTH.id);
    expect(calls('abd.pause')).toEqual([{ accountId: OAUTH.id }]);
    expect(useAbdStore.getState().jobs[OAUTH.id].status).toEqual({ state: 'paused', reason: 'user' });
    await abd.cancel(OAUTH.id);
    expect(calls('abd.cancel')).toEqual([{ accountId: OAUTH.id }]);
  });

  it('resume of a backup-mode job re-attaches the drive and refreshes the token first', async () => {
    const order = [];
    h.daemon = vi.fn(async (m) => { order.push(m); return { status: { state: 'running', phase: 'download' } }; });
    h.attach = vi.fn(async () => { order.push('attach'); return { attached: true }; });
    useAbdStore.getState().applyFrame(frame({ mode: 'archive_backup_delete', status: { state: 'paused', reason: 'drive_unavailable' } }));
    await abd.resume(OAUTH.id);
    expect(order).toEqual(['attach', 'abd.set_token', 'abd.resume']);
    expect(useAbdStore.getState().jobs[OAUTH.id].status.state).toBe('running');
  });

  it('dismiss removes the job and its panel', async () => {
    useAbdStore.getState().applyFrame(frame({ finished: true, outcome: 'completed', status: { state: 'completed' } }));
    useAbdStore.getState().openPanel(OAUTH.id);
    await abd.dismiss(OAUTH.id);
    expect(calls('abd.dismiss')).toEqual([{ accountId: OAUTH.id }]);
    expect(useAbdStore.getState().jobs[OAUTH.id]).toBeUndefined();
    expect(useAbdStore.getState().panel).toBeNull();
  });
});

describe('the backup drive poll', () => {
  const drivePaused = () => frame({ accountId: 'acc-b1', mode: 'archive_backup_delete', status: { state: 'paused', reason: 'drive_unavailable' } });

  it('asks the shell to attach the drive every 30 s while the job is paused for it', async () => {
    h.status = { jobs: [drivePaused()] };
    await abd.initAbd();
    await flush();
    const atLaunch = h.attach.mock.calls.length;
    await vi.advanceTimersByTimeAsync(abd.DRIVE_POLL_MS);
    expect(h.attach.mock.calls.length).toBe(atLaunch + 1);
    await vi.advanceTimersByTimeAsync(abd.DRIVE_POLL_MS);
    expect(h.attach.mock.calls.length).toBe(atLaunch + 2);
  });

  it('stops polling once the job runs again', async () => {
    h.status = { jobs: [drivePaused()] };
    await abd.initAbd();
    h.listeners.get('abd-progress')({ payload: { ...drivePaused(), status: { state: 'running', phase: 'download' }, updatedMs: 5000 } });
    const before = h.attach.mock.calls.length;
    await vi.advanceTimersByTimeAsync(abd.DRIVE_POLL_MS * 3);
    expect(h.attach.mock.calls.length).toBe(before);
  });
});

describe('the setup preview', () => {
  it('lists through the daemon after the token, and reports a failed ask on the preview', async () => {
    const id = await abd.beginPreview(OAUTH.id);
    expect(calls('abd.preview')).toEqual([{ accountId: OAUTH.id, previewId: id }]);
    expect(h.order.indexOf('call:abd.set_token')).toBeLessThan(h.order.indexOf('call:abd.preview'));
    expect(useAbdStore.getState().previews[OAUTH.id]).toMatchObject({ previewId: id, state: 'listing' });

    h.daemon = vi.fn(async () => { throw new Error('not running'); });
    const failedId = await abd.beginPreview(PASSWORD.id);
    expect(useAbdStore.getState().previews[PASSWORD.id]).toMatchObject({ previewId: failedId, state: 'failed' });
  });

  it('follows abd-preview events for the current run only', async () => {
    await abd.initAbd();
    const id = await abd.beginPreview(PASSWORD.id);
    h.listeners.get('abd-preview')({ payload: { accountId: PASSWORD.id, previewId: 'an-older-run', state: 'ready' } });
    expect(useAbdStore.getState().previews[PASSWORD.id].state).toBe('listing');
    h.listeners.get('abd-preview')({ payload: { accountId: PASSWORD.id, previewId: id, state: 'listing', folder: 'INBOX', listed: 40 } });
    expect(useAbdStore.getState().previews[PASSWORD.id]).toMatchObject({ folder: 'INBOX', listed: 40 });
    h.listeners.get('abd-preview')({ payload: { accountId: PASSWORD.id, previewId: id, state: 'ready' } });
    expect(useAbdStore.getState().previews[PASSWORD.id].state).toBe('ready');
  });
});
