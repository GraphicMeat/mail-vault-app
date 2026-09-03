import { useLayoutEffect } from 'react';

export const VIEWPORT_MARGIN = 8;

/**
 * How far a floating box must move to sit inside the viewport.
 *
 * `rect` is what getBoundingClientRect() reports — mid-animation, the box
 * scaled about its centre — and `size` is the layout size (offsetWidth /
 * offsetHeight), which no transform touches. The real box is `size` centred
 * where `rect` is. Bottom and right edges give way first; a box taller or
 * wider than the viewport keeps its top/left edge at the margin, so its first
 * items stay reachable and the far end clips.
 *
 * `viewport` is `{ width, height }`, optionally offset by `{ top, left }` for
 * a frame whose visible part is not its whole box.
 */
export function viewportShift(rect, size, viewport, margin = VIEWPORT_MARGIN) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const left = cx - size.width / 2;
  const top = cy - size.height / 2;
  const right = left + size.width;
  const bottom = top + size.height;
  const minX = (viewport.left || 0) + margin;
  const minY = (viewport.top || 0) + margin;
  const maxX = (viewport.left || 0) + viewport.width - margin;
  const maxY = (viewport.top || 0) + viewport.height - margin;
  let x = 0;
  let y = 0;
  if (right > maxX) x = maxX - right;
  if (left + x < minX) x = minX - left;
  if (bottom > maxY) y = maxY - bottom;
  if (top + y < minY) y = minY - top;
  return { x, y };
}

/**
 * Keeps the element behind `ref` inside the window, however it was placed.
 *
 * The shift goes on the `translate` property — separate from `transform`, so
 * a framer scale or slide animation and this never write over each other —
 * and it moves nothing else, so a submenu hanging off a menu item, a panel
 * anchored above a toolbar and a fixed popover all take it the same way.
 * Re-measured when the element changes size (a list filtering down, an error
 * row appearing) and when the window does; `deps` re-run it when the caller
 * moves the box.
 */
export function useViewportShift(ref, enabled = true, deps = []) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return undefined;
    let applied = { x: 0, y: 0 };
    const place = () => {
      const r = el.getBoundingClientRect();
      // The rect includes what is already applied; measure the box as placed.
      const base = { top: r.top - applied.y, left: r.left - applied.x, width: r.width, height: r.height };
      const next = viewportShift(base, { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight });
      if (next.x === applied.x && next.y === applied.y) return;
      applied = next;
      const on = next.x !== 0 || next.y !== 0;
      el.style.translate = on ? `${next.x}px ${next.y}px` : '';
      if (on) el.dataset.viewportShift = `${next.x},${next.y}`;
      else delete el.dataset.viewportShift;
    };
    place();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    ro?.observe(el);
    window.addEventListener('resize', place);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', place);
      el.style.translate = '';
      delete el.dataset.viewportShift;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, enabled, ...deps]);
}
