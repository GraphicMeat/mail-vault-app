import { blitzThemeFor } from '../parity/themeInputs';

// Below this a surface has no real width yet (a hidden pane, a bubble mid-layout):
// opening at it would render a doc nobody sees and that must be thrown away.
export const MIN_OPEN_WIDTH = 40;
// The worker clamps a document's height here and never errors for it (src-render MAX_CSS_HEIGHT).
// A doc whose meta.cssHeight reaches it was truncated, so an export refuses to draw it (F12).
export const MAX_CSS_HEIGHT = 200000;
// The worker's `image` op paints at doc scale up to this device-pixel area and shrinks the PNG past it
// (src-render/src/doc_image.rs MAX_IMAGE_AREA_PX, the canvas wall of imagePacker.js).
export const MAX_IMAGE_AREA_PX = 16_700_000;
// The tile height the worker cuts documents into (src-render/src/doc.rs TILE_CSS_HEIGHT); meta.tileCssHeight wins when present.
export const TILE_CSS_HEIGHT = 512;
// Surfaces that mount bodies far outside the viewport (virtualizer overscan).
// Only these defer a doc's close on unmount (churn reuse); every other surface
// releases it at once.
export const LAZY_SURFACES = new Set(['thread', 'bubble']);

// AltBodyProps.sizing (overview amendment A4):
//   'content'            box = document height (style.minHeight still floors it)
//   'fill'               box = parent height, scrolls inside
//   { collapsedMax: n }  box = min(document height, n), scrolls inside past n
export function boxStyle(sizing, meta, style = {}) {
  const h = meta ? meta.cssHeight : 0;
  if (sizing === 'fill') return { ...style, height: '100%', overflowX: 'auto', overflowY: 'auto' };
  if (sizing && typeof sizing === 'object' && Number.isFinite(sizing.collapsedMax)) {
    const cap = sizing.collapsedMax;
    return { ...style, height: Math.min(h, cap), overflowX: 'auto', overflowY: h > cap ? 'auto' : 'hidden' };
  }
  return { ...style, height: h, overflowX: 'auto', overflowY: 'hidden' };
}

/** Whether the box scrolls inside (fill, collapsedMax): the root then carries overflow-y-auto, which the tile observer's root lookup finds. */
export function scrollsInside(sizing) {
  return sizing === 'fill' || (!!sizing && typeof sizing === 'object' && Number.isFinite(sizing.collapsedMax));
}

/**
 * The theme render.open carries for a surface's document, written once: BlitzTiles sends it and the
 * parity harness's surfaces matrix (tests/e2e/connected-blitz-parity.test.js) opens docs with it.
 * The chat bubble draws on no canvas colour (bg null), so the bubble's own tint shows through
 * (the iframe's body is transparent there); every other surface gets the plain theme.
 */
export function surfaceWorkerTheme(theme, surface) {
  const t = blitzThemeFor({ dark: !!theme?.dark, palette: theme?.palette });
  return surface === 'bubble' ? { ...t, bg: null } : t;
}
