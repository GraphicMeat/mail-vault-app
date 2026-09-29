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

/**
 * The daemon never refreshes an OAuth token itself (a job held for a refused
 * sign-in re-reads the stored credentials and nothing more), so before a start
 * or a resume the app resolves the account the way the backup and the
 * vault-gap save do: resolveServerAccount rehydrates it from the keychain when
 * the store's copy has no credentials, then refreshes the token and writes it
 * where the daemon reads it (a password account and a fresh token are left
 * alone). One that cannot be resolved is the daemon's to report, as a refused
 * sign-in: the daemon reads the keychain itself.
 */
async function freshToken(accountId) {
  if (!accountId) return;
  try {
    const { useMailStore } = await import('../stores/mailStore');
    const account = (useMailStore.getState().accounts || []).find((a) => a.id === accountId);
    const { resolveServerAccount } = await import('./authUtils');
    const resolved = await resolveServerAccount(accountId, account);
    if (!resolved?.ok) console.warn('[mboxUpload] account not resolved:', resolved?.reason);
  } catch (e) {
    console.warn('[mboxUpload] account resolve failed:', e?.message || e);
  }
}

export async function start(params) {
  await freshToken(params.accountId);
  return send('import_mbox', params);
}
/** Every job the daemon holds or has a journal of. Rejects when it cannot say. */
export const status = () => send('mbox_upload_status', {}).then((r) => r?.jobs || []);
export const pause = (jobId) => send('mbox_upload_pause', { jobId });
export const cancel = (jobId) => send('mbox_upload_cancel', { jobId });
export const discard = (jobId) => send('mbox_upload_discard', { jobId });

const text = (e) => String(e?.message ?? e ?? '');
const OTHER_FILE = 'E_MBOX_UPLOAD_OTHER_FILE:';

// The daemon's codes, as catalog words. Its text after the code names paths
// and internals, and never reaches the user.
const ERRORS = [
  ['E_MBOX_UPLOAD_RUNNING:', 'errors.E_MBOX_UPLOAD_RUNNING'],
  ['E_MBOX_UPLOAD_RESUMABLE:', 'errors.E_MBOX_UPLOAD_RESUMABLE'],
  ['E_MBOX_UPLOAD_NOT_FOUND:', 'errors.E_MBOX_UPLOAD_NOT_FOUND'],
  ['E_MBOX_UPLOAD_SIGN_IN:', 'errors.E_MBOX_UPLOAD_SIGN_IN'],
  ['E_MBOX_UPLOAD_READ:', 'errors.E_MBOX_UPLOAD_READ'],
  ['E_MBOX_SERVER_GRAPH:', 'errors.E_MBOX_SERVER_GRAPH'],
  // The app's own: a file picked again to resume that is not the job's.
  [OTHER_FILE, 'mboxUpload.otherFile'],
];
export const errorKey = (e, fallback = 'settings.backup.restore.mboxImportFailed') =>
  ERRORS.find(([prefix]) => text(e).startsWith(prefix))?.[1] || fallback;

const RESUMABLE = 'E_MBOX_UPLOAD_RESUMABLE:';
/** The job id a fresh start was refused for: this file already has a journal. */
export const resumableJobId = (e) => (text(e).startsWith(RESUMABLE) ? text(e).slice(RESUMABLE.length).trim() : null);
export const isNotFound = (e) => text(e).startsWith('E_MBOX_UPLOAD_NOT_FOUND:');

/** The native open panel for an .mbox file, with an optional title; null when cancelled. */
export async function pickMboxFile(title) {
  // WebDriver cannot drive the native open panel, so under VITE_E2E a spec
  // injects the file (exportSaver's `__MV_EXPORT_DEST__` seam). The flag is
  // compiled out of a shipped build.
  const injected = import.meta.env.VITE_E2E === '1' ? window.__MV_MBOX_SOURCE__ : null;
  if (injected) return injected;
  const { open } = await import('@tauri-apps/plugin-dialog');
  return open({
    ...(title ? { title } : {}),
    filters: [{ name: t('settings.backup.restore.mboxFiles'), extensions: ['mbox'] }],
    multiple: false,
  });
}

const baseName = (path) => String(path).split(/[\\/]/).pop();

// The resume route opens the file before anything starts (`identity()`), and
// answers with this when it cannot.
const UNREADABLE = 'Failed to read mbox file';

/**
 * Resume a job where it stopped. The daemon reopens the file by the path its
 * journal holds; after a restart a sandboxed build may not let it (the daemon
 * sidecar holds no file entitlements of its own), so the user picks the file
 * again, in a panel that names it (`fileName`, the job's), and the daemon gets
 * that path. A file by another name is refused here: the daemon would take it
 * as the job's file changed, start over from byte 0 and upload it to the
 * server, which cannot be undone. Resolves null when the pick is cancelled. A
 * caller that just picked the file passes it along instead.
 */
export async function resume({ jobId, accountId, sourcePath, fileName }) {
  await freshToken(accountId);
  try {
    return await send('mbox_upload_resume', sourcePath ? { jobId, sourcePath } : { jobId });
  } catch (e) {
    if (sourcePath || !text(e).startsWith(UNREADABLE)) throw e;
    const picked = await pickMboxFile(fileName ? t('mboxUpload.pickAgainTitle', { file: fileName }) : undefined);
    if (!picked) return null;
    if (fileName && baseName(picked) !== fileName) throw new Error(OTHER_FILE);
    return send('mbox_upload_resume', { jobId, sourcePath: picked });
  }
}

// One load of the event API, shared by every listener: the chip asks for two
// in the same tick, and under vitest two overlapping dynamic imports of one
// mocked module can resolve the second to the real module (whose `listen`
// then throws without Tauri, and the listener is silently lost).
let eventApi = null;
async function listenTo(event, cb) {
  try {
    const { listen } = await (eventApi ||= import('@tauri-apps/api/event'));
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
 * A run's last event (`active: false`: done, cancelled, a read error, a
 * discard) that uploaded something or made a folder: the daemon has synced
 * the folders it uploaded into and marked the cached folder list out of date
 * when it made folders. The app lists and counts the folders again the way
 * Refresh does, so the uploaded mail shows as server rows where it went: at
 * once for the view on screen, at the next open for another account.
 */
export async function refreshAfter(p) {
  if (p?.active !== false || !(p.uploadedCount > 0 || p.foldersChanged)) return;
  forceMailboxRefetch(p.accountId);
  const { invalidateFolderStatus } = await import('./workflows/folderStatus');
  invalidateFolderStatus(p.accountId);
  const { useMailStore } = await import('../stores/mailStore');
  const s = useMailStore.getState();
  if (s.activeAccountId === p.accountId || s.unifiedInbox) await s.refreshCurrentView();
}
