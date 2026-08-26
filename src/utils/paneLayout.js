// Width arithmetic for the three-column layout (sidebar | list | viewer).
//
// The list pane is `flex-shrink-0` at a user-chosen pixel width, so nothing
// downstream can absorb an over-wide value: whatever it does not leave for the
// viewer becomes horizontal overflow of the whole app row. That row clips its
// overflow, and a clipping box that is still a scroll container gets scrolled
// sideways by WebKit the moment a text selection reaches its edge — with no
// scrollbar to bring it back. So the clamp has to account for every pixel in
// the row, the divider included.

// Matches the divider's `w-1` / `h-1`.
export const DIVIDER_WIDTH = 4;
export const MIN_LIST_WIDTH = 240;
export const MAX_LIST_WIDTH = 600;
export const MIN_VIEWER_WIDTH = 300;

/**
 * Widest the list pane may be inside `available` px (the row minus the sidebar)
 * while the viewer keeps its minimum and the divider still fits.
 */
export function maxListPaneWidth(available) {
  return Math.min(
    MAX_LIST_WIDTH,
    Math.max(MIN_LIST_WIDTH, available - MIN_VIEWER_WIDTH - DIVIDER_WIDTH),
  );
}

/** `size` clamped into the range the row can actually hold. */
export function clampListPaneWidth(size, available) {
  return Math.max(MIN_LIST_WIDTH, Math.min(maxListPaneWidth(available), size));
}

// ─── Two-column (stacked) layout ────────────────────────────────────────────
//
// The stacked layout divides the same row on the other axis, and it used to
// read the *width* preference as a height: a legal 600px list width became a
// 600px list height, which in the app's own 600px-minimum window pushed the
// divider and the whole reading pane below the fold of a box that clips its
// overflow. Selecting a message rendered nothing, and the divider that would
// undo it was off-screen too. Heights get their own value and their own clamp.

export const MIN_LIST_HEIGHT = 120;
export const MIN_VIEWER_HEIGHT = 200;

/**
 * Tallest the list pane may be inside `available` px (the row's own height)
 * while the viewer keeps its minimum and the divider still fits.
 */
export function maxListPaneHeight(available) {
  return Math.max(MIN_LIST_HEIGHT, available - MIN_VIEWER_HEIGHT - DIVIDER_WIDTH);
}

/** `size` clamped into the range the stacked row can actually hold. */
export function clampListPaneHeight(size, available) {
  return Math.max(MIN_LIST_HEIGHT, Math.min(maxListPaneHeight(available), size));
}
