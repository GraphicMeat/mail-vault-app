// Archive (& back up) & delete jobs: the app's side of the daemon's job engine
// (part-d design 5 and 6). The daemon does all the work, on its own thread, and
// keeps going when a window closes; this file only
//
//   - forwards the RPCs (`abd.*` straight to the daemon through `daemonCall`,
//     the three that need the backup drive's bookmark through the shell:
//     `abd_summarize`, `abd_start`, `abd_attach`),
//   - keeps the store in step with the `abd-progress` frames,
//   - and, for OAuth accounts (Outlook and Google), keeps handing the daemon a
//     fresh access token, because the daemon can not refresh one itself.
//
// Tokens go daemon-ward only. They never enter the store, a frame, or a log.
import { daemonCall } from './daemonClient';
import * as api from './api';
import { resolveServerAccount } from './authUtils';
import { getAccounts } from '../stores/accountStore';
import { useAbdStore } from '../stores/abdStore';
import { isFinished, isUnfinished, isBackupMode, isDrivePaused } from '../utils/abdFrame';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { t, tErr } from '../i18n/index.js';

/** How often a running OAuth job gets a fresh token (access tokens live about an hour). */
export const TOKEN_REFRESH_MS = 10 * 60 * 1000;
/** How often a job paused for its backup drive asks the shell to attach it again. */
export const DRIVE_POLL_MS = 30 * 1000;
/** When an account's token comes without an expiry, promise the daemon only this much. */
const UNKNOWN_EXPIRY_MS = 30 * 60 * 1000;

const noop = () => {};
const store = () => useAbdStore.getState();
const accountOf = (accountId) => getAccounts().find(a => a.id === accountId);

/** Google and Outlook accounts sign in with OAuth; an app password (even on Gmail) needs no token. */
export const isOAuthAccount = (account) => account?.authType === 'oauth2';

const newPreviewId = () => `abd-preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ── Tokens ──────────────────────────────────────────────────────────────────

const tokenFlights = new Map();

/**
 * Give the daemon a fresh access token for an OAuth account (`abd.set_token`).
 * `resolveServerAccount` refreshes it when it is near expiry and writes the
 * refreshed one back to the keychain, the same path every other caller uses.
 * A password account, an account whose sign-in fails, or a refused push all
 * answer false; the job then pauses `sign_in_needed` on its own.
 */
export function pushToken(accountId) {
  const stored = accountOf(accountId);
  // A password account (Gmail with an app password included) needs no token.
  // One the store has not loaded yet is looked up, not assumed.
  if (stored && !isOAuthAccount(stored)) return Promise.resolve(false);
  // A timer tick, a token-needed event and a start can coincide: one refresh serves all.
  if (tokenFlights.has(accountId)) return tokenFlights.get(accountId);
  const flight = (async () => {
    try {
      const resolved = await resolveServerAccount(accountId, stored);
      const account = resolved?.ok ? resolved.account : null;
      if (!isOAuthAccount(account) || !account.oauth2AccessToken) return false;
      await daemonCall('abd.set_token', {
        accountId,
        accessToken: account.oauth2AccessToken,
        expiresAtMs: Number(account.oauth2ExpiresAt) || Date.now() + UNKNOWN_EXPIRY_MS,
      });
      return true;
    } catch (error) {
      // The code only: nothing about this call's arguments belongs in a log.
      console.warn('[abd] could not hand the daemon a sign-in token:', error?.code || error?.name || 'error');
      return false;
    } finally {
      tokenFlights.delete(accountId);
    }
  })();
  tokenFlights.set(accountId, flight);
  return flight;
}

// ── RPCs ────────────────────────────────────────────────────────────────────

/**
 * List the account's folders for the setup screen (`abd.preview`). The daemon
 * answers at once and reports through `abd-preview` events; a failure to even
 * ask lands in the same preview record. Returns the run's id.
 */
export async function beginPreview(accountId) {
  const previewId = newPreviewId();
  store().beginPreview(accountId, previewId);
  try {
    // The daemon reads the mailbox with the account's own credentials, but an
    // OAuth token expires with the app closed: hand it a fresh one first.
    await pushToken(accountId);
    await daemonCall('abd.preview', { accountId, previewId });
  } catch (error) {
    store().failPreview(accountId, previewId, tErr(error));
  }
  return previewId;
}

/** The dry-run summary for a selection (through the shell, which adds the drive for backup mode). */
export const summarize = (params) => api.abdSummarize(params);

/**
 * Start the job. Premium is checked here too, below the screens (a job that is
 * already running is not stopped when Premium lapses: it was paid for at start).
 * The token goes first, so the very first Graph call has one. Rejects with the
 * daemon's `E_ABD_*: ` message; the caller shows it with `tErr`.
 */
export async function startJob(params) {
  if (!hasPremiumAccess(useSettingsStore.getState().billingProfile)) {
    throw new Error(t('errors.abdPremiumRequired'));
  }
  // A finished job is kept on disk until dismissed (its result stays readable);
  // the account holds one job at a time, so a new one clears the old one first.
  if (isFinished(store().jobs[params.accountId])) await dismiss(params.accountId).catch(noop);
  await pushToken(params.accountId);
  const started = await api.abdStart(params);
  store().openPanel(params.accountId);
  // The first frame is on its way as an event; asking too seeds the card and the timers at once.
  refreshStatus(params.accountId).catch(noop);
  return started;
}

/** Ask the daemon for its jobs' last frames and put them in the store. */
export async function refreshStatus(accountId) {
  const reply = await daemonCall('abd.status', accountId ? { accountId } : {});
  const jobs = Array.isArray(reply?.jobs) ? reply.jobs : [];
  for (const frame of jobs) store().applyFrame(frame);
  return jobs;
}

const applyReplyStatus = (accountId, reply) => {
  if (reply?.status) store().patchStatus(accountId, reply.status);
  return reply;
};

export const pause = async (accountId) => applyReplyStatus(accountId, await daemonCall('abd.pause', { accountId }));
export const cancel = async (accountId) => applyReplyStatus(accountId, await daemonCall('abd.cancel', { accountId }));

/**
 * Resume a paused job. What paused it may be something only the app can put
 * right, so try that first: the backup drive (the shell re-resolves it) and
 * the OAuth token. Both are harmless when nothing was wrong.
 */
export async function resume(accountId) {
  const frame = store().jobs[accountId];
  if (isBackupMode(frame)) await api.abdAttach(accountId).catch(noop);
  await pushToken(accountId);
  return applyReplyStatus(accountId, await daemonCall('abd.resume', { accountId }));
}

/** Remove a finished job's files. The daemon refuses an unfinished one. */
export async function dismiss(accountId) {
  const reply = await daemonCall('abd.dismiss', { accountId });
  store().removeJob(accountId);
  return reply;
}

export const attach = (accountId) => api.abdAttach(accountId);

// ── Launch, reconnect, timers ───────────────────────────────────────────────

let started = false;
let watching = false;
let unlisteners = [];
let unsubscribe = null;
let tokenTimer = null;
let driveTimer = null;

const unfinishedFrames = () => Object.values(store().jobs).filter(isUnfinished);

/**
 * The daemon dropped what was said while the app was away (a restart, a lagging
 * event stream): ask again. For each job still going, the backup drive and the
 * token are what a fresh app instance has to hand over.
 */
async function reask() {
  const jobs = await refreshStatus();
  for (const frame of jobs.filter(isUnfinished)) {
    if (isBackupMode(frame)) api.abdAttach(frame.accountId).catch(noop);
    pushToken(frame.accountId);
  }
}

/** The daemon's `token-needed` event: its lease is missing or about to lapse. */
function onTokenNeeded(payload) {
  if (payload?.accountId) pushToken(payload.accountId);
}

/** Start or stop the two timers to match the jobs in the store. */
function syncTimers() {
  const frames = unfinishedFrames();
  // An account the store has not loaded yet counts: the tick itself skips password accounts.
  const wantToken = frames.some(f => { const a = accountOf(f.accountId); return !a || isOAuthAccount(a); });
  if (wantToken && !tokenTimer) {
    tokenTimer = setInterval(() => {
      for (const frame of unfinishedFrames()) pushToken(frame.accountId);
    }, TOKEN_REFRESH_MS);
  } else if (!wantToken && tokenTimer) {
    clearInterval(tokenTimer);
    tokenTimer = null;
  }

  const wantDrive = frames.some(f => isBackupMode(f) && isDrivePaused(f));
  if (wantDrive && !driveTimer) {
    driveTimer = setInterval(() => {
      for (const frame of unfinishedFrames()) {
        if (isBackupMode(frame) && isDrivePaused(frame)) api.abdAttach(frame.accountId).catch(noop);
      }
    }, DRIVE_POLL_MS);
  } else if (!wantDrive && driveTimer) {
    clearInterval(driveTimer);
    driveTimer = null;
  }
}

/**
 * Once, from the main window. Listeners first, then the ask: the daemon drops
 * an event nobody is subscribed to, so the last frames are asked for after the
 * listeners are up, and again on every reconnect or lag (the keychain gate's
 * pattern). An unfinished job appears as a minimized pill.
 */
export async function initAbd() {
  if (started) return;
  started = true;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    unlisteners.push(await listen('abd-progress', e => store().applyFrame(e.payload)));
    unlisteners.push(await listen('abd-preview', e => store().applyPreview(e.payload)));
    unlisteners.push(await listen('abd-token-needed', e => onTokenNeeded(e.payload)));
    unlisteners.push(await listen('daemon-reconnected', () => { reask().catch(noop); }));
    unlisteners.push(await listen('daemon-events-lagged', () => { reask().catch(noop); }));
  } catch { /* web dev mode: no Tauri events */ }
  unsubscribe = useAbdStore.subscribe(syncTimers);
  try { await reask(); } catch { /* no daemon yet: the reconnect event asks again */ }
  syncTimers();
}

/**
 * A window other than the main one (Settings opened on its own) that shows a
 * job's card: follow the frames, but leave the timers, the drive and the panel
 * to the main window. Returns a stop function.
 */
export async function watchAbd() {
  if (started || watching) return noop;
  watching = true;
  let stop = noop;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const off = [
      await listen('abd-progress', e => store().applyFrame(e.payload)),
      await listen('abd-preview', e => store().applyPreview(e.payload)),
    ];
    stop = () => { watching = false; off.forEach(fn => { try { fn(); } catch { /* already gone */ } }); };
  } catch { watching = false; }
  refreshStatus().catch(noop);
  return stop;
}

/** For tests: forget everything `initAbd` set up. */
export function __resetAbdForTests() {
  started = false;
  watching = false;
  for (const stop of unlisteners) { try { stop?.(); } catch { /* already gone */ } }
  unlisteners = [];
  unsubscribe?.();
  unsubscribe = null;
  if (tokenTimer) clearInterval(tokenTimer);
  if (driveTimer) clearInterval(driveTimer);
  tokenTimer = null;
  driveTimer = null;
  tokenFlights.clear();
  useAbdStore.setState({ jobs: {}, previews: {}, panel: null });
}
