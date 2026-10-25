import { it, expect, vi, beforeEach, afterEach } from 'vitest';
const host = vi.hoisted(() => ({ handlers: {}, view: null, reply: null, notify: vi.fn(), legacy: vi.fn(), unsub: vi.fn(), listeners: [], fail: false }));
const send = vi.hoisted(() => vi.fn(async (method, params) => {
  if (method !== 'backup.run_now' && host.query) return host.query();
  if (method === 'backup.run_now') {
    if (host.kickoff) await host.kickoff;
    if (host.fail) { host.fail = false; throw new Error('timeout'); }
    return { runId: 'r', executionId: 'e', accountId: params.accountId, status: 'queued' };
  }
  return structuredClone(host.view);
}));
vi.mock('../../src/services/transport', () => ({ send }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name, cb) => { if (host.rejectListeners) throw new Error('listener fixture');
    if (host.delayedListeners) await host.delayedListeners;
    host.handlers[name] = cb; return host.unsub; }) }));
vi.mock('../../src/services/api', () => ({ backupRunAccount: host.legacy, backupCancel: vi.fn(), sendNotification: vi.fn() }));
vi.mock('../../src/services/authUtils', () => ({ hasValidCredentials: () => true, resolveServerAccount: async (_, a) => ({ ok: true, account: a }) }));
vi.mock('../../src/services/snapshotService', () => ({ createSnapshotFromMaildir: vi.fn() }));
vi.mock('../../src/stores/focusStore', () => ({ notify: host.notify }));
const settings = vi.hoisted(() => ({ backupNotifyOnSuccess: true, backupNotifyOnFailure: true, billingProfile: { hasSubscription: true }, backupState: {}, backupHistory: {}, backupSchedules: {} }));
vi.mock('../../src/stores/settingsStore', () => ({ useSettingsStore: { getState: () => settings, setState: vi.fn() }, hasPremiumAccess: () => true }));
vi.mock('../../src/stores/mailStore', () => ({ useMailStore: { getState: () => ({ accounts: [{ id: 'one', email: 'one@test', password: 'test' }], loading: false }) } }));
const store = vi.hoisted(() => ({ activeBackup: null, queue: [], setQueue: vi.fn(), setActiveBackup: vi.fn(), clearActiveBackup: vi.fn(), setBackupUpsell: vi.fn(), setShareUnlock: vi.fn() }));
vi.mock('../../src/stores/backupStore', () => ({ useBackupStore: { getState: () => store, setState: vi.fn(p => Object.assign(store, p)) } }));
let scheduler;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const emit = (name, payload) => host.handlers[name]?.({ payload });
const terminal = (request, revision = 2, extra = {}) => ({ ...host.view, revision, requests: { [request]: { runId: 'r', executionId: 'e', accountId: 'one', status: 'success', result: { success: true, emails_backed_up: 3, errors: 0, external_copy_ok: true }, ...extra } } });
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); send.mockClear(); host.legacy.mockReset(); host.notify.mockReset(); host.unsub.mockClear(); host.handlers = {}; host.fail = false; host.query = null; host.kickoff = null; host.rejectListeners = false; host.delayedListeners = null;
  store.activeBackup = null; store.queue = []; store.setActiveBackup.mockImplementation(value => { store.activeBackup = value; }); store.clearActiveBackup.mockImplementation(() => { store.activeBackup = null; });
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

it('settles a receipt that arrives before the accepted kickoff reply', async () => {
  const dispose = scheduler.observe({ present: false }); await flush();
  let release; host.kickoff = new Promise(done => { release = done; });
  const promise = scheduler.triggerManualBackup('one'); await flush();
  const request = send.mock.calls.find(([m]) => m === 'backup.run_now')[1].requestId;
  emit('backup-schedule-changed', terminal(request, 3)); await flush();
  expect((await promise).status).toBe('success'); release(); await flush(); dispose();
});
it('fences a stale query behind a new event and rechecks a changed incarnation', async () => {
  const dispose = scheduler.observe({ present: false }); await flush();
  const promise = scheduler.triggerManualBackup('one'); await flush();
  const request = send.mock.calls.find(([m]) => m === 'backup.run_now')[1].requestId;
  let release; host.query = () => new Promise(done => { release = done; });
  emit('daemon-events-lagged', {}); await flush();
  emit('backup-schedule-changed', { ...host.view, revision: 5 }); await flush();
  host.query = null; host.view = { ...host.view, revision: 5 };
  release(terminal(request, 2)); await flush(); let settled = false; promise.then(() => { settled = true; }); await flush(); expect(settled).toBe(false);
  host.view = { ...host.view, accessIncarnation: 'new', revision: 0 };
  emit('backup-schedule-changed', host.view); await flush();
  emit('backup-schedule-changed', { ...terminal(request, 100), accessIncarnation: 'inc' }); await flush(); expect(settled).toBe(false);
  emit('backup-schedule-changed', { ...terminal(request, 1), accessIncarnation: 'new' }); await flush(); expect(settled).toBe(true); dispose();
});
it('reconciles pending callers when listener installation rejects', async () => {
  host.rejectListeners = true;
  const promise = scheduler.triggerManualBackup('one'); await flush();
  const request = send.mock.calls.find(([m]) => m === 'backup.run_now')[1].requestId;
  host.view = terminal(request, 3); await vi.advanceTimersByTimeAsync(2000); await flush();
  expect((await promise).status).toBe('success');
});
it('disposes listener registrations that finish after the last observer detaches', async () => {
  let release; host.delayedListeners = new Promise(done => { release = done; });
  const dispose = scheduler.observe({ present: false }); await flush(); dispose(); release(); await flush();
  expect(host.unsub).toHaveBeenCalledTimes(5);
});
it('does not let a stale Done timer hide a new execution', async () => {
  const dispose = scheduler.observe({ present: false }); await flush();
  emit('backup-schedule-changed', { ...host.view, revision: 2, active: { accountId:'one',runId:'r',executionId:'e',stage:'running' } }); await flush();
  const out = { intent:{accountId:'one',runId:'r',executionId:'e'},status:'success',applied:true,result:{success:true},at:42 };
  emit('backup-schedule-changed', { ...host.view,revision:3,lastOutcomes:[out] }); await flush(); expect(store.activeBackup.done).toBe(true);
  emit('backup-schedule-changed', { ...host.view,revision:4,active:{accountId:'one',runId:'r2',executionId:'e2',stage:'running'} });
  await vi.advanceTimersByTimeAsync(3000); expect(store.activeBackup.executionId).toBe('e2'); dispose();
});
it.each([
  ['missing_account', null, null, 'failed'],
  ['limit_reached', {success:false}, {limit_bytes:104857600}, 'limit_reached'],
  ['success', {success:true,emails_backed_up:3,errors:1,external_copy_ok:true}, null, 'degraded'],
])('preserves the localized manual %s result', async (status,result,frame,expected) => {
  const dispose=scheduler.observe({present:false});await flush();
  const promise=scheduler.triggerManualBackup('one');await flush();
  const request=send.mock.calls.find(([m])=>m==='backup.run_now')[1].requestId;
  emit('backup-schedule-changed',terminal(request,2,{status,result,terminal:frame}));await flush();
  const actual=await promise;expect(actual.status).toBe(expected);expect(actual.message).toBeTypeOf('string');expect(actual.message.length).toBeGreaterThan(0);
  if(status==='limit_reached')expect(actual.message).toContain('100');
  if(expected==='degraded')expect(actual.message).toContain('1');dispose();
});
it('refreshes native next-eligible display after a configuration event', async () => {
  const dispose=scheduler.observe({present:false});await flush();
  host.view={...host.view,version:2,nextEligibleTimes:{one:42000}};
  emit('settings-changed',{keys:['mailvault-settings'],version:2});await flush();
  expect(store.nativeStatus.nextEligibleTimes.one).toBe(42000);
  emit('backup-schedule-changed',{accessIncarnation:'inc',revision:2,queue:[],active:null,pendingAccess:[],lastOutcomes:[],requests:{},ready:true});await flush();
  expect(store.nativeStatus.nextEligibleTimes?.one).toBe(42000);expect(store.nativeStatus.version).toBe(2);dispose();
});
it('keeps hydration history quiet across incarnation changes but presents a missed new completion once', async () => {
  const historical={intent:{accountId:'one',runId:'baseline-run',executionId:'baseline-execution',manual:true},at:42,status:'success',result:{success:true,emails_backed_up:3,errors:0,external_copy_ok:true},applied:true};
  host.view={...host.view,lastOutcomes:[historical]};
  const dispose=scheduler.observe({present:true});await flush();
  expect(host.notify).not.toHaveBeenCalled();
  host.view={...host.view,accessIncarnation:'replacement',revision:0};
  emit('backup-schedule-changed',host.view);await flush();const baselineNotices=host.notify.mock.calls.length;
  const missed={...historical,intent:{...historical.intent,runId:'missed-run',executionId:'missed-execution'},at:43};
  host.view={...host.view,revision:1,lastOutcomes:[historical,missed]};
  emit('daemon-reconnected',{});await flush();emit('daemon-events-lagged',{});await flush();
  const unseenNotices=host.notify.mock.calls.length-baselineNotices;dispose();
  expect(unseenNotices).toBe(1);expect(baselineNotices).toBe(0);
});

it('reobserves coherently when an old generation query finishes after remount', async () => {
  let release; host.query=()=>new Promise(done=>{release=done;}); store.nativeStatus=null;
  const first=scheduler.observe({present:false}); await flush(); first();
  host.query=null; host.view={...host.view,revision:9,context:{automaticEnabled:false},nextEligibleTimes:{one:42000}};
  const second=scheduler.observe({present:false}); await flush();
  release({...host.view,revision:1}); await flush();
  const current=store.nativeStatus; const queries=send.mock.calls.filter(([method])=>method==='backup.schedule.get').length;
  second(); expect(queries).toBe(2); expect(current?.revision).toBe(9); expect(current?.nextEligibleTimes.one).toBe(42000);
});

it('projects only the current execution progress, including missing-message detail', async () => {
  const dispose=scheduler.observe({present:false});await flush();
  emit('backup-schedule-changed',{...host.view,revision:2,active:{accountId:'one',runId:'run-b',executionId:'exec-b',stage:'running'}});
  emit('backup-progress',{account_id:'one',runId:'run-b',executionId:'exec-b',active:true,folder:'CURRENT',total_folders:10,completed_folders:4,completed_emails:40,missing_in_folder:2});
  const projected={...store.activeBackup};
  emit('backup-progress',{account_id:'one',runId:'run-a',executionId:'exec-a',active:true,folder:'STALE',completed_emails:1});
  emit('backup-progress',{account_id:'one',runId:'run-a',executionId:'exec-a',active:false});await flush();
  expect(store.activeBackup).toEqual(projected);expect(projected.folder).toBe('CURRENT');expect(projected.missingInFolder).toBe(2);dispose();
});
