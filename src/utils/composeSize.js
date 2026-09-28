// The floor every compose surface enforces: the embedded CSS resize handle,
// its keyboard fallback, and the detached Tauri window's own min size all
// read from here, so the three never drift apart.
export const MIN_COMPOSE_WIDTH = 200;
export const MIN_COMPOSE_HEIGHT = 200;

/**
 * Clamp a compose size (persisted, or mid-resize) to the floor above and,
 * when given, to the space it is about to render in — a size saved on a
 * bigger monitor must never reopen off-screen or larger than the current
 * viewport/screen.
 */
export function clampComposeSize(size, viewport = {}) {
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
  const maxWidth = Number.isFinite(viewport.width) ? viewport.width : Infinity;
  const maxHeight = Number.isFinite(viewport.height) ? viewport.height : Infinity;
  return {
    width: Math.round(Math.min(Math.max(size.width, MIN_COMPOSE_WIDTH), Math.max(maxWidth, MIN_COMPOSE_WIDTH))),
    height: Math.round(Math.min(Math.max(size.height, MIN_COMPOSE_HEIGHT), Math.max(maxHeight, MIN_COMPOSE_HEIGHT))),
  };
}
