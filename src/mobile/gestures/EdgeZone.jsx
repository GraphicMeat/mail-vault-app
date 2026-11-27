// The leading-edge swipe (the first 20px). A touch that starts there is the interactive back of
// iOS: the top back layer follows the finger (its transform is written straight to the element,
// no render per move) and, let go past a third of the width or in a flick, leaves through
// `popTopLayer` (backStack.js), the same path as System Back, so Compose asks to save its draft
// exactly as its Cancel does. Let go short, it springs back. The layer is the one Back would
// close (`topLayerElement`: the topmost layer that has an element), not the last dialog in the document. With no full-screen layer open
// the same swipe pulls the folder drawer out under the finger: `onOpenDrawer` mounts it (without
// its entrance animation) when the swipe is claimed, it follows the finger and either stays out
// or goes back (`onCloseDrawer`). Neither commit ticks a haptic.
// There is no strip over the page: the swipe listens on the document (passive, capture) for a
// touch that starts in the edge zone, and claims it only after horizontal movement, so a tap in
// the left 20px (the menu button, a row, a checkbox) reaches what is under it. A touch that starts
// on a sheet or the drawer is theirs. A row swipe or the viewer's prev/next never claims a touch
// that starts in the zone (they check `inEdgeZone` themselves).
import { useEffect, useRef } from 'react';
import { popTopLayer, topLayerElement } from '../backStack.js';
import { backOutcome, createAxisLock, createVelocityTracker, inEdgeZone } from './recognizers.js';
import { isRtl, settle } from './motion.js';

/** How long a committed layer is given to unmount before it is brought back (it stayed: a Compose ask). */
const STAY_CHECK_MS = 160;
/** The click a claimed drag can still produce is not a tap: swallowed for this long. */
const CLICK_SWALLOW_MS = 350;
const DRAWER = '.mv-overlay--drawer';

export default function EdgeZone({ onOpenDrawer, onCloseDrawer }) {
  const open = useRef(onOpenDrawer);
  open.current = onOpenDrawer;
  const close = useRef(onCloseDrawer);
  close.current = onCloseDrawer;

  useEffect(() => {
    let g = null;
    let swallowUntil = 0;

    const down = (e) => {
      if (g || e.button > 0 || e.isPrimary === false) return;
      if (e.target?.closest?.('.mv-overlay')) return;
      const rtl = isRtl();
      if (!inEdgeZone(e.clientX, window.innerWidth, rtl)) return;
      const layer = topLayerElement();
      if (!layer && !open.current) return;
      const lock = createAxisLock();
      lock.down(e.clientX, e.clientY);
      g = {
        id: e.pointerId, x0: e.clientX, layer, rtl, lock, vel: createVelocityTracker(), dx: 0, claimed: false,
        drawer: null, backdrop: null,
        size: (layer && layer.getBoundingClientRect().width) || window.innerWidth,
      };
    };

    const placeDrawer = (s) => {
      const shown = Math.min(s.dx, s.size);
      s.drawer.style.transition = 'none';
      s.drawer.style.transform = `translate3d(${(s.rtl ? 1 : -1) * (s.size - shown)}px, 0, 0)`;
      if (s.backdrop) {
        s.backdrop.style.transition = 'none';
        s.backdrop.style.opacity = String(shown / s.size);
      }
    };

    const move = (e) => {
      if (!g || e.pointerId !== g.id) return;
      const axis = g.lock.move(e.clientX, e.clientY);
      if (axis === 'y') { g = null; return; }
      if (axis !== 'x') return;
      const dx = Math.max(0, (g.rtl ? -1 : 1) * (e.clientX - g.x0));
      if (!g.claimed) {
        // The first move that is horizontal claims the swipe, and only then does anything change.
        g.claimed = true;
        if (!g.layer) {
          open.current?.();
          g.drawer = document.querySelector(`${DRAWER} .mv-drawer`);
          g.backdrop = document.querySelector(`${DRAWER} .mv-overlay__backdrop`);
          if (g.drawer) g.size = g.drawer.getBoundingClientRect().width || g.size;
        }
      }
      g.dx = dx;
      g.vel.add(dx);
      if (g.layer) {
        g.layer.style.transition = 'none';
        g.layer.style.transform = `translate3d(${g.rtl ? -dx : dx}px, 0, 0)`;
      } else if (g.drawer) {
        placeDrawer(g);
      }
    };

    const endDrawer = (s, commit) => {
      const { drawer, backdrop } = s;
      if (backdrop) {
        backdrop.style.transition = 'opacity 0.2s ease';
        backdrop.style.opacity = commit ? '' : '0';
      }
      if (commit) {
        settle(drawer, '');
        return;
      }
      settle(drawer, `translate3d(${(s.rtl ? 1 : -1) * s.size}px, 0, 0)`, () => close.current?.());
    };

    const end = (e, cancelled) => {
      const s = g;
      g = null;
      if (!s || (e && e.pointerId !== s.id) || !s.claimed) return;
      swallowUntil = Date.now() + CLICK_SWALLOW_MS;
      const commit = !cancelled && backOutcome({ dx: s.dx, width: s.size, velocity: s.vel.velocity() }) === 'commit';
      const { layer } = s;
      if (!layer) {
        if (s.drawer) endDrawer(s, commit);
        else if (!commit) close.current?.();
        return;
      }
      if (!commit) {
        settle(layer, '');
        return;
      }
      settle(layer, `translate3d(${s.rtl ? -s.size : s.size}px, 0, 0)`, () => {
        popTopLayer();
        // A layer that stays (Compose asking to save, a settings page giving way to its root) comes back.
        setTimeout(() => { if (layer.isConnected) settle(layer, ''); }, STAY_CHECK_MS);
      });
    };

    const click = (e) => {
      if (Date.now() >= swallowUntil) return;
      e.stopPropagation();
      e.preventDefault();
    };
    const up = (e) => end(e, false);
    const cancel = (e) => end(e, true);
    const opts = { passive: true, capture: true };
    document.addEventListener('pointerdown', down, opts);
    document.addEventListener('pointermove', move, opts);
    document.addEventListener('pointerup', up, opts);
    document.addEventListener('pointercancel', cancel, opts);
    document.addEventListener('click', click, true);
    return () => {
      document.removeEventListener('pointerdown', down, opts);
      document.removeEventListener('pointermove', move, opts);
      document.removeEventListener('pointerup', up, opts);
      document.removeEventListener('pointercancel', cancel, opts);
      document.removeEventListener('click', click, true);
    };
  }, []);

  return null;
}
