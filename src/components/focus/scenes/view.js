/**
 * Screen-fit math for the focus scenes. No three.js and no DOM, so it can be
 * tested on its own.
 *
 * The diorama is fitted into the free area below the countdown, and the art
 * pixel is chosen so the island always carries the same detail (`detail` art
 * pixels per world unit) on a phone, a laptop, 4K or an ultrawide.
 *
 * @param {object} o
 * @param {number} o.w          host width, CSS px
 * @param {number} o.h          host height, CSS px
 * @param {number} o.dpr        devicePixelRatio
 * @param {number} o.insetTop   CSS px the countdown occupies at the top
 * @param {{x0:number,x1:number,y0:number,y1:number}} o.bounds  diorama extent on the camera plane
 * @param {number} o.detail     art pixels per world unit wanted
 * @param {number} o.fill       share of the free area the diorama spans
 */
export function computeView({ w, h, dpr, insetTop, bounds, detail, fill }) {
  w = Math.max(1, w);
  h = Math.max(1, h);
  dpr = dpr > 0 ? dpr : 1;
  // Never less than 45% of the window for the scene: on a very short window
  // the island tucks under the text rather than shrinking to a speck.
  const top = Math.min(Math.max(0, insetTop), h * 0.55);
  const availH = h - top;
  const bw = bounds.x1 - bounds.x0, bh = bounds.y1 - bounds.y0;
  const unitsPerCss = Math.max(bw / w, bh / availH) / fill;
  // The art pixel is a whole number of DEVICE pixels: at 125% or 150% OS
  // scaling a CSS-based size lands on fractional device pixels and draws
  // uneven columns. Never finer than one CSS pixel, or it stops reading as
  // pixel art; floor, not round, so it is never coarser than `detail` asks.
  const minPx = Math.max(2, Math.ceil(dpr - 0.01));
  const px = Math.max(minPx, Math.floor(dpr / unitsPerCss / detail));
  const rw = Math.ceil((w * dpr) / px), rh = Math.ceil((h * dpr) / px);
  // World units per art pixel. The frustum is built from the art grid so
  // pixels stay square, with the diorama's centre on the free area's centre.
  const upp = (unitsPerCss * px) / dpr;
  const cx = (bounds.x0 + bounds.x1) / 2, cy = (bounds.y0 + bounds.y1) / 2;
  const left = cx - ((w / 2) * dpr / px) * upp;
  const topEdge = cy + ((top + availH / 2) * dpr / px) * upp;
  return {
    px, rw, rh, upp,
    cssW: (rw * px) / dpr,
    cssH: (rh * px) / dpr,
    frustum: { left, right: left + rw * upp, top: topEdge, bottom: topEdge - rh * upp },
  };
}
