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
