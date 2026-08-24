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
