// The leading-edge strip (20px wide, above every full-screen layer and under the sheets). A
// swipe that starts here is the interactive back of iOS: the top full-screen layer follows the
// finger (its transform is written straight to the element, no render per move) and, let go past
// a third of the width or in a flick, leaves through `popTopLayer` (backStack.js), the same
// path as System Back, so Compose asks to save its draft exactly as its Cancel does. Let go
// short, it springs back. With no full-screen layer open the same swipe opens the folder
// drawer (`onOpenDrawer`). Because the strip is on top, a row swipe or the viewer's prev/next
// never sees a touch that starts in it. Neither commit ticks a haptic.
import React, { useEffect, useRef } from 'react';
import { popTopLayer } from '../backStack.js';
import { backOutcome, createAxisLock, createVelocityTracker } from './recognizers.js';
import { isRtl, settle } from './motion.js';

const LAYERS = 'section[role="dialog"][aria-modal="true"]';
/** How long a committed layer is given to unmount before it is brought back (it stayed: a Compose ask). */
const STAY_CHECK_MS = 160;

/** The full-screen layer in front: the last one in the document that is not inside a sheet. */
export function topLayer() {
  const all = [...document.querySelectorAll(LAYERS)].filter((n) => !n.closest('.mv-overlay'));
  return all[all.length - 1] || null;
}

export default function EdgeZone({ onOpenDrawer }) {
  const zone = useRef(null);
  const drawer = useRef(onOpenDrawer);
  drawer.current = onOpenDrawer;

  useEffect(() => {
    const el = zone.current;
    if (!el) return undefined;
    let g = null;

    const down = (e) => {
      if (e.button > 0 || e.isPrimary === false) return;
      const layer = topLayer();
      if (!layer && !drawer.current) return;
      const rtl = isRtl();
      const lock = createAxisLock();
      lock.down(e.clientX, e.clientY);
      const vel = createVelocityTracker();
      g = {
        id: e.pointerId, x0: e.clientX, layer, rtl, lock, vel, dx: 0, claimed: false,
        width: (layer && layer.getBoundingClientRect().width) || window.innerWidth,
      };
      try { el.setPointerCapture?.(e.pointerId); } catch { /* not capturable: fine */ }
    };

    const move = (e) => {
      if (!g || e.pointerId !== g.id) return;
      const axis = g.lock.move(e.clientX, e.clientY);
      if (axis === 'y') { g = null; return; }
      if (axis !== 'x') return;
      g.claimed = true;
      const dx = Math.max(0, (g.rtl ? -1 : 1) * (e.clientX - g.x0));
      g.dx = dx;
      g.vel.add(dx);
      if (g.layer) {
        g.layer.style.transition = 'none';
        g.layer.style.transform = `translate3d(${g.rtl ? -dx : dx}px, 0, 0)`;
      }
    };

    const end = (e, cancelled) => {
      const s = g;
      g = null;
      if (!s || (e && e.pointerId !== s.id) || !s.claimed) return;
      const commit = !cancelled && backOutcome({ dx: s.dx, width: s.width, velocity: s.vel.velocity() }) === 'commit';
      const { layer } = s;
      if (!layer) {
        if (commit) drawer.current?.();
        return;
      }
      if (!commit) {
        settle(layer, '');
        return;
      }
      settle(layer, `translate3d(${s.rtl ? -s.width : s.width}px, 0, 0)`, () => {
        popTopLayer();
        // A layer that stays (Compose asking to save, a settings page giving way to its root) comes back.
        setTimeout(() => { if (layer.isConnected) settle(layer, ''); }, STAY_CHECK_MS);
      });
    };

    const opts = { passive: true };
    const up = (e) => end(e, false);
    const cancel = (e) => end(e, true);
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
  }, []);

  return <div ref={zone} className="mv-edge" data-mv-edge aria-hidden="true" />;
}
