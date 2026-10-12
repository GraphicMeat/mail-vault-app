import { send } from './transport.js';
import { t, tErr } from '../i18n/index.js';
import { formatBytes } from '../utils/formatBytes';
import { formatCount } from '../utils/formatCount';

/**
 * Settings > Storage > Message format. The vault's storage format lives in
 * the vault's own marker (the daemon's `storage_format_*` routes,
 * src-daemon/src/handlers/storage_format.rs), so it travels with the vault
 * and the app keeps no setting for it. A conversion is a daemon job
 * (src-daemon/src/format_migration_job.rs) that reports by
 * `format-migration-progress`; the app shows what it says.
 *
 * `migration`, in `get()` and every progress event:
 * `{jobId, to, oldFiles, state, active, done, total, failed, error}`, where
 * `state` is running, paused, cancelled, failed or done.
 */

/** `{format: 'maildir' | 'jmap', migration: null | {...}}`. */
export const get = () => send('storage_format_get', {});
/** Starts a conversion; `oldFiles` is 'retire' or 'delete', never defaulted. */
export const convert = (to, oldFiles) => send('storage_format_convert', { to, oldFiles });
export const pause = () => send('storage_format_pause', {});
export const resume = () => send('storage_format_resume', {});
export const cancel = () => send('storage_format_cancel', {});
/** What conversions set aside: `{bytes, count}`. */
export const retired = () => send('storage_format_retired', {});
/** Deletes what conversions set aside, for good: `{bytes, count}`. */
export const purgeRetired = () => send('storage_format_purge_retired', {});
/** Sweeps message blobs no record names any more: `{removed, bytes}`. */
export const reclaimSpace = () => send('storage_reclaim_space', {});

const text = (e) => String(e?.message ?? e ?? '');

// The daemon's codes, as catalog words. A free-space refusal carries the
// bytes to free after its code, digits only.
const NO_SPACE = 'E_FORMAT_NO_SPACE:';
const ERRORS = [
  ['E_FORMAT_BUSY:', 'errors.formatBusy'],
  [NO_SPACE, 'errors.formatNoSpace'],
  ['E_FORMAT_MOVE_BLOCKED:', 'errors.formatMoveBlocked'],
  ['E_FORMAT_MARKER:', 'errors.formatMarker'],
  ['E_FORMAT_SAME:', 'errors.formatSame'],
  ['E_FORMAT_NOT_FOUND:', 'errors.formatNotFound'],
  ['E_FORMAT_RECLAIM_FAILED:', 'errors.formatReclaimFailed'],
  ['E_FORMAT_PURGE_FAILED:', 'errors.formatPurgeFailed'],
  ['E_FORMAT_IO:', 'errors.formatIo'],
];

/** A refused call, in the user's words. Anything uncatalogued goes through tErr. */
export function errorMessage(e) {
  const raw = text(e);
  const key = ERRORS.find(([prefix]) => raw.startsWith(prefix))?.[1];
  if (!key) return tErr(e);
  if (raw.startsWith(NO_SPACE)) return t(key, { size: formatBytes(Number(raw.slice(NO_SPACE.length).trim()) || 0) });
  return t(key);
}

// Why a conversion stopped (`migration.error`), by the codes its worker ends
// with (format_migration_job.rs); a count follows the two that leave
// messages or folders behind. Any other code is a refused call's.
const STOPPED = [
  ['E_FORMAT_UNVERIFIED:', 'errors.formatUnverified'],
  ['E_FORMAT_REHOME_PENDING:', 'errors.formatRehomePending'],
  ['E_FORMAT_UNREADABLE:', 'errors.formatUnreadable'],
  ['E_FORMAT_DISK:', 'errors.formatDisk'],
];

/** A stopped conversion's reason, in the user's words. */
export function failureText(error) {
  const raw = text(error);
  const hit = STOPPED.find(([prefix]) => raw.startsWith(prefix));
  if (!hit) return raw ? errorMessage(raw) : '';
  const count = Number(raw.slice(hit[0].length).trim().split(/\s/)[0]) || 0;
  return t(hit[1], { count: formatCount(count) });
}

// One load of the event API, shared by every listener (mboxUpload.js has
// the reason: two overlapping dynamic imports of one mocked module).
let eventApi = null;
async function listenTo(event, cb) {
  try {
    const { listen } = await (eventApi ||= import('@tauri-apps/api/event'));
    return await listen(event, (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

export const onProgress = (cb) => listenTo('format-migration-progress', cb);
/** A restarted daemon: a live job is gone, its journal reads as paused. */
export const onDaemonReconnected = (cb) => listenTo('daemon-reconnected', cb);
