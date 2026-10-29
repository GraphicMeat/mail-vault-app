import { daemonCall } from './daemonClient.js';
import { t } from '../i18n/index.js';
import { useMailStore } from '../stores/mailStore.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { flushSafeStorage } from '../stores/safeStorage.js';
import { isGraphAccount } from './graphConfig.js';
import { adoptGraphFolderKeys, adoptGraphFolderKeysFromListing } from './workflows/adoptGraphFolderKeys.js';
import { accountExpectedContext } from './db/accounts.js';
import * as api from './api.js';

// One launch identity belongs to the main window process, including hook remounts.
const launchId = globalThis.crypto?.randomUUID?.() || `sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let revision = 0;
let started = false;
let ready = false;
let instanceId = null;
let view = null;
let viewJSON = 'null';
let connecting = null;
let serial = Promise.resolve();
let ownerListener = null;
const ownerWaiters = new Set();
const terminal = new Set(['complete', 'failed']);

function queued(work) {
  serial = serial.catch(() => {}).then(work);
  return serial;
}

function resolvedView(state) {
  if (state.unifiedInbox || state.activeMailbox === 'UNIFIED') {
    return { accountId: null, mailbox: 'UNIFIED', unifiedFolder: state.unifiedFolder || 'INBOX' };
  }
  if (!state.activeAccountId || !state.activeMailbox) return null;
  if (state.mailboxScope?.root === state.activeMailbox) {
    return { accountId: state.activeAccountId, mailbox: state.activeMailbox,
      scopePaths: [...new Set(state.mailboxScope.paths || [])] };
  }
  return { accountId: state.activeAccountId, mailbox: state.activeMailbox };
}

/** Observe only the view facts already in the store. Native chooses targets. */
export function currentNativeView() { return resolvedView(useMailStore.getState()); }

async function ensureOwnerListener() {
  if (ownerListener) return;
  const { listen } = await import('@tauri-apps/api/event');
  ownerListener = await listen('sync-owner', event => {
    const ack = event.payload;
    for (const waiter of ownerWaiters) waiter(ack);
  });
}

function waitOwner(instance, rev) {
  let receive;
  let cancel;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ownerWaiters.delete(receive); reject(new Error('sync.owner acknowledgement timed out')); }, 3000);
    cancel = () => { clearTimeout(timer); ownerWaiters.delete(receive); resolve(null); };
    receive = ack => {
      if (ack?.launchId !== launchId || ack?.revision !== rev || ack?.instanceId !== instance) return;
      clearTimeout(timer);
      ownerWaiters.delete(receive);
      if (!ack.accepted) reject(new Error('sync.owner was refused'));
      else resolve(ack);
    };
    ownerWaiters.add(receive);
  });
  return { promise, cancel };
}

async function attachOwner(instance, rev) {
  await ensureOwnerListener();
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error('sync.owner requires the main window');
  for (let attempt = 0; attempt < 2; attempt++) {
    const acknowledged = waitOwner(instance, rev);
    // Completion here means enqueued only. The matching channel event is the ACK.
    try {
      await invoke('daemon_channel_notify', { method: 'sync.owner', params: { launchId, revision: rev } });
      return await acknowledged.promise;
    }
    catch (error) { if (attempt) throw error; }
    finally { acknowledged.cancel(); }
  }
}

async function graphReady(accountId = null) {
  const graphs = useMailStore.getState().accounts.filter(account =>
    isGraphAccount(account) && (!accountId || account.id === accountId));
  if (!graphs.length) return;
  const original = new Map(graphs.map(account =>
    [account.id, JSON.stringify(accountExpectedContext(account, 'all'))]));
  await adoptGraphFolderKeys(graphs);
  for (const account of graphs) {
    if (useSettingsStore.getState().graphFolderKeysAdoptedFromListing?.[account.id]) continue;
    try {
      const folders = await api.graphListFolders(account);
      await adoptGraphFolderKeysFromListing(account, folders);
    } catch (error) { console.warn('[sync] Graph folder adoption is pending:', account.id, error); }
  }
  await flushSafeStorage();
  const snapshot = await daemonCall('settings.get', {});
  if (!Number.isSafeInteger(snapshot?.version) || snapshot.version < 0
    || snapshot.recovered != null || !snapshot.values || typeof snapshot.values !== 'object'
    || Array.isArray(snapshot.values)) throw new Error(t('errors.syncGraphSettingsAckUnavailable'));
  const saved = snapshot.values['mailvault-settings']?.state;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved))
    throw new Error(t('errors.syncGraphSettingsAckUnavailable'));
  for (const account of graphs) {
    const current = useMailStore.getState().accounts.find(row => row.id === account.id);
    if (!current || JSON.stringify(accountExpectedContext(current, 'all')) !== original.get(account.id)
      || saved.graphFolderKeysAdopted?.[account.id] !== true
      || saved.graphFolderKeysAdoptedFromListing?.[account.id] !== true)
      throw new Error(t('errors.syncGraphAdoptionPending', { accountId: account.id }));
  }
}

async function sendContext(phase) {
  const answer = await daemonCall('sync.context', { launchId, revision, phase, view });
  if (answer?.instanceId !== instanceId || answer?.accepted !== true || answer?.revision !== revision) {
    throw new Error('sync.context acknowledgement is uncertain');
  }
  ready = true;
  return answer;
}

/** Called after the feed/typed-event listeners are installed. Status precedes
 * the same-channel owner ACK; an uncertain start is resumed with this launch ID. */
export function connectNativeSync({ channelChanged = false } = {}) {
  if (connecting) return connecting;
  connecting = queued(async () => {
    const hadOwner = ready;
    ready = false;
    const status = await daemonCall('sync.refresh_status', {});
    if (typeof status?.instanceId !== 'string' || !status.instanceId) throw new Error(t('errors.syncStatusUnavailable'));
    const changedInstance = instanceId != null && instanceId !== status.instanceId;
    instanceId = status.instanceId;
    try { await graphReady(); }
    catch (error) { console.warn('[sync] Graph readiness could not be confirmed:', error); }
    revision += 1;
    const phase = started ? 'resume' : 'start';
    started = true;
    if (!hadOwner || channelChanged || changedInstance) await attachOwner(instanceId, revision);
    await sendContext(phase);
    if (status.lastRefreshTime != null) useSettingsStore.getState().setLastRefreshTime(status.lastRefreshTime);
    return status;
  }).finally(() => { connecting = null; });
  return connecting;
}

export function observeNativeView(next = currentNativeView()) {
  const nextJSON = JSON.stringify(next);
  if (nextJSON === viewJSON) return serial;
  viewJSON = nextJSON;
  view = next;
  if (!ready) return serial;
  return queued(async () => {
    revision += 1;
    await sendContext('resume');
  });
}

export function nativeInstanceId() { return instanceId; }
export function nativeContextReady() { return ready; }

/** An explicit request gets one opaque ID. A transport uncertainty may query
 * that same ID; it never mints a replacement intent. */
export async function requestNativeRefresh({ accountId, mailbox, reason = 'manual' } = {}) {
  if (!ready) await connectNativeSync();
  if (accountId && isGraphAccount(useMailStore.getState().accounts.find(row => row.id === accountId))) {
    await graphReady(accountId);
  }
  const requestId = globalThis.crypto?.randomUUID?.() || `refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const params = { requestId, reason,
    ...(accountId ? { accountId } : {}), ...(mailbox ? { mailbox } : {}) };
  let accepted;
  try { accepted = await daemonCall('sync.refresh', params); }
  catch (error) {
    const known = await daemonCall('sync.refresh_status', { requestId }).catch(() => null);
    if (known?.instanceId !== instanceId || !known.found) throw error;
    accepted = { instanceId, receipt: known.receipts?.[0] };
  }
  if (accepted?.instanceId !== instanceId || !accepted.receipt) {
    throw new Error(t('errors.syncReceiptUncertain'));
  }
  let receipt = accepted.receipt;
  const until = Date.now() + 30_000;
  while (!terminal.has(receipt.status) && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const status = await daemonCall('sync.refresh_status', { requestId });
    if (status?.instanceId !== instanceId || !status.found) break;
    receipt = status.receipts?.[0] || receipt;
    if (status.lastRefreshTime != null) useSettingsStore.getState().setLastRefreshTime(status.lastRefreshTime);
  }
  if (receipt.status === 'failed') throw new Error(receipt.accountResults?.find(row => !row.success)?.error || 'Native refresh failed');
  return { instanceId, receipt, uncertain: !terminal.has(receipt.status) };
}
