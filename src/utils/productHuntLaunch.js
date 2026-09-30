// Product Hunt launch takeover. Absolute UTC instants, so every timezone sees
// the same 24 hours: 12:01 am PT (PDT, UTC-7) = 10:01 am EEST = 07:01 UTC.
export const PRODUCT_HUNT_URL = 'https://www.producthunt.com/products/mailvault?launch=mailvault-2';
export const LAUNCH_START = Date.parse('2026-10-04T07:01:00Z');
export const LAUNCH_END = LAUNCH_START + 24 * 60 * 60 * 1000;
// A new user gets this long with the app before the page asks for anything.
export const NEW_USER_DELAY_MS = 10 * 60 * 1000;

/**
 * First instant the page may show. `completedAt` is when onboarding finished:
 * null for an existing install (the window's start), a time for a new user.
 */
export function launchShowFrom(completedAt = null) {
  return Math.max(LAUNCH_START, typeof completedAt === 'number' ? completedAt + NEW_USER_DELAY_MS : 0);
}

export function launchLive(now = Date.now(), completedAt = null) {
  return now >= launchShowFrom(completedAt) && now < LAUNCH_END;
}

/** The next instant `launchLive` flips, or null once nothing more will change. */
export function nextLaunchBoundary(now = Date.now(), completedAt = null) {
  const from = launchShowFrom(completedAt);
  if (now < from) return from < LAUNCH_END ? from : null;
  if (now < LAUNCH_END) return LAUNCH_END;
  return null;
}
