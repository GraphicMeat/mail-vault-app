// The viewer's prev/next as a slide instead of a hard swap. `slide('next' | 'prev')` moves the
// message on screen out toward the swipe (the next message leaves to the left, the previous to the
// right; flipped in a right-to-left layout), then runs `onStep(dir)`: it answers whether there was
// a message to go to (false: the one on screen slides back). The viewer for the message that
// follows is a fresh mount (the app keys it by message), which finds the direction left here and
// slides in from the side it was sent, once. Reduced motion steps at once, with nothing animated.
// Transforms are written to the element, no render per move.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { isRtl, reducedMotion, settle } from './motion.js';

/** The ms a step's slide takes: short, a step is a quick gesture. */
const STEP_MS = 140;
/** A direction left for a mount that never came is stale after this long. */
const STALE_MS = 2000;

let pending = null; // { dir, rtl, at }

const take = () => {
  const p = pending;
  pending = null;
  return p && Date.now() - p.at < STALE_MS ? p : null;
};

/** Where the old message goes for `dir`: the next one leaves to the left (to the right in RTL). */
const away = (dir, rtl) => ((dir === 'next') !== rtl ? -100 : 100);

export function useStepSlide(rootRef, { onStep }) {
  const step = useRef(onStep);
  step.current = onStep;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // A message that was stepped to comes in from the side it was sent.
  useLayoutEffect(() => {
    const p = take();
    const el = rootRef.current;
    if (!p || !el) return;
    el.style.transition = 'none';
    el.style.transform = `translate3d(${-away(p.dir, p.rtl)}%, 0, 0)`;
    if (!reducedMotion()) el.getBoundingClientRect(); // the start is committed before it moves
    settle(el, '', undefined, STEP_MS);
  }, [rootRef]);

  return (dir) => {
    const el = rootRef.current;
    const rtl = isRtl();
    const run = () => {
      pending = { dir, rtl, at: Date.now() };
      const went = step.current?.(dir);
      if (went === false) {
        pending = null;
        if (mounted.current) settle(el, '', undefined, STEP_MS);
      }
    };
    if (!el) { run(); return; }
    settle(el, `translate3d(${away(dir, rtl)}%, 0, 0)`, run, STEP_MS);
  };
}
