// A drag down the checkbox column ticks every row it passes (iOS Mail's way). Pure: the rows from
// the one where the drag began to the one under the finger, and what the drag does to them.

/** The row index under a touch at `y`: the column's top is `top`, each row is `height` tall; clamped to the list. */
export function rowIndexAt(y, top, height, total) {
  if (!total || height <= 0) return -1;
  return Math.max(0, Math.min(total - 1, Math.floor((y - top) / height)));
}

/** Every index from `a` to `b`, either way round. */
export function span(a, b) {
  const [from, to] = a <= b ? [a, b] : [b, a];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/**
 * The drag's mode: starting on an unticked row ticks what it passes, on a ticked one unticks it.
 * `ticked` says whether the starting row is.
 */
export const sweepMode = (ticked) => !ticked;
