import { send } from './transport';
import { notify } from '../stores/focusStore';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { useBackupStore } from '../stores/backupStore';
import { useMailStore } from '../stores/mailStore';
import { IS_APPSTORE_BUILD } from '../utils/buildFlags';
import { t } from '../i18n/index.js';

const terminal = new Set(['success', 'degraded', 'failed', 'failed_credentials', 'cancelled', 'limit_reached', 'missing_account']);
const pending = new Map();
const observers = new Set();
let generation = 0;
let initialization;
let unlisteners = [];
let current;
let refresh;
let refreshNeeded = false;
let eventGeneration = 0;
let poll;
let doneTimer;
let lastProgressAt = 0;
let hostHydrated = false;
function retryAmbiguous() {
  for (const [accountId, waiter] of pending) {
    if (!waiter.ambiguous || waiter.retrying) continue;
    waiter.retrying = true;
    send('backup.run_now', { accountId, requestId: waiter.requestId }).then(() => { waiter.ambiguous = false; }).catch(() => {}).finally(() => { waiter.retrying = false; void requestRefresh(); });
  }
}
const presented = new Set();
const presentedRuns = new Set();
const keyOf = o => `${current?.accessIncarnation}/${o.intent?.runId}/${o.intent?.executionId}/${o.at}`;
const hasHost = () => [...observers].some(o => o.present);
const ignoreFailure = fn => { try { Promise.resolve(fn()).catch(() => {}); } catch { /* presentation cannot change a native result */ } };

function resultFor(receipt) {
  if (!receipt || !terminal.has(receipt.status)) return null;
  if (receipt.status === 'success' && receipt.result?.success !== true) return null;
  const result = receipt.result;
  const degraded = receipt.status === 'success' && (result.errors > 0 || result.external_copy_ok === false || result.external_copy_failed_count > 0);
  return { status: degraded ? 'degraded' : receipt.status, message: receipt.message || result?.error_message || result?.external_copy_error || null };
}
function present(outcome) {
  if (!outcome.applied) return;
  const key = keyOf(outcome); const stable = `${outcome.intent?.runId}/${outcome.intent?.executionId}/${outcome.at}`;
  if (presented.has(key) || presentedRuns.has(stable)) return; presented.add(key); presentedRuns.add(stable);
  const result = resultFor(outcome); if (!result || !hasHost()) return;
  const settings = useSettingsStore.getState();
  const success = result.status === 'success';
  const partial = result.status === 'degraded';
  const account = useMailStore.getState().accounts.find(a => a.id === outcome.intent.accountId);
  const count = outcome.result?.emails_backed_up || 0;
  if ((success && settings.backupNotifyOnSuccess) || (!success && settings.backupNotifyOnFailure)) {
    const descriptor = outcome.presentation || {};
    const title = descriptor.titleKey || (success ? 'svc.backupScheduler.completedTitle' : partial ? 'svc.backupScheduler.partialTitle' : 'svc.backupScheduler.failedTitle');
    ignoreFailure(() => notify(t(title, { account: account?.email || outcome.intent.accountId }), result.message || t('svc.backupScheduler.completedCount', { count })));
  }
  if (IS_APPSTORE_BUILD || !success || hasPremiumAccess(settings.billingProfile)) return;
  ignoreFailure(async () => {
    const store = useBackupStore.getState();
    if (outcome.intent.manual && !settings.upsellBackupShown) {
      await settings.markUpsellBackupShown(); await store.setBackupUpsell({ emailsBackedUp: count });
    } else if (!(settings.shareGrant?.expiresAt > Date.now()) && Date.now() - (settings.shareUnlockLastShownAt || 0) > 7 * 86400000) {
      await settings.markShareUnlockShown(); await store.setShareUnlock({ emailsBackedUp: count });
    }
  });
}
function project(view) {
  const store = useBackupStore.getState();
  store.setQueue((view.queue || []).map(i => i.accountId));
  useBackupStore.setState({ nativeStatus: view });
  const active = view.active || view.pendingAccess?.[0];
  if (active) {
    clearTimeout(doneTimer);
    const old = useBackupStore.getState().activeBackup;
    if (old?.executionId !== active.executionId || old?.status !== active.stage) store.setActiveBackup({
      accountId: active.accountId, runId: active.runId, executionId: active.executionId,
      accountEmail: useMailStore.getState().accounts.find(a => a.id === active.accountId)?.email,
      active: true, done: false, status: active.stage, queueLength: view.queue?.length || 0,
      completedEmails: 0, completedFolders: 0, totalFolders: 0,
    });
  } else {
    const old = useBackupStore.getState().activeBackup;
    const completed = (view.lastOutcomes || []).find(o => o.intent?.executionId === old?.executionId && o.applied);
    if (old && completed) {
      const revision = view.revision; const execution = old.executionId;
      store.setActiveBackup({ ...old, active: false, done: true, status: completed.status });
      clearTimeout(doneTimer);
      doneTimer = setTimeout(() => {
        if (current?.revision === revision && useBackupStore.getState().activeBackup?.executionId === execution) useBackupStore.getState().clearActiveBackup();
      }, 3000);
    } else if (old && !old.done) store.clearActiveBackup();
  }
}
function consume(view, query = false) {
  if (!view || !Number.isSafeInteger(view.revision) || typeof view.accessIncarnation !== 'string') return;
  if (current?.accessIncarnation !== view.accessIncarnation && !query) { void requestRefresh(); return; }
  if (current?.accessIncarnation === view.accessIncarnation && view.revision < current.revision) return;
  current = view; useBackupStore.setState({ nativeError: null }); project(view);
  if (hasHost() && !hostHydrated) {
    for (const out of view.lastOutcomes || []) presented.add(keyOf(out));
    hostHydrated = true;
  } else if (hasHost()) {
    for (const out of view.lastOutcomes || []) present(out);
  }
  for (const [accountId, waiter] of pending) {
    const receipt = view.requests?.[waiter.requestId];
    if (receipt?.accountId !== accountId) continue;
    const result = resultFor(receipt); if (!result) continue;
    pending.delete(accountId); waiter.resolve(result);
  }
  if (!pending.size) { clearInterval(poll); poll = null; maybeDetach(); }
}
function requestRefresh() {
  refreshNeeded = true;
  if (refresh) return refresh;
  const owner = generation;
  refresh = (async () => {
    while (refreshNeeded && owner === generation) {
      refreshNeeded = false; const eventAtStart = eventGeneration;
      try {
        const view = await send('backup.schedule.get', {});
        if (owner !== generation) return;
        if (eventAtStart !== eventGeneration) { refreshNeeded = true; continue; }
        consume(view, true);
      } catch { if (owner === generation) useBackupStore.setState({ nativeError: 'unavailable' }); }
    }
  })().finally(() => { refresh = null; });
  return refresh;
}
function progress(payload) {
  const active = current?.active;
  if (!active || payload.account_id !== active.accountId || payload.runId !== active.runId || payload.executionId !== active.executionId) return;
  if (payload.active !== false && Date.now() - lastProgressAt < 2000) return;
  lastProgressAt = Date.now();
  const old = useBackupStore.getState().activeBackup;
  if (!old || old.executionId !== active.executionId) return;
  useBackupStore.getState().setActiveBackup({ ...old, folder: payload.folder, totalFolders: payload.total_folders,
    completedFolders: payload.completed_folders, completedEmails: payload.completed_emails,
    // A terminal progress frame is display data, never a completion receipt.
    active: true, done: false,
  });
  if (payload.active === false) void requestRefresh();
}
async function ensure() {
  if (initialization) return initialization;
  const owner = ++generation;
  initialization = (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const registrations = await Promise.allSettled([
        listen('backup-schedule-changed', ({ payload }) => { if (owner !== generation) return; eventGeneration++; consume(payload); }),
        listen('backup-progress', ({ payload }) => { if (owner === generation) progress(payload); }),
        ...['daemon-reconnected', 'daemon-events-lagged'].map(name => listen(name, () => { if (owner === generation) { retryAmbiguous(); void requestRefresh(); } })),
      ]);
      for (const result of registrations) if (result.status === 'fulfilled') {
        if (owner === generation) unlisteners.push(result.value); else result.value();
      }
    } catch { /* query reconciliation still works when listener installation fails */ }
    if (owner === generation) await requestRefresh();
  })();
  return initialization;
}
function maybeDetach() {
  if (observers.size || pending.size) return;
  generation++; unlisteners.splice(0).forEach(fn => ignoreFailure(fn));
  initialization = null; current = null; hostHydrated = false;
  clearTimeout(doneTimer);
}
export const backupScheduler = {
  observe({ present = false } = {}) {
    const observer = { present }; observers.add(observer);
    if (present && current && !hostHydrated) { for (const out of current.lastOutcomes || []) presented.add(keyOf(out)); hostHydrated = true; }
    void ensure();
    return () => { observers.delete(observer); if (!hasHost()) hostHydrated = false; maybeDetach(); };
  },
  triggerManualBackup(accountId) {
    if (pending.has(accountId)) return pending.get(accountId).promise;
    let resolve; const promise = new Promise(done => { resolve = done; });
    const requestId = crypto.randomUUID(); pending.set(accountId, { requestId, resolve, promise });
    void ensure().then(async () => {
      try { await send('backup.run_now', { accountId, requestId }); } catch { const waiter = pending.get(accountId); if (waiter?.requestId === requestId) waiter.ambiguous = true; }
      await requestRefresh();
    }).catch(() => {});
    if (!poll) poll = setInterval(() => { retryAmbiguous(); void requestRefresh(); }, 2000);
    return promise;
  },
  isRunning(accountId) { return current?.active?.accountId === accountId || (current?.queue || []).some(i => i.accountId === accountId); },
  stopAll() { return send('backup.stop', {}).then(() => requestRefresh()); },
  status() { return send('backup.schedule.get', {}); },
};
