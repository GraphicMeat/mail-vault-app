// @vitest-environment jsdom
// Capture actual source, only on an explicitly authorized remote runner.
import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { renderHook, cleanup } from '@testing-library/react';
const env = vi.hoisted(() => ({ handlers: {}, calls: [], credentials: true, terminal: {}, loading: false, promptFailure: false, snapshotFailure: false }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name, cb) => { env.handlers[name] = cb; return () => {}; } }));
vi.mock('../../../../src/services/api', () => ({
  backupRunAccount: async (id, _secret, _path, skip, concurrency = 1) => {
    env.calls.push(['run', id, skip, concurrency, Date.now()]);
    if (env.terminal) env.handlers['backup-progress']({ payload: { account_id: id, active: false, ...env.terminal } });
    return { runId: id };
  },
  backupCancel: async id => { env.calls.push(['cancel', id, Date.now()]); },
}));
vi.mock('../../../../src/services/authUtils', () => ({ hasValidCredentials: () => true, resolveServerAccount: async (_id, account) => env.credentials ? { ok: true, account } : { ok: false, message: 'capture credentials unavailable' } }));
vi.mock('../../../../src/stores/mailStore', () => ({ useMailStore: { getState: () => ({ accounts: [{ id: 'one', email: 'one@example.test' }, { id: 'two', email: 'two@example.test' }, { id: 'three', email: 'three@example.test' }], loading: env.loading }) } }));
vi.mock('../../../../src/stores/focusStore', () => ({ notify: (...args) => { env.calls.push(['notify', ...args]); } }));
vi.mock('../../../../src/services/snapshotService', () => ({ createSnapshotFromMaildir: async id => { env.calls.push(['snapshot', id]); if (env.snapshotFailure) throw new Error('capture snapshot failure'); } }));
vi.mock('../../../../src/utils/buildFlags', () => ({ IS_APPSTORE_BUILD: false }));
import { backupScheduler as s, State, computeNextEligibleTime, terminalFrameToResult, BACKUP_STALL_MS } from '../../../../src/services/backupScheduler';
import { useSettingsStore as store, hasPremiumAccess } from '../../../../src/stores/settingsStore';
import { useBackupStore as display } from '../../../../src/stores/backupStore';
import { useBackupScheduler } from '../../../../src/hooks/useBackupScheduler';
const copy = v => JSON.parse(JSON.stringify(v));
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const clock = Date.parse('2026-10-25T12:00:00Z');
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const reset = () => {
  s.stopAll(); vi.clearAllTimers();
  Object.assign(s, { _state: State.IDLE, _running: new Map(), _retryCount: new Map(), _queue: [], _queueRunning: false, _pausedAccountId: null, _checkpoints: new Map(), _manualIds: new Set(), _manualResolvers: new Map(), _terminalWaiters: new Map(), _stalled: new Set(), _lastProgressAt: clock, _limitHolds: new Map(), _timers: new Set(), _flushTimer: null });
  Object.assign(env, { calls: [], credentials: true, terminal: { success: true, completed_emails: 7 }, loading: false, promptFailure: false, snapshotFailure: false });
  vi.setSystemTime(clock);
  store.setState({ ...store.getInitialState(), billingProfile: { hasSubscription: true, status: 'active' }, shareGrant: null, backupGlobalEnabled: false, backupSchedules: {}, backupState: {}, backupHistory: {}, snapshotLastTimes: {}, snapshotAutoEnabled: false, backupNotifyOnFailure: false, backupNotifyOnSuccess: false });
  display.setState({ activeBackup: null, queue: [] });
};
const trace = () => ({ calls: copy(env.calls), state: s.state, queue: copy(s._queue), running: [...s._running], retries: [...s._retryCount], checkpoints: [...s._checkpoints], holds: [...s._limitHolds].map(([id, h]) => [id, h.until]), backupState: copy(store.getState().backupState), history: copy(store.getState().backupHistory), snapshotLastTimes: copy(store.getState().snapshotLastTimes) });
it.skipIf(process.env.MAILVAULT_WRITE_BACKUP_FIXTURE !== '1')('captures real scheduler, coordinator and hook without replacing their policy', async () => {
  vi.useFakeTimers(); vi.setSystemTime(clock); await s.initProgressListener();
  const cases = []; const record = (category, name, input, output) => cases.push({ category, name, input: copy(input), output: copy(output) });
  const times = ['2026-03-07T06:30:00Z', '2026-03-08T06:30:00Z', '2026-03-28T01:30:00Z', '2026-03-29T00:30:00Z', '2026-10-24T00:30:00Z', '2026-10-25T00:30:00Z', '2026-10-31T05:30:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'];
  const configs = [{ interval: 'hourly' }, { interval: 'hourly', hourlyInterval: 0 }, { interval: 'hourly', hourlyInterval: -2 }, { interval: 'hourly', hourlyInterval: 0.5 }, { interval: 'daily' }, { interval: 'daily', timeOfDay: '02:30' }, { interval: 'daily', timeOfDay: '03:30' }, { interval: 'weekly', timeOfDay: '01:30', dayOfWeek: 0 }, { interval: 'weekly', timeOfDay: '03:30', dayOfWeek: 1 }, { interval: 'hours', hours: [] }, { interval: 'hours', hours: [1, 2, 3, 3, -1, 24, 1.5, '2'] }, { interval: 'hours', hours: [0, 6, 12, 18] }, { interval: 'hours', hours: [9] }];
  for (const instant of times) for (const config of configs) for (const delta of [null, -86_400_000, -3_600_000, -1_800_000, 3_600_000]) {
    const now = Date.parse(instant); const accountState = delta == null ? {} : { lastBackupTime: now + delta };
    record('schedule', `${instant}/${configs.indexOf(config)}/${delta}`, { now, config, accountState }, computeNextEligibleTime(accountState, config, now));
  }
  for (const frame of [{}, { active: false, success: false, last_error: 'early failure' }, { active: false, success: true, completed_emails: 7, errors: 2, external_copy_ok: false, external_copy_failed_count: 3 }, { active: false, cancelled: true, completed_folders: 4 }, { active: false, cancelled: true, stop_reason: 'limit_reached', limit_bytes: 1024, resume_after_ms: clock + 1000 }]) record('terminal', JSON.stringify(frame), frame, terminalFrameToResult(frame));
  for (const settings of [{}, { billingProfile: { hasSubscription: true, status: 'active' } }, { billingProfile: { hasSubscription: true, clientAccessGranted: false, premiumAccess: true, status: 'active' } }, { shareGrant: { expiresAt: clock + 1 } }, { shareGrant: { expiresAt: clock } }, { billingProfile: { hasSubscription: true, status: 'canceled', currentPeriodEnd: '2026-10-26T00:00Z' } }]) {
    reset(); store.setState({ billingProfile: null, shareGrant: null, ...settings }); record('premium', JSON.stringify(settings), { settings, now: clock }, hasPremiumAccess(settings.billingProfile));
  }
  for (const [name, change] of [
    ['global-overrides-disabled-account', { backupGlobalEnabled: true, backupGlobalConfig: { interval: 'daily' }, backupSchedules: { one: { enabled: false } }, hiddenAccounts: { two: true, three: true } }],
    ['per-account', { backupSchedules: { two: { enabled: true, interval: 'hourly' } } }],
    ['hidden', { backupGlobalEnabled: true, hiddenAccounts: { one: true, two: true, three: true } }],
    ['lapsed', { backupGlobalEnabled: true, billingProfile: null }],
    ['share', { backupGlobalEnabled: true, billingProfile: null, shareGrant: { expiresAt: clock + 1 } }],
    ['loading', { backupGlobalEnabled: true }], ['paused', { backupGlobalEnabled: true }],
  ]) { reset(); store.setState(change); env.loading = name === 'loading'; if (name === 'paused') s.onOffline(); s.checkAndQueueDue(); await settle(); record('coordinator', name, change, trace()); }
  for (const [name, terminal] of [['success', { success: true, completed_emails: 7 }], ['degraded', { success: true, completed_emails: 7, errors: 2, last_error: 'message failure', external_copy_ok: false, external_copy_error: 'mirror failure', external_copy_failed_count: 1 }], ['early-failure', { success: false, last_error: 'early failure' }], ['cancel-checkpoint', { cancelled: true, completed_folders: 4 }], ['limit', { cancelled: true, completed_folders: 4, stop_reason: 'limit_reached', limit_bytes: 1024, resume_after_ms: clock + 1000 }]]) {
    reset(); env.terminal = terminal; const result = await s.triggerManualBackup('one'); await settle(); record('coordinator', name, terminal, { ...trace(), result });
  }
  reset(); env.credentials = false; record('coordinator', 'credentials-failure', {}, { result: await s.triggerManualBackup('one'), ...trace() });
  reset(); s.onOffline(); s.queueBackup('two'); env.terminal = null; const first = s.triggerManualBackup('one'); const joined = s.triggerManualBackup('one'); await settle(); const pending = trace(); env.handlers['backup-progress']({ payload: { account_id: 'one', active: false, success: true, completed_emails: 7 } }); await settle(); record('coordinator', 'manual-join-priority-paused', {}, { samePromise: first === joined, pending, result: await first, finished: trace() });
  reset(); env.terminal = { success: false, last_error: 'retry failure' }; s.queueBackup('one'); await settle(); const retries = [trace()]; for (const delay of [30_000, 120_000, 300_000]) { await vi.advanceTimersByTimeAsync(delay); await settle(); retries.push(trace()); } record('coordinator', 'retry-exhaustion', {}, retries);
  reset(); env.terminal = null; s.queueBackup('one'); await settle(); const progress = []; for (let i = 0; i < 3; i++) { vi.setSystemTime(Date.now() + BACKUP_STALL_MS - 1); env.handlers['archive-progress']({ payload: {} }); s.tick(); progress.push(trace()); } vi.setSystemTime(Date.now() + BACKUP_STALL_MS + 1); s.tick(); await settle(); progress.push(trace()); s.tick(); await settle(); progress.push(trace()); record('known-gap', 'watchdog-synthesizes-death-without-drain', {}, progress);
  // A stale account-only terminal resolves the newer account waiter today.
  reset(); env.terminal = null; const late = s.triggerManualBackup('one'); await settle(); env.handlers['backup-progress']({ payload: { account_id: 'one', run_id: 'old', active: false, success: true, completed_emails: 99 } }); await settle(); record('known-gap', 'late-account-terminal', {}, { result: await late, ...trace() });
  for (const cadence of ['after_every_backup', 'daily', 'weekly']) for (const age of [0, 86_400_000, 604_800_000]) { reset(); store.setState({ snapshotAutoEnabled: true, snapshotCadence: cadence, snapshotLastTimes: { one: clock - age } }); await s.triggerManualBackup('one'); await settle(); record('coordinator', `snapshot-${cadence}-${age}`, { cadence, age }, trace()); }
  reset(); env.snapshotFailure = true; store.setState({ snapshotAutoEnabled: true }); await s.triggerManualBackup('one'); await settle(); record('coordinator', 'snapshot-failure', {}, trace());
  reset(); store.setState({ billingProfile: null }); const prompt = vi.spyOn(display.getState(), 'setBackupUpsell').mockImplementation(() => { throw new Error('capture prompt failure'); }); const result = await s.triggerManualBackup('one'); record('coordinator', 'cosmetic-prompt-failure', {}, { result, ...trace() }); prompt.mockRestore();
  for (const edit of [{ capEnabled: false }, { dailyDownLimitBytes: 2 }, { warningEnabled: false }, { uploadMb: 2 }]) {
    reset(); store.setState({ backupSchedules: { one: { enabled: true } }, transferLimits: { one: { capEnabled: true, dailyDownLimitBytes: 1 } } }); const unwatch = s.watchTransferLimits(); env.terminal = { cancelled: true, stop_reason: 'limit_reached', completed_folders: 4, resume_after_ms: clock + 1000 }; await s.triggerManualBackup('one'); await settle(); env.terminal = { success: true }; store.setState({ transferLimits: { one: { capEnabled: true, dailyDownLimitBytes: 1, ...edit } } }); await settle(); record('coordinator', `cap-edit-${JSON.stringify(edit)}`, edit, trace()); unwatch();
  }
  reset(); store.setState({ backupSchedules: { one: { enabled: true } } }); env.terminal = { cancelled: true, stop_reason: 'limit_reached', completed_folders: 4 }; await s.triggerManualBackup('one'); const held = trace(); env.terminal = { success: true }; await vi.advanceTimersByTimeAsync(12 * 3_600_000 + 30_000); await settle(); record('coordinator', 'utc-midnight-hold', {}, { held, resumed: trace() });
  reset(); const hookEvents = []; const spies = ['tick', 'checkAndQueueDue', 'onSleep', 'onWake', 'onOffline', 'onOnline', 'stopAll'].map(name => vi.spyOn(s, name).mockImplementation(function (...args) { hookEvents.push([name, Date.now()]); return Object.getPrototypeOf(s)[name].apply(this, args); }));
  const { unmount } = renderHook(() => useBackupScheduler()); await settle();
  await vi.advanceTimersByTimeAsync(179_000); document.dispatchEvent(new Event('keydown')); await vi.advanceTimersByTimeAsync(500); document.dispatchEvent(new Event('click')); await vi.advanceTimersByTimeAsync(180_000);
  document.dispatchEvent(new Event('mousemove')); await vi.advanceTimersByTimeAsync(4000); document.dispatchEvent(new Event('mousemove')); await vi.advanceTimersByTimeAsync(180_000);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(15_000);
  for (const gap of [75_000, 150_000, 151_000]) { vi.setSystemTime(Date.now() + gap - 15_000); await vi.advanceTimersByTimeAsync(15_000); await vi.advanceTimersByTimeAsync(10_000); }
  window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); unmount(); await vi.advanceTimersByTimeAsync(180_000); record('hook', 'actual-throttle-idle-visibility-hidden-heartbeat-unmount', {}, hookEvents); spies.forEach(spy => spy.mockRestore()); cleanup();
  reset(); for (let i = 0; i < 7; i++) { vi.setSystemTime(clock + i * 1000); await s.triggerManualBackup('one'); } record('coordinator', 'history-newest-five-cumulative', {}, trace());
  reset(); vi.resetModules();
  let disk = { 'mailvault-settings': { version: 3, state: { language: 'en', backupHistory: {} } } }; let documentVersion = 1;
  window.__TAURI__ = { core: { invoke: async (command, args) => {
    if (command === 'daemon_rpc' && args.method === 'settings.get') return { values: copy(disk), version: documentVersion };
    if (command === 'daemon_rpc' && args.method === 'settings.replace') { Object.assign(disk, args.params.values); return { version: ++documentVersion }; }
    throw new Error('unexpected capture storage command');
  } } };
  const storage = await import('../../../../src/stores/safeStorage'); const stale = JSON.parse(await storage.safeStorage.getItem('mailvault-settings'));
  disk['mailvault-settings'].state.backupHistory.one = [{ timestamp: clock, success: true }]; documentVersion++;
  stale.state.language = 'de'; storage.safeStorage.setItem('mailvault-settings', JSON.stringify(stale)); await storage.flushSafeStorage();
  record('known-gap', 'whole-store-overwrites-native-history', {}, disk); delete window.__TAURI__;
  const files = ['src/services/backupScheduler.js', 'src/hooks/useBackupScheduler.js', 'src/stores/settingsStore.js', 'src/stores/safeStorage.js', 'src/services/downloadCapWatch.js'];
  const fixture = { schemaVersion: 1, source: { dispatchCommit: '2210c130c0ce291faa07d304d688ea58381557b0', captureCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), captureTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(), appDbSchema: 11, files: Object.fromEntries(files.map(p => [p, hash(p)])), generatorSha256: hash(new URL(import.meta.url)), node: process.version, icu: process.versions.icu, zone: process.env.TZ, resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone, mocks: ['environment/side effects only: API/event/auth/mail/notify/snapshot/build; real scheduler/hook/settings actions/entitlement; fake clock and jsdom events'] }, cases };
  const encoded = Buffer.from(JSON.stringify(fixture, null, 2) + '\n').toString('base64'); console.log(`BACKUP_FIXTURE_${process.env.TZ}_BEGIN\n${encoded}\nBACKUP_FIXTURE_END`);
  expect(cases.length).toBeGreaterThan(600); reset(); vi.useRealTimers();
});
