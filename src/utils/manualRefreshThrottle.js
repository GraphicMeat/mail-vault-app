// ── Manual-refresh throttle ──
// UI fires instantly on every click (brief spinner). Actual sync runs at most
// once per REFRESH_COOLDOWN_MS, and at most one at a time. Clicks during the
// cooldown or during an in-flight sync are coalesced into a single trailing
// run.
//
// `run` is the unthrottled refresh; `setSpinning(bool)` paints the button.
const REFRESH_COOLDOWN_MS = 15_000;
const REFRESH_SPINNER_MIN_MS = 600;

export function createManualRefreshThrottle(run, setSpinning) {
  let lastRefreshAt = 0;
  let refreshInFlight = false;
  let pendingRefresh = false;
  let pendingTimer = null;

  function flashSpinner() {
    setSpinning(true);
    setTimeout(() => setSpinning(false), REFRESH_SPINNER_MIN_MS);
  }

  function scheduleTrailingRefresh(delayMs) {
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (pendingRefresh) {
        pendingRefresh = false;
        runRefresh();
      }
    }, Math.max(0, delayMs));
  }

  async function runRefresh() {
    if (refreshInFlight) {
      pendingRefresh = true;
      return;
    }
    const now = Date.now();
    const elapsed = now - lastRefreshAt;
    if (elapsed < REFRESH_COOLDOWN_MS) {
      pendingRefresh = true;
      scheduleTrailingRefresh(REFRESH_COOLDOWN_MS - elapsed);
      return;
    }
    refreshInFlight = true;
    lastRefreshAt = Date.now();
    try {
      await run();
    } catch (err) {
      console.warn('[accountSlice] refreshCurrentView failed:', err);
    } finally {
      refreshInFlight = false;
      if (pendingRefresh) {
        // The timer consumes this intent. Clearing it here drops a click made
        // while the first refresh was in flight.
        const wait = Math.max(0, REFRESH_COOLDOWN_MS - (Date.now() - lastRefreshAt));
        scheduleTrailingRefresh(wait);
      }
    }
  }

  return function throttledRefresh() {
    flashSpinner();
    runRefresh();
  };
}
