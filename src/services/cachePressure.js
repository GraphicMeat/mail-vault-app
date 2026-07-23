// ── Cache Pressure ─────────────────────────────────────────────────────────
// Tracks body cache size and gates prefetch decisions.
// Signal module only — never manipulates cache structures.
// Eviction policy stays with the body cache owner (cacheSlice).

let _sizeMB = 0;
let _limitMB = 128; // default, updated from settings

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
