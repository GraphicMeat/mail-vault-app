// Archive (& back up) & delete jobs: the app's side of the daemon's job engine
// (part-d design 5 and 6). The daemon does all the work, on its own thread, and
// keeps going when a window closes; this file only
//
//   - forwards the RPCs (`abd.*` straight to the daemon through `daemonCall`,
//     the three that need the backup drive's bookmark through the shell:
//     `abd_summarize`, `abd_start`, `abd_attach`),
//   - and keeps the store in step with the `abd-progress` frames.
//
// OAuth accounts (Outlook and Google) need nothing more: the daemon refreshes
// their tokens itself (src-daemon/src/oauth_tokens.rs).
import { daemonCall } from './daemonClient';
import * as api from './api';
import { getAccounts } from '../stores/accountStore';
import { useAbdStore } from '../stores/abdStore';
import { isFinished, isUnfinished, isBackupMode, isDrivePaused } from '../utils/abdFrame';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { t, tErr } from '../i18n/index.js';

/** How often a job paused for its backup drive asks the shell to attach it again. */
export const DRIVE_POLL_MS = 30 * 1000;

const noop = () => {};
const store = () => useAbdStore.getState();

/** Google and Outlook accounts sign in with OAuth; an app password (even on Gmail) needs no token. */
export const isOAuthAccount = (account) => account?.authType === 'oauth2';

const newPreviewId = () => `abd-preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
    // The daemon reads the mailbox with the account's own credentials.
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
 * Rejects with the
 * daemon's `E_ABD_*: ` message; the caller shows it with `tErr`.
 */
export async function startJob(params) {
  if (!hasPremiumAccess(useSettingsStore.getState().billingProfile)) {
    throw new Error(t('errors.abdPremiumRequired'));
  }
  // A finished job is kept on disk until dismissed (its result stays readable).
  // The daemon replaces it with the new job itself, so it is not dismissed
  // here: a start that is refused leaves the old result where it was.
  const previous = store().jobs[params.accountId];
  const finishedJobId = isFinished(previous) ? previous.jobId : null;
  const started = await api.abdStart(params);
  // Started: the old result is gone on the daemon's side too. The panel waits
  // for the new job's first frame rather than showing it. Only while the old
  // frame is still the one held: the new job's first frame may be here already.
  if (finishedJobId && store().jobs[params.accountId]?.jobId === finishedJobId) store().removeJob(params.accountId);
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
 * right, so try that first: the backup drive (the shell re-resolves it).
 * Harmless when nothing was wrong.
 */
export async function resume(accountId) {
  const frame = store().jobs[accountId];
  if (isBackupMode(frame)) await api.abdAttach(accountId).catch(noop);
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
// `watchAbd`: how many callers follow the frames, the attach in flight or done, and its stop.
let watchers = 0;
let watchAttach = null;
let watchStop = null;
let unlisteners = [];
let unsubscribe = null;
let driveTimer = null;

const unfinishedFrames = () => Object.values(store().jobs).filter(isUnfinished);

/**
 * The daemon dropped what was said while the app was away (a restart, a lagging
 * event stream): ask again. For each job still going, the backup drive is what
 * a fresh app instance has to hand over.
 */
async function reask() {
  const jobs = await refreshStatus();
  for (const frame of jobs.filter(isUnfinished)) {
    if (isBackupMode(frame)) api.abdAttach(frame.accountId).catch(noop);
  }
}

/** Start or stop the drive timer to match the jobs in the store. */
function syncTimers() {
  const frames = unfinishedFrames();
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
    unlisteners.push(await listen('daemon-reconnected', () => { reask().catch(noop); }));
    unlisteners.push(await listen('daemon-events-lagged', () => { reask().catch(noop); }));
  } catch { /* web dev mode: no Tauri events */ }
  unsubscribe = useAbdStore.subscribe(syncTimers);
  try { await reask(); } catch { /* no daemon yet: the reconnect event asks again */ }
  syncTimers();
}

/** Attach the watch listeners once for every `watchAbd` caller; see there. */
function attachWatch() {
  const attaching = (async () => {
    const off = [];
    try {
      const { listen } = await import('@tauri-apps/api/event');
      off.push(await listen('abd-progress', e => store().applyFrame(e.payload)));
      off.push(await listen('abd-preview', e => store().applyPreview(e.payload)));
    } catch { /* web dev mode: no Tauri events */ }
    const stop = () => off.forEach(fn => { try { fn(); } catch { /* already gone */ } });
    // Everyone left (or a test reset) while this attached: take them down again.
    if (watchAttach !== attaching) stop();
    else watchStop = stop;
  })();
  return attaching;
}

function detachWatch() {
  watchStop?.();
  watchStop = null;
  watchAttach = null;
}

/**
 * A window other than the main one (Settings opened on its own) that shows a
 * job's card: follow the frames, but leave the timers, the drive and the panel
 * to the main window. Returns a stop function.
 *
 * The callers share one set of listeners, counted: a second caller (another
 * card, or React StrictMode's mount, cleanup, mount) is never left without
 * them, and they come down when the last caller stops.
 */
export async function watchAbd() {
  if (started) return noop;
  watchers += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    watchers -= 1;
    if (watchers === 0) detachWatch();
  };
  if (!watchAttach) watchAttach = attachWatch();
  // Listeners first, then the ask: the daemon drops an event nobody is subscribed to.
  await watchAttach;
  refreshStatus().catch(noop);
  return release;
}

/** For tests: forget everything `initAbd` set up. */
export function __resetAbdForTests() {
  started = false;
  watchers = 0;
  detachWatch();
  for (const stop of unlisteners) { try { stop?.(); } catch { /* already gone */ } }
  unlisteners = [];
  unsubscribe?.();
  unsubscribe = null;
  if (driveTimer) clearInterval(driveTimer);
  driveTimer = null;
  useAbdStore.setState({ jobs: {}, previews: {}, panel: null, focusPill: false });
}
