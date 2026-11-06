// The perf gate's thresholds and verdict, store-free and JSX-free so plain Node can import them
// (scripts/mobile-perf-verdict.mjs). src/mobile/perf.js re-exports all of it.

export const FRAME_P95_LIMIT_MS = 20;
export const TAP_LIMIT_MS = 100;
/** Rows the gate needs on screen; the perf-gate seed (`seed::PERF_ROWS`) writes this many. */
export const PERF_ROWS = 10_000;

/** Both limits are strict "under", as the spec states them. */
export function gateVerdict({ frameP95, tapToPaint } = {}) {
  const reasons = [];
  if (!(frameP95 < FRAME_P95_LIMIT_MS)) reasons.push(`frame p95 ${frameP95} ms is not under ${FRAME_P95_LIMIT_MS} ms`);
  if (!(tapToPaint < TAP_LIMIT_MS)) reasons.push(`tap to paint ${tapToPaint} ms is not under ${TAP_LIMIT_MS} ms`);
  return { pass: reasons.length === 0, reasons };
}

/** A pass also needs a whole run: all rows, the scroll reached the bottom, no blank frame. */
export function wholeRunReasons({ rows, reachedEnd, blankFrames }) {
  const reasons = [];
  if (!(rows >= PERF_ROWS)) reasons.push(`only ${rows} rows, the gate needs ${PERF_ROWS}`);
  if (reachedEnd !== true) reasons.push('the scroll did not reach the last row');
  if (blankFrames !== 0) reasons.push(`${blankFrames} scroll frames showed unloaded rows`);
  return reasons;
}
