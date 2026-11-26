// Long press on an element (350ms, 10px slop): `onFire({ x, y })` once while the finger rests.
// Lifting, moving past the slop in either axis (a row swipe, a drag) or a scroll cancels it, so it
// never fights SwipeRow or the list's scroll. Passive listeners only. The quick action wheel uses it.
import { useEffect, useRef } from 'react';
import { createLongPress } from './recognizers.js';

export function useLongPress(ref, { onFire, enabled = true }) {
  const fire = useRef(onFire);
  fire.current = onFire;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;
    const press = createLongPress({ onFire: (p) => fire.current(p) });
    let id = null;
    const down = (e) => {
      if (e.button > 0 || e.isPrimary === false) return;
      id = e.pointerId;
      press.down(e.clientX, e.clientY);
    };
    const move = (e) => { if (e.pointerId === id) press.move(e.clientX, e.clientY); };
    const stop = () => { id = null; press.cancel(); };
    const opts = { passive: true };
    el.addEventListener('pointerdown', down, opts);
    el.addEventListener('pointermove', move, opts);
    el.addEventListener('pointerup', stop, opts);
    el.addEventListener('pointercancel', stop, opts);
    const scrollOpts = { passive: true, capture: true };
    el.addEventListener('scroll', stop, scrollOpts);
    return () => {
      press.cancel();
      el.removeEventListener('pointerdown', down, opts);
      el.removeEventListener('pointermove', move, opts);
      el.removeEventListener('pointerup', stop, opts);
      el.removeEventListener('pointercancel', stop, opts);
      el.removeEventListener('scroll', stop, scrollOpts);
    };
  }, [ref, enabled]);
}
