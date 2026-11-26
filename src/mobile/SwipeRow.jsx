// A list row that swipes. Dragging the row sideways reveals an action under it: the leading edge
// (start side) and the trailing edge each have one. Let go past SWIPE_OPEN / 2 and the row stays
// open on that button (44pt and up, tap it to act); let go past FULL_SWIPE of the row's width and
// the action runs at once. The drag writes the row's transform straight to the element (no React
// render, no layout per frame); the snap is a CSS transition, off under reduced motion.
// An action is in the DOM only for the side being dragged open, open, or still sliding closed
// (`revealed`, also the root's `data-side`, which makes the row a layer of its own in mobile.css).
// A resting row has neither: WKWebView painted their coloured fills at the list's edge during a
// fast scroll. A closing row drops its action when the slide ends (`transitionend`, or a timer
// in case the slide never reports), and at once when nothing slides.
// `touch-action: pan-y` leaves vertical scrolling to the browser, which cancels the pointer once
// a scroll starts. A side given as null (its swipe set to "none") does not move that way.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { haptic } from './haptics.js';
import { inEdgeZone } from './gestures/recognizers.js';

/** How far (px) an open row stays slid: the width of the revealed button. */
export const SWIPE_OPEN = 88;
/** Share of the row's width past which letting go runs the action. */
export const FULL_SWIPE = 0.55;
/** Movement (px) before a drag picks an axis. */
const SLOP = 10;
/** How long a closing row waits for its slide to report its end (the slide is 0.22s). */
const CLOSE_FALLBACK_MS = 400;

const isRtl = (el) => typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' && el
  && window.getComputedStyle(el).direction === 'rtl';
const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {{ leading: {label: string, className?: string, icon?: any},
 *           trailing: {label: string, className?: string, icon?: any},
 *           onAction: (side: 'leading'|'trailing') => void, initialOpen?: 'leading'|'trailing'|null,
 *           children: React.ReactElement }} props
 */
export default function SwipeRow({ leading, trailing, onAction, initialOpen = null, children }) {
  const root = useRef(null);
  const content = useRef(null);
  const drag = useRef(null);
  const swiped = useRef(false); // a drag happened: the click that follows is not a tap
  const rtl = useRef(null); // the layout's direction, read once per drag (not per frame)
  const [open, setOpen] = useState(initialOpen);
  const openRef = useRef(open);
  openRef.current = open;
  // The side whose action is in the DOM.
  const [revealed, setRevealedState] = useState(initialOpen);
  const revealedRef = useRef(revealed);
  const closeTimer = useRef(null);

  const setRevealed = useCallback((side) => {
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (revealedRef.current === side) return;
    revealedRef.current = side;
    setRevealedState(side);
  }, []);

  const rtlNow = useCallback(() => {
    if (rtl.current === null) rtl.current = isRtl(root.current);
    return rtl.current;
  }, []);

  // Physical offset for a side: the leading side is on the right in a right-to-left layout.
  const offsetFor = useCallback((side) => {
    if (!side) return 0;
    const sign = side === 'leading' ? 1 : -1;
    return sign * (rtlNow() ? -1 : 1) * SWIPE_OPEN;
  }, [rtlNow]);

  const place = useCallback((x, animate) => {
    const el = content.current;
    if (!el) return;
    const moved = !!el.style.transform;
    el.style.transition = animate ? '' : 'none';
    el.style.transform = x ? `translate3d(${x}px, 0, 0)` : '';
    if (x) {
      // Physical right is the leading side in a left-to-right layout.
      setRevealed((x > 0) !== rtlNow() ? 'leading' : 'trailing');
    } else if (!moved || !animate || reducedMotion()) {
      setRevealed(null);
    } else if (!closeTimer.current) {
      // Sliding closed: the action stays under the row until the slide ends.
      closeTimer.current = setTimeout(() => setRevealed(null), CLOSE_FALLBACK_MS);
    }
  }, [rtlNow, setRevealed]);

  // The slide closed: its action goes. Native listener (React's transitionend name is prefixed
  // where the environment says so).
  useEffect(() => {
    const el = content.current;
    if (!el) return undefined;
    const done = (e) => {
      if (e.target === el && !el.style.transform) setRevealed(null);
    };
    el.addEventListener('transitionend', done);
    el.addEventListener('transitioncancel', done);
    return () => {
      el.removeEventListener('transitionend', done);
      el.removeEventListener('transitioncancel', done);
      clearTimeout(closeTimer.current);
    };
  }, [setRevealed]);

  // A row at rest mounts with no transform: nothing to write (rows mount on every scroll step).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      if (!open) return;
    }
    place(offsetFor(open), true);
  }, [open, place, offsetFor]);

  const settle = (side) => {
    if (side === openRef.current) place(offsetFor(side), true);
    else setOpen(side);
  };

  const run = (side) => {
    haptic.impact('medium');
    setOpen(null);
    place(0, true);
    onAction(side);
  };

  const onPointerDown = (e) => {
    swiped.current = false;
    if (e.button > 0 || e.isPrimary === false) return;
    // The leading edge strip is the back / drawer swipe's, not a row's.
    if (inEdgeZone(e.clientX, window.innerWidth, isRtl(root.current))) return;
    const el = content.current;
    rtl.current = isRtl(root.current);
    drag.current = {
      id: e.pointerId, x0: e.clientX, y0: e.clientY, axis: null, dx: 0, armed: false,
      base: offsetFor(openRef.current), width: (el && el.offsetWidth) || 375, rtl: rtl.current,
    };
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.axis) {
      if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) {
        drag.current = null; // a scroll: the browser has it
        return;
      }
      if (Math.abs(dx) <= SLOP) return;
      d.axis = 'x';
      swiped.current = true;
      try { content.current?.setPointerCapture?.(e.pointerId); } catch { /* not capturable: fine */ }
    }
    d.dx = dx;
    let x = Math.max(-d.width, Math.min(d.width, d.base + dx));
    // Physical right is the leading side in a left-to-right layout.
    const lead = d.rtl ? -x : x;
    if ((lead > 0 && !leading) || (lead < 0 && !trailing)) x = 0;
    d.dx = x - d.base;
    // One tick as the drag passes the point where letting go runs the action, and one back.
    const armed = Math.abs(x) >= d.width * FULL_SWIPE;
    if (armed !== d.armed) {
      d.armed = armed;
      haptic.selection();
    }
    place(x, false);
  };

  const end = (e, cancelled) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.axis !== 'x' || (e && e.pointerId !== d.id)) return;
    if (cancelled) {
      settle(openRef.current);
      return;
    }
    const x = d.base + d.dx;
    // Physical right is the leading side in a left-to-right layout.
    const sideOf = (v) => ((v > 0) !== d.rtl ? 'leading' : 'trailing');
    if (Math.abs(x) >= d.width * FULL_SWIPE) run(sideOf(x));
    else if (Math.abs(x) >= SWIPE_OPEN / 2) settle(sideOf(x));
    else settle(null);
  };

  // A tap on an open row closes it; the click that ends a drag is not a tap.
  const onClickCapture = (e) => {
    if (swiped.current || openRef.current) {
      swiped.current = false;
      e.stopPropagation();
      e.preventDefault();
      if (openRef.current) setOpen(null);
    }
  };

  const action = (side, spec) => (
    <button
      key={side}
      type="button"
      className={`mv-swipe__act mv-swipe__act--${side} ${spec.className || ''}`.trim()}
      data-mv-swipe-action={side}
      tabIndex={open === side ? 0 : -1}
      aria-hidden={open === side ? undefined : 'true'}
      onClick={(e) => { e.stopPropagation(); run(side); }}
    >
      {spec.icon}
      <span className="mv-swipe__label">{spec.label}</span>
    </button>
  );

  return (
    <div ref={root} className="mv-swipe" data-side={revealed || undefined}>
      {revealed === 'leading' && leading && action('leading', leading)}
      {revealed === 'trailing' && trailing && action('trailing', trailing)}
      {React.cloneElement(children, {
        ref: content,
        onPointerDown,
        onPointerMove,
        onPointerUp: (e) => end(e, false),
        onPointerCancel: (e) => end(e, true),
        onClickCapture,
      })}
    </div>
  );
}
