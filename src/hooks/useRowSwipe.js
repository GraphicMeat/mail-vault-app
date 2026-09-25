import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { idleSwipe, swipeStep, SWIPE_QUIET_MS, SWIPE_RELEASE_MS } from '../utils/swipeGesture';
import { runRowQuickAction } from '../utils/rowActionRegistry';

// A swipe option -> the row quick actions it runs, first allowed one wins.
// "star" toggles: star when anything is unstarred, else unstar.
const QUICK_ACTIONS = {
  archive: ['archive'], delete: ['delete'], toggleRead: ['toggleRead'],
  star: ['star', 'unstar'], snooze: ['snooze'], move: ['move'],
};

/**
 * Two-finger trackpad swipes on the rows of `containerRef` (see
 * utils/swipeGesture.js). One non-passive wheel listener on the container;
 * `resolveRow(eventTarget)` names the row under the pointer as
 * `{ index, row, wrapper }`. Only that row moves, by writing its transform
 * directly: nothing re-renders per wheel event. Returns the swipe to draw a
 * backdrop for, `{ index, side, action }`, which changes only when a swipe
 * locks, flips side or ends. A committed swipe runs the side's action through
 * the row's own quick actions, anchored to the (untranslated) wrapper.
 */
export function useRowSwipe(containerRef, { enabled, resolveRow }) {
  const [active, setActive] = useState(null);
  const left = useSettingsStore(s => s.swipeLeftAction);
  const right = useSettingsStore(s => s.swipeRightAction);
  const live = useRef(null);
  live.current = { resolveRow, left, right };

  useEffect(() => {
    const el = containerRef.current;
    if (!enabled || !el) return undefined;
    let state = idleSwipe;
    let target = null;
    let timer = null;
    let shown = null;
    const actionFor = side => (side === 'left' ? live.current.left : side === 'right' ? live.current.right : 'none');
    const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    const paint = (x, settle) => {
      const row = target?.row;
      if (!row) return;
      row.style.transition = settle && !reduced() ? 'transform 180ms ease-out' : 'none';
      row.style.transform = x ? `translateX(${x}px)` : '';
    };
    // A read row has no ground of its own and a marked one is a tint, so the
    // backdrop would show through the row itself. While it moves it gets the
    // list's own colour underneath whatever it paints.
    const clear = c => !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
    const lift = (row) => {
      let base = null;
      for (let n = row.parentElement; n && !base; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (!clear(c)) base = c;
      }
      const own = getComputedStyle(row).backgroundColor;
      row.style.backgroundColor = base || 'var(--mail-bg)';
      if (!clear(own)) row.style.backgroundImage = `linear-gradient(${own}, ${own})`;
    };
    const drop = (row) => {
      row.style.backgroundColor = '';
      row.style.backgroundImage = '';
    };
    const show = (side) => {
      const key = side && target ? `${target.index}:${side}` : null;
      if (key === shown) return;
      shown = key;
      setActive(key ? { index: target.index, side, action: actionFor(side) } : null);
    };

    const apply = (next) => {
      if (next.phase === 'tracking' && state.phase !== 'tracking') lift(target.row);
      state = next;
      if (next.phase === 'tracking') {
        const moving = actionFor(next.side) !== 'none';
        paint(moving ? next.offset : 0, false);
        show(moving ? next.side : null);
      }
      if (next.outcome) {
        const action = actionFor(next.side);
        paint(0, true);
        show(null);
        drop(target.row);
        if (next.outcome === 'commit' && QUICK_ACTIONS[action]) {
          runRowQuickAction(target.row, QUICK_ACTIONS[action], target.wrapper || target.row);
        }
      }
      if (next.phase === 'idle') target = null;
    };

    const arm = () => {
      clearTimeout(timer);
      const swallowing = state.phase === 'swallow';
      timer = setTimeout(() => {
        apply(swipeStep(state, { type: swallowing ? 'quiet' : 'release' }, { width: target?.row?.offsetWidth }));
        if (state.phase !== 'idle') arm();
      }, swallowing ? SWIPE_QUIET_MS : SWIPE_RELEASE_MS);
    };

    const onWheel = (e) => {
      if (e.ctrlKey) return; // pinch-zoom arrives as a ctrl+wheel
      if (state.phase === 'idle') {
        target = live.current.resolveRow(e.target);
        if (!target) return;
      }
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      apply(swipeStep(state, { type: 'wheel', deltaX: e.deltaX * scale, deltaY: e.deltaY * scale }, { width: target?.row?.offsetWidth }));
      if (state.preventDefault) e.preventDefault();
      arm();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      clearTimeout(timer);
      paint(0, false);
      if (target?.row) drop(target.row);
      setActive(null);
    };
  }, [containerRef, enabled]);

  return active;
}
