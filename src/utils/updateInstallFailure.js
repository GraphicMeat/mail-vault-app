// Sparkle hands the app an NSError when an update cycle dies: `domain`
// SUSparkleErrorDomain and a `code` by phase (SUErrors.h: 1000s appcast,
// 2000s download, 3000s extraction, 4000s installation).

export const SPARKLE_ERROR_DOMAIN = 'SUSparkleErrorDomain';

// The two installation codes where the installer died before it touched the
// app: 4005 SUInstallationError (its port to the app went away, which is what
// macOS refusing it its cache folder on the app's first run looks like) and
// 4010 SUAgentInvalidationError (its progress agent went away). The download
// stays in Sparkle's cache, so a fresh app process installs it in one go.
const RECOVERABLE_CODES = new Set([4005, 4010]);

/** Whether a Sparkle abort error is an installer failure a restart recovers from. */
export function isRecoverableInstallFailure(error) {
  return !!error && error.domain === SPARKLE_ERROR_DOMAIN && RECOVERABLE_CODES.has(error.code);
}

/**
 * Whether a Sparkle abort is a failed download (2000s). Most often the
 * enclosure is gone: the nightly prerelease and its DMG are replaced every
 * night, and a session that found the old item still points at it.
 */
export function isDownloadFailure(error) {
  return !!error && error.domain === SPARKLE_ERROR_DOMAIN && error.code >= 2000 && error.code < 3000;
}

const RECHECK_GAP_MS = 10 * 60 * 1000;

/**
 * After a cycle whose download failed has ended, one fresh check reads the
 * current feed and offers what it holds now. At most one per ten minutes, so
 * a feed that really is broken leaves its error standing instead of looping.
 */
export function createStaleDownloadRecheck({ recheck, now = Date.now }) {
  let pending = false;
  let lastRecheck = -Infinity;
  return {
    onAbort(error) {
      if (isDownloadFailure(error)) pending = true;
    },
    onCycleFinished() {
      if (!pending) return;
      pending = false;
      if (now() - lastRecheck < RECHECK_GAP_MS) return;
      lastRecheck = now();
      recheck();
    },
  };
}
