// The settings-store watchers of the download-ahead pipeline
// (EmailPipelineManager.watchTransferLimits) and the backup scheduler wake a
// job that sleeps at the daily limit when the user changes that limit. This
// is their shared test of "did the change matter": the daemon re-reads the
// limit on every check, so the only question here is whether to wake now
// instead of at the next UTC day. It goes away with those two watchers when
// the pipeline and the backup scheduler move into the daemon (phase 1 rows
// 14 and 16).

/**
 * Whether an account's background download cap changed in a way that can
 * change what the daemon lets through today: the cap switched on or off, or a
 * new download limit. The warning and the upload limit never stop a download.
 * Takes the account's `transferLimits` entry before and after.
 */
export function downloadCapChanged(prev, next) {
  return (prev?.capEnabled === true) !== (next?.capEnabled === true)
    || (prev?.dailyDownLimitBytes ?? null) !== (next?.dailyDownLimitBytes ?? null);
}
