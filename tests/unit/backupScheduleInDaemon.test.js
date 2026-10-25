import { it, expect, vi, beforeEach, afterEach } from 'vitest';
const host = vi.hoisted(() => ({ handlers: {}, view: null, reply: null, notify: vi.fn(), legacy: vi.fn(), unsub: vi.fn(), listeners: [], fail: false }));
const send = vi.hoisted(() => vi.fn(async (method, params) => {
  if (method === 'backup.run_now') {
    if (host.fail) { host.fail = false; throw new Error('timeout'); }
    return { runId: 'r', executionId: 'e', accountId: params.accountId, status: 'queued' };
  }
  return structuredClone(host.view);
}));
vi.mock('../../src/services/transport', () => ({ send }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name, cb) => { host.handlers[name] = cb; return host.unsub; }) }));
vi.mock('../../src/services/api', () => ({ backupRunAccount: host.legacy, backupCancel: vi.fn(), sendNotification: vi.fn() }));
vi.mock('../../src/services/authUtils', () => ({ hasValidCredentials: () => true, resolveServerAccount: async (_, a) => ({ ok: true, account: a }) }));
vi.mock('../../src/services/snapshotService', () => ({ createSnapshotFromMaildir: vi.fn() }));
vi.mock('../../src/stores/focusStore', () => ({ notify: host.notify }));
const settings = vi.hoisted(() => ({ backupNotifyOnSuccess: true, backupNotifyOnFailure: true, billingProfile: { hasSubscription: true }, backupState: {}, backupHistory: {}, backupSchedules: {}, updateBackupState: vi.fn(), addBackupHistoryEntry: vi.fn() }));
vi.mock('../../src/stores/settingsStore', () => ({ useSettingsStore: { getState: () => settings, setState: vi.fn() }, hasPremiumAccess: () => true }));
vi.mock('../../src/stores/mailStore', () => ({ useMailStore: { getState: () => ({ accounts: [{ id: 'one', email: 'one@test', password: 'test' }], loading: false }) } }));
const store = vi.hoisted(() => ({ activeBackup: null, queue: [], setQueue: vi.fn(), setActiveBackup: vi.fn(), clearActiveBackup: vi.fn(), setBackupUpsell: vi.fn(), setShareUnlock: vi.fn() }));
vi.mock('../../src/stores/backupStore', () => ({ useBackupStore: { getState: () => store, setState: vi.fn(p => Object.assign(store, p)) } }));
let scheduler;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const emit = (name, payload) => host.handlers[name]?.({ payload });
const terminal = (request, revision = 2, extra = {}) => ({ ...host.view, revision, requests: { [request]: { runId: 'r', executionId: 'e', accountId: 'one', status: 'success', result: { success: true, emails_backed_up: 3, errors: 0, external_copy_ok: true }, ...extra } } });
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); send.mockClear(); host.legacy.mockReset(); host.notify.mockReset(); host.unsub.mockClear(); host.handlers = {}; host.fail = false;
  host.view = { accessIncarnation: 'inc', revision: 1, queue: [], active: null, pendingAccess: [], lastOutcomes: [], requests: {}, ready: true };
  scheduler = (await import('../../src/services/backupScheduler')).backupScheduler;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it('keeps joined manual promises pending through ACK and account-only terminal until exact receipt', async () => {
  const dispose = scheduler.observe?.({ present: true }); await flush();
  const first = scheduler.triggerManualBackup('one'); const second = scheduler.triggerManualBackup('one'); let result; first.then(r => { result = r; }); await flush();
  const calls = send.mock.calls.filter(([m]) => m === 'backup.run_now'); expect(calls).toHaveLength(1); expect(host.legacy).not.toHaveBeenCalled();
  expect(result).toBeUndefined();
  emit('backup-progress', { account_id: 'one', active: false, success: true }); await flush(); expect(result).toBeUndefined();
  const request = calls[0][1].requestId; host.view = terminal(request); emit('daemon-reconnected', {}); await flush();
  expect(await first).toEqual({ status: 'success', message: null }); expect(await second).toEqual({ status: 'success', message: null });
  expect(send.mock.calls.filter(([m]) => m === 'backup.run_now')).toHaveLength(1); dispose?.();
});
it('retains the request ID after ambiguous kickoff and reconciles a missed terminal', async () => {
  host.fail = true; const dispose = scheduler.observe?.({ present: false }); await flush();
  const promise = scheduler.triggerManualBackup('one'); await flush();
  const calls = send.mock.calls.filter(([m]) => m === 'backup.run_now'); expect(calls).toHaveLength(1);
  const request = calls[0][1].requestId; host.view = terminal(request, 3, { status: 'failed_credentials', result: null }); emit('daemon-events-lagged', {}); await flush();
  expect(await promise).toEqual({ status: 'failed_credentials', message: null });
  expect(new Set(send.mock.calls.filter(([m]) => m === 'backup.run_now').map(([, p]) => p.requestId)).size).toBe(1); dispose?.();
});
it('rejects stale revisions and never settles from malformed success', async () => {
  const dispose = scheduler.observe?.({ present: false }); await flush();
  const promise = scheduler.triggerManualBackup('one'); let settled = false; promise.then(() => { settled = true; }); await flush();
  const call = send.mock.calls.find(([m]) => m === 'backup.run_now'); expect(call).toBeDefined(); const request = call[1].requestId;
  emit('backup-schedule-changed', { ...host.view, revision: 5 });
  emit('backup-schedule-changed', terminal(request, 4)); await flush(); expect(settled).toBe(false);
  emit('backup-schedule-changed', terminal(request, 6, { result: null })); await flush(); expect(settled).toBe(false);
  emit('backup-schedule-changed', terminal(request, 7)); await flush(); expect(settled).toBe(true); dispose?.();
});
it('settles success independently of rejected presentation and does not replay old hydration notices', async () => {
  host.notify.mockRejectedValue(new Error('notification fixture'));
  const dispose = scheduler.observe?.({ present: true }); await flush();
  const promise = scheduler.triggerManualBackup('one'); await flush();
  const call = send.mock.calls.find(([m]) => m === 'backup.run_now'); expect(call).toBeDefined(); const request = call[1].requestId;
  const out = { intent: { runId: 'r', executionId: 'e', accountId: 'one', manual: true }, at: 42, status: 'success', result: { success: true, emails_backed_up: 3, external_copy_ok: true }, applied: true };
  host.view = { ...terminal(request), lastOutcomes: [out] }; emit('backup-schedule-changed', host.view); await flush();
  expect((await promise).status).toBe('success'); emit('daemon-reconnected', {}); await flush(); expect(host.notify).toHaveBeenCalledTimes(1); dispose?.();
});
