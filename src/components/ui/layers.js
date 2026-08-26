/**
 * The stacking scale.
 *
 * Before this file the app carried 14 hand-picked z values (`z-50`, `z-[60]`,
 * `z-[80]`, `z-[1000]`, `z-[9998]`…) with no record of which was meant to beat
 * which, so every new overlay was a guess. The numbers below are the ones
 * already in use — nothing was renumbered — but they now have names and an
 * order, bottom to top:
 *
 *   hud      a viewport-anchored bar that must not cover a menu
 *   surface  a full-window surface (Settings, Compose, the update sheet)
 *   popover  an anchored panel or menu — same plane as the surface that owns it,
 *            and later in the DOM, so it paints over its own host
 *   toast    trays and toasts: above any surface, below every dialog
 *   dialog   a modal dialog, including one opened from inside a surface
 *   alert    a blocking flow that must outrank a dialog (restore, server change)
 *   tooltip  pointer-following, never interactive, above everything it explains
 *   fatal    app-level interrupts — a failed chunk load, a vault that vanished
 */
export const Z = {
  hud: 'z-40',
  surface: 'z-50',
  popover: 'z-50',
  toast: 'z-[60]',
  dialog: 'z-[100]',
  alert: 'z-[1000]',
  tooltip: 'z-[9999]',
  fatal: 'z-[10000]',
};
