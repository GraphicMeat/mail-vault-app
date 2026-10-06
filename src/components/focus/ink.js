/**
 * The countdown's ink over a focus scene: dark on a bright sky, light on a
 * dark one. A gap between the two thresholds keeps the current ink while the
 * sky sits in between, so the text never flickers at the crossover.
 * Luminance is relative luminance (0..1), as `skyLuminanceAt` gives it.
 */
export const INK_TO_LIGHT = 0.2;  // below this, white text wins
export const INK_TO_DARK = 0.24;  // above this, dark text wins

/** @returns {'dark'|'light'} */
export function nextInk(current, luminance) {
  if (current === 'light') return luminance > INK_TO_DARK ? 'dark' : 'light';
  return luminance < INK_TO_LIGHT ? 'light' : 'dark';
}
