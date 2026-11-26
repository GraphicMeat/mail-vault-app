// The viewer's header swipe: left for the next message, right for the previous (flipped in a
// right-to-left layout), 60px or a flick. `onStep('next' | 'prev')` is called once on release,
// with a selection tick. It never claims a touch that starts in the edge zone (that is back),
// inside horizontally scrollable content, or that turns out vertical (the header's own scroll).
// The mail frame is an iframe and sees none of this, so its text selection and wide tables keep
// their touches.
import { useEffect, useRef } from 'react';
import { haptic } from '../haptics.js';
import { createAxisLock, createVelocityTracker, findScrollableX, inEdgeZone, stepOutcome } from './recognizers.js';
import { isRtl } from './motion.js';

export function useStepSwipe(ref, { onStep, enabled = true }) {
  const step = useRef(onStep);
  step.current = onStep;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;
    let g = null;

    const down = (e) => {
      if (e.button > 0 || e.isPrimary === false) return;
      const rtl = isRtl();
      if (inEdgeZone(e.clientX, window.innerWidth, rtl)) return;
      if (findScrollableX(e.target, el)) return;
      const lock = createAxisLock();
      lock.down(e.clientX, e.clientY);
      g = { id: e.pointerId, x0: e.clientX, dx: 0, lock, vel: createVelocityTracker(), rtl, claimed: false };
    };
    const move = (e) => {
      if (!g || e.pointerId !== g.id) return;
      const axis = g.lock.move(e.clientX, e.clientY);
      if (axis === 'y') { g = null; return; }
      if (axis !== 'x') return;
      g.claimed = true;
      g.dx = e.clientX - g.x0;
      g.vel.add(g.dx);
    };
    const up = (e) => {
      const s = g;
      g = null;
      if (!s || e.pointerId !== s.id || !s.claimed) return;
      const dir = stepOutcome({ dx: s.dx, velocity: s.vel.velocity(), rtl: s.rtl });
      if (!dir) return;
      haptic.selection();
      step.current(dir);
    };
    const cancel = () => { g = null; };

    const opts = { passive: true };
    el.addEventListener('pointerdown', down, opts);
    el.addEventListener('pointermove', move, opts);
    el.addEventListener('pointerup', up, opts);
    el.addEventListener('pointercancel', cancel, opts);
    return () => {
      el.removeEventListener('pointerdown', down, opts);
      el.removeEventListener('pointermove', move, opts);
      el.removeEventListener('pointerup', up, opts);
      el.removeEventListener('pointercancel', cancel, opts);
    };
  }, [ref, enabled]);
}
