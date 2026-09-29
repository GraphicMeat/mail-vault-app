import { send } from './transport.js';
import { t } from '../i18n/index.js';
import { forceMailboxRefetch } from './workflows/helpers/mailboxRefetch';

/**
 * "Import and restore to the server" (MBOX import mode 1) is a daemon job
 * (src-daemon/src/mbox_upload_job.rs): `import_mbox` with mode "server"
 * answers `{jobId, started}` at once, the job reports by
 * `mbox-import-progress`, and five routes hold, resume, end, forget and list
 * it. The daemon counts, measures the ETA and syncs what it uploaded; the app
 * shows what it says.
 */

export const start = (params) => send('import_mbox', params);
/** Every job the daemon holds or has a journal of. Rejects when it cannot say. */
export const status = () => send('mbox_upload_status', {}).then((r) => r?.jobs || []);
export const pause = (jobId) => send('mbox_upload_pause', { jobId });
export const cancel = (jobId) => send('mbox_upload_cancel', { jobId });
export const discard = (jobId) => send('mbox_upload_discard', { jobId });

const text = (e) => String(e?.message ?? e ?? '');

// The daemon's codes, as catalog words. Its text after the code names paths
// and internals, and never reaches the user.
const ERRORS = [
  ['E_MBOX_UPLOAD_RUNNING:', 'errors.E_MBOX_UPLOAD_RUNNING'],
  ['E_MBOX_UPLOAD_RESUMABLE:', 'errors.E_MBOX_UPLOAD_RESUMABLE'],
  ['E_MBOX_UPLOAD_NOT_FOUND:', 'errors.E_MBOX_UPLOAD_NOT_FOUND'],
  ['E_MBOX_UPLOAD_SIGN_IN:', 'errors.E_MBOX_UPLOAD_SIGN_IN'],
  ['E_MBOX_UPLOAD_READ:', 'errors.E_MBOX_UPLOAD_READ'],
  ['E_MBOX_SERVER_GRAPH:', 'errors.E_MBOX_SERVER_GRAPH'],
];
export const errorKey = (e, fallback = 'settings.backup.restore.mboxImportFailed') =>
  ERRORS.find(([prefix]) => text(e).startsWith(prefix))?.[1] || fallback;

const RESUMABLE = 'E_MBOX_UPLOAD_RESUMABLE:';
/** The job id a fresh start was refused for: this file already has a journal. */
export const resumableJobId = (e) => (text(e).startsWith(RESUMABLE) ? text(e).slice(RESUMABLE.length).trim() : null);
export const isNotFound = (e) => text(e).startsWith('E_MBOX_UPLOAD_NOT_FOUND:');

/** The native open panel for an .mbox file; null when cancelled. */
export async function pickMboxFile() {
  // WebDriver cannot drive the native open panel, so under VITE_E2E a spec
  // injects the file (exportSaver's `__MV_EXPORT_DEST__` seam). The flag is
  // compiled out of a shipped build.
  const injected = import.meta.env.VITE_E2E === '1' ? window.__MV_MBOX_SOURCE__ : null;
  if (injected) return injected;
  const { open } = await import('@tauri-apps/plugin-dialog');
  return open({ filters: [{ name: t('settings.backup.restore.mboxFiles'), extensions: ['mbox'] }], multiple: false });
}

// The resume route opens the file before anything starts (`identity()`), and
// answers with this when it cannot.
const UNREADABLE = 'Failed to read mbox file';

/**
 * Resume a job where it stopped. The daemon reopens the file by the path its
 * journal holds; after a restart a sandboxed build may not let it (the daemon
 * sidecar holds no file entitlements of its own), so the user picks the file
 * again and the daemon gets that path. Resolves null when the pick is
 * cancelled. A caller that just picked the file passes it along instead.
 */
export async function resume(jobId, sourcePath) {
  try {
    return await send('mbox_upload_resume', sourcePath ? { jobId, sourcePath } : { jobId });
  } catch (e) {
    if (sourcePath || !text(e).startsWith(UNREADABLE)) throw e;
    const picked = await pickMboxFile();
    return picked ? send('mbox_upload_resume', { jobId, sourcePath: picked }) : null;
  }
}

async function listenTo(event, cb) {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen(event, (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

// Modes 2 and 3 share the event name; only the job's payloads say "server".
export const onProgress = (cb) => listenTo('mbox-import-progress', (p) => { if (p?.mode === 'server') cb(p); });
/** A restarted daemon: its live jobs are gone, their journals read as paused. */
export const onDaemonReconnected = (cb) => listenTo('daemon-reconnected', cb);

/**
 * Once a run is done the daemon has synced every folder it uploaded into and
 * marked the cached folder list out of date when it made folders. The app
 * lists and counts the folders again the way Refresh does, so the uploaded
 * mail shows as server rows where it went: at once for the view on screen,
 * at the next open for another account.
 */
export async function refreshAfter(p) {
  if (p?.state !== 'done' || !(p.uploadedCount > 0 || p.foldersChanged)) return;
  forceMailboxRefetch(p.accountId);
  const { invalidateFolderStatus } = await import('./workflows/folderStatus');
  invalidateFolderStatus(p.accountId);
  const { useMailStore } = await import('../stores/mailStore');
  const s = useMailStore.getState();
  if (s.activeAccountId === p.accountId || s.unifiedInbox) await s.refreshCurrentView();
}
