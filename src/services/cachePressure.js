// ── Cache Pressure ─────────────────────────────────────────────────────────
// Tracks body cache size and gates prefetch decisions.
// Signal module only — never manipulates cache structures.
// Eviction policy stays with the body cache owner (cacheSlice).

let _sizeMB = 0;
// Nothing updates this, and nothing should update it naively. The eviction
// limit in cacheSlice is `cacheLimitMB || 4096` — the 4 GB standing in for the
// "unlimited" setting. Point this gate at that number and prefetch would run
// until the body cache had filled several gigabytes of WKWebView heap; the
// hardcoded 128 is what stops it. Whoever wires it to the setting must clamp:
// `_limitMB = mb > 0 ? mb : 128` — honour a real number, never the 4 GB.
const _limitMB = 128;

/** Record current body cache size in MB. Called by cache owner on add/clear. */
export function recordSize(sizeMB) {
  _sizeMB = Math.max(0, sizeMB);
}

/** Whether body cache is over 80% of limit (soft threshold). */
export function isOverPrefetchThreshold() {
  return _sizeMB > _limitMB * 0.8;
}

/** Whether prefetch should proceed (inverse of threshold check). */
export function shouldPrefetch() {
  return !isOverPrefetchThreshold();
}

// Dev tools — read-only inspection
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'cachePressure', {
    get: () => ({
      sizeMB: Math.round(_sizeMB * 10) / 10,
      limitMB: _limitMB,
      overThreshold: isOverPrefetchThreshold(),
    }),
    configurable: true,
  });
}
