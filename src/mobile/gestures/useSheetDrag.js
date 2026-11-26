// Dragging a panel away. A bottom sheet goes down: grab its grip, its title, or anything in its top
// 48px (`[data-mv-sheet-handle]` marks another handle); it follows the finger, the backdrop fades
// with it, and let go past 30% of its height or in a downward flick it closes (`onClose`), else it
// springs back. The folder drawer goes to its edge: a horizontal drag anywhere on it, the same
// 30% or a flick. A drag that starts in a sheet's body is its own scroll or tap. Transforms are
// written to the element, no render per move.
import { useEffect, useRef } from 'react';
import { createAxisLock, createVelocityTracker, sheetOutcome } from './recognizers.js';
import { isRtl, settle } from './motion.js';

const HANDLE = '.mv-sheet__grip, .mv-sheet__title, [data-mv-sheet-handle]';
const HANDLE_STRIP = 48;

export function useSheetDrag(panelRef, { kind, onClose }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const backdrop = panel.parentElement?.querySelector('.mv-overlay__backdrop') || null;
    const drawer = kind === 'drawer';
    const rtl = isRtl();
    let g = null;
    let swallow = false;

    const place = (d) => {
      panel.style.transition = 'none';
      panel.style.transform = drawer ? `translate3d(${d * (rtl ? 1 : -1)}px, 0, 0)` : `translate3d(0, ${d}px, 0)`;
      if (backdrop) {
        backdrop.style.transition = 'none';
        backdrop.style.opacity = String(Math.max(0, 1 - d / g.size));
      }
    };

    const down = (e) => {
      if (e.button > 0 || e.isPrimary === false) return;
      const box = panel.getBoundingClientRect();
      if (!drawer) {
        const onHandle = e.target?.closest?.(HANDLE) && panel.contains(e.target);
        if (!onHandle && e.clientY - box.top > HANDLE_STRIP) return;
      }
      const lock = createAxisLock();
      lock.down(e.clientX, e.clientY);
      g = {
        id: e.pointerId, x0: e.clientX, y0: e.clientY, lock, vel: createVelocityTracker(), d: 0, claimed: false,
        size: (drawer ? box.width : box.height) || 1,
      };
    };

    const move = (e) => {
      if (!g || e.pointerId !== g.id) return;
      const axis = g.lock.move(e.clientX, e.clientY);
      if (!axis) return;
      if (axis !== (drawer ? 'x' : 'y')) { if (!g.claimed) g = null; return; }
      const raw = drawer ? (rtl ? e.clientX - g.x0 : g.x0 - e.clientX) : e.clientY - g.y0;
      // A drag the wrong way (a sheet up, a drawer toward the content) claims nothing.
      if (!g.claimed && raw <= 0) { g = null; return; }
      if (!g.claimed) {
        g.claimed = true;
        try { panel.setPointerCapture?.(e.pointerId); } catch { /* not capturable: fine */ }
      }
      g.d = Math.max(0, raw);
      g.vel.add(g.d);
      place(g.d);
    };

    const end = (e, cancelled) => {
      const s = g;
      g = null;
      if (!s || (e && e.pointerId !== s.id) || !s.claimed) return;
      swallow = true; // the click that follows a drag is not a tap
      setTimeout(() => { swallow = false; }, 0);
      const commit = !cancelled && sheetOutcome({ dy: s.d, height: s.size, velocity: s.vel.velocity() }) === 'commit';
      if (backdrop) {
        backdrop.style.transition = 'opacity 0.2s ease';
        backdrop.style.opacity = commit ? '0' : '';
      }
      if (!commit) {
        settle(panel, '');
        return;
      }
      const away = drawer ? `translate3d(${(rtl ? 1 : -1) * s.size}px, 0, 0)` : `translate3d(0, ${s.size}px, 0)`;
      settle(panel, away, () => close.current());
    };

    const click = (e) => {
      if (!swallow) return;
      e.stopPropagation();
      e.preventDefault();
    };

    const opts = { passive: true };
    const up = (e) => end(e, false);
    const cancel = (e) => end(e, true);
    panel.addEventListener('pointerdown', down, opts);
    panel.addEventListener('pointermove', move, opts);
    panel.addEventListener('pointerup', up, opts);
    panel.addEventListener('pointercancel', cancel, opts);
    panel.addEventListener('click', click, true);
    return () => {
      panel.removeEventListener('pointerdown', down, opts);
      panel.removeEventListener('pointermove', move, opts);
      panel.removeEventListener('pointerup', up, opts);
      panel.removeEventListener('pointercancel', cancel, opts);
      panel.removeEventListener('click', click, true);
    };
  }, [panelRef, kind]);
}
