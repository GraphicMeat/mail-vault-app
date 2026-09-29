// Pure helpers over an `abd-progress` frame (the daemon's Archive & delete
// job report, part-d design 6.6). The store and every component read a frame
// through these, so "is it over", "is it a backup-mode job" and "how far along"
// have one answer.

export const MODE_BACKUP = 'archive_backup_delete';
export const MODE_ARCHIVE = 'archive_delete';

/** `finished` is sent exactly once per job end, with `outcome` completed/cancelled/failed. */
export const isFinished = (frame) => !!frame?.finished;
export const isUnfinished = (frame) => !!frame && !frame.finished;
export const isBackupMode = (frame) => frame?.mode === MODE_BACKUP;

/** Paused because the backup drive went away: the app re-attaches it every 30 s. */
export const isDrivePaused = (frame) =>
  isUnfinished(frame) && frame.status?.state === 'paused' && frame.status?.reason === 'drive_unavailable';

/** A state the job leaves by itself (a wait) or on a person or thing arriving (a pause). */
export const isStalled = (frame) =>
  isUnfinished(frame) && (frame.status?.state === 'waiting' || frame.status?.state === 'paused');

/**
 * One 0-100 number for the pill. Every message that can finish has to be
 * checked in the vault, sit on the drive (backup mode) and leave the server;
 * a message that is kept on the server never will, so it leaves the count.
 */
export function pillPercent(frame) {
  const counts = frame?.counts || {};
  const total = Math.max(0, (counts.scoped || 0) - (counts.kept || 0));
  if (total === 0) return frame?.finished && frame.outcome === 'completed' ? 100 : 0;
  const steps = [counts.vaultVerified || 0, counts.deleted || 0];
  if (isBackupMode(frame)) steps.push(counts.onDrive || 0);
  const done = steps.reduce((sum, n) => sum + Math.min(n, total), 0);
  return Math.min(100, Math.floor((100 * done) / (total * steps.length)));
}

/** The reasons a job kept mail on the server, as `[reason, count]`, largest first. */
export function keptReasons(frame) {
  return Object.entries(frame?.counts?.keptByReason || {})
    .filter(([, n]) => n > 0)
    // Ties by reason id (a code, never shown), so the order does not depend on the reader's language.
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
