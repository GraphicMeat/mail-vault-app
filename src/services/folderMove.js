import { send } from './transport.js';
import { forceMailboxRefetch } from './workflows/helpers/mailboxRefetch';

/**
 * Move folder is a daemon job (src-daemon/src/folder_move_job.rs):
 * `folder_move.plan` answers from the cached folder lists, `folder_move.start`
 * answers `{jobId}` at once, the job reports by `folder-move-progress`, and
 * five routes hold, resume, end, forget and list it. The daemon copies,
 * verifies and retires the original; the app shows what it says.
 */

/** `{sourceAccountId, sourcePath, sourceFolderId?, destAccountId, destPath|null, destFolderId?}`. */
export const plan = (params) => send('folder_move.plan', params);
export const start = (params) => send('folder_move.start', params);
/** Every job the daemon holds or has a journal of. Rejects when it cannot say. */
export const status = () => send('folder_move.status', {}).then((r) => r?.jobs || []);
export const pause = (jobId) => send('folder_move.pause', { jobId });
export const resume = (jobId) => send('folder_move.resume', { jobId });
export const cancel = (jobId) => send('folder_move.cancel', { jobId });
export const discard = (jobId) => send('folder_move.discard', { jobId });

const text = (e) => String(e?.message ?? e ?? '');

// The daemon's codes, bare (a plan refusal, a failed job's `error`) or with
// a job id or detail after a colon (a refused start or control). Its text
// after the code, and any error without one, never reaches the user.
const CODES = new Set(['RESERVED', 'INTO_ITSELF', 'RUNNING', 'NOT_FOUND', 'SOURCE_MISSING', 'SIGN_IN',
  'GRAPH_SUBFOLDERS', 'NO_HIERARCHY', 'NAME']);
const CODE = /^E_FOLDER_MOVE_([A-Z_]+)(?::|$)/;
// The daemon answers a busy keychain with the catalog key itself.
const KEYS = new Set(['errors.keychainBusy']);

export function errorKey(e, fallback = 'folderMove.failed') {
  const s = text(e);
  if (KEYS.has(s)) return s;
  const code = CODE.exec(s)?.[1];
  return CODES.has(code) ? `errors.E_FOLDER_MOVE_${code}` : fallback;
}
export const isNotFound = (e) => /^E_FOLDER_MOVE_NOT_FOUND(?::|$)/.test(text(e));

// One load of the event API, shared by every listener: two overlapping
// dynamic imports of one mocked module can resolve the second to the real
// one under vitest (see mboxUpload.js).
let eventApi = null;
async function listenTo(event, cb) {
  try {
    const { listen } = await (eventApi ||= import('@tauri-apps/api/event'));
    return await listen(event, (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

export const onProgress = (cb) => listenTo('folder-move-progress', cb);
/** A restarted daemon: its live jobs are gone, their journals read as stopped. */
export const onDaemonReconnected = (cb) => listenTo('daemon-reconnected', cb);

/**
 * A run's last event (`active: false`) that changed a server: the daemon has
 * synced the destination and marked both cached folder lists out of date.
 * The app lists and counts the folders of both accounts again. A move that is
 * done (a copy whose original went to Trash, or one rename in place) took the
 * folder away from where it was: a view open on it, or on one inside it, goes
 * to INBOX. Anything else on screen reloads the way Refresh does.
 */
export async function refreshAfter(p) {
  if (p?.active !== false || !p.sourceAccountId) return;
  const moved = p.state === 'done';
  if (!moved && !(p.copied > 0) && !(p.foldersCreated > 0)) return;
  const ids = [...new Set([p.sourceAccountId, p.destAccountId].filter(Boolean))];
  ids.forEach(forceMailboxRefetch);
  const { invalidateFolderStatus } = await import('./workflows/folderStatus');
  await Promise.all(ids.map((id) => invalidateFolderStatus(id)));
  const { useMailStore } = await import('../stores/mailStore');
  const s = useMailStore.getState();
  const d = (s.mailboxes || []).find((m) => m.delimiter)?.delimiter || '/';
  const open = s.activeMailbox;
  const wasOpen = !s.unifiedInbox && s.activeAccountId === p.sourceAccountId
    && !!open && (open === p.sourcePath || open.startsWith(p.sourcePath + d));
  if (moved && wasOpen) await s.activateAccount(p.sourceAccountId, 'INBOX');
  else if (ids.includes(s.activeAccountId) || s.unifiedInbox) await s.refreshCurrentView();
}
