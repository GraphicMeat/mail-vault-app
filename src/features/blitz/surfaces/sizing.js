// Below this a surface has no real width yet (a hidden pane, a bubble mid-layout):
// opening at it would render a doc nobody sees and that must be thrown away.
export const MIN_OPEN_WIDTH = 40;
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
