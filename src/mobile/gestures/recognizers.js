// The phone's gesture logic, pure: thresholds, outcomes and small state machines that take plain
// numbers and know no DOM, so they test with synthetic input. The hooks beside this file
// (EdgeZone.jsx, useSheetDrag.js, useStepSwipe.js, useLongPress.js) feed them pointer events and
// write the resulting transforms straight to the element (no render per move).

/** Width (px) of the leading-edge strip that belongs to the back / drawer swipe. */
export const EDGE_ZONE = 20;
/** Movement (px) before a drag picks an axis. */
export const AXIS_SLOP = 10;
/** A drag this fast (px per ms) commits whatever its distance. */
export const FLICK_VELOCITY = 0.5;
/** A flick also needs this much distance (px), so a twitch is not one. */
const FLICK_MIN = 10;
/** Share of the width a back swipe, and of the height a sheet drag, needs to commit. */
export const BACK_FRACTION = 1 / 3;
export const SHEET_FRACTION = 0.3;
/** Distance (px) a viewer swipe needs to change message. */
export const STEP_DISTANCE = 60;
export const LONG_PRESS_MS = 350;
export const LONG_PRESS_SLOP = 10;

/** Whether a touch starting at `x` is in the edge zone (the right edge in a right-to-left layout). */
export function inEdgeZone(x, width, rtl = false) {
  return rtl ? x > width - EDGE_ZONE : x < EDGE_ZONE;
}

/** `distance` is how far the drag went the committing way (negative: the wrong way). */
function dismiss(distance, size, velocity, fraction) {
  if (distance <= 0) return 'cancel';
  if (distance >= size * fraction) return 'commit';
  if (velocity >= FLICK_VELOCITY && distance >= FLICK_MIN) return 'commit';
  return 'cancel';
}

/** `dx` and `velocity` are signed toward the committing side (the layer leaving). */
export function backOutcome({ dx, width, velocity = 0 }) {
  return dismiss(dx, width, velocity, BACK_FRACTION);
}

/** Dragging a sheet down (`dy` positive) or the drawer to its edge (`dx` as its closing distance). */
export function sheetOutcome({ dy, height, velocity = 0 }) {
  return dismiss(dy, height, velocity, SHEET_FRACTION);
}

/** Left is the next message and right the previous one; right-to-left layouts flip that. */
export function stepOutcome({ dx, velocity = 0, rtl = false }) {
  const far = Math.abs(dx) >= STEP_DISTANCE;
  const flick = Math.abs(velocity) >= FLICK_VELOCITY && Math.abs(dx) >= FLICK_MIN && Math.sign(velocity) === Math.sign(dx);
  if (!far && !flick) return null;
  const left = dx < 0;
  return left !== rtl ? 'next' : 'prev';
}

/** Samples closer than this (ms) say nothing about speed (events can share a frame). */
const MIN_DT = 5;

/** Speed (px per ms, signed) over the last 100ms of `add(x)` samples. */
export function createVelocityTracker(now = Date.now) {
  let samples = [];
  return {
    add(x) {
      const t = now();
      samples.push({ x, t });
      samples = samples.filter((s) => t - s.t <= 100);
    },
    velocity() {
      if (samples.length < 2) return 0;
      const a = samples[0];
      const b = samples[samples.length - 1];
      const dt = b.t - a.t;
      return dt >= MIN_DT ? (b.x - a.x) / dt : 0;
    },
    reset() { samples = []; },
  };
}

/** Picks 'x' or 'y' once a drag leaves the slop, and keeps it. */
export function createAxisLock(slop = AXIS_SLOP) {
  let x0 = 0;
  let y0 = 0;
  let axis = null;
  return {
    down(x, y) { x0 = x; y0 = y; axis = null; },
    move(x, y) {
      if (axis) return axis;
      const dx = Math.abs(x - x0);
      const dy = Math.abs(y - y0);
      if (Math.max(dx, dy) <= slop) return null;
      axis = dx >= dy ? 'x' : 'y';
      return axis;
    },
    axis() { return axis; },
  };
}

/**
 * Fires `onFire({x, y})` once, `delay` ms after `down`, unless the finger lifts, moves more than
 * `slop` px in either axis (a swipe or a drag, so it never fights the row swipe) or a scroll
 * starts first. Exported for the quick action wheel.
 */
export function createLongPress({ onFire, delay = LONG_PRESS_MS, slop = LONG_PRESS_SLOP }) {
  let timer = null;
  let x0 = 0;
  let y0 = 0;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    down(x, y) {
      cancel();
      x0 = x;
      y0 = y;
      timer = setTimeout(() => {
        timer = null;
        onFire({ x: x0, y: y0 });
      }, delay);
    },
    move(x, y) {
      if (timer !== null && (Math.abs(x - x0) > slop || Math.abs(y - y0) > slop)) cancel();
    },
    up: cancel,
    cancel,
    scroll: cancel,
    pending: () => timer !== null,
  };
}

/** The nearest horizontally scrollable element from `el` up to (not including) `root`, or null. */
export function findScrollableX(el, root, styleOf = (n) => (typeof getComputedStyle === 'function' ? getComputedStyle(n) : {})) {
  for (let n = el; n && n !== root; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth && /auto|scroll/.test(styleOf(n).overflowX || '')) return n;
  }
  return null;
}

/** A pull-to-refresh starts only from the very top (an iOS bounce reads negative) with one finger. */
export function pullMayStart(scrollTop, touches = 1) {
  return scrollTop <= 0 && touches === 1;
}
