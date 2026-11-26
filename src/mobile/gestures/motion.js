// Shared motion for the gesture hooks: whether to animate, and moving an element to a place with a
// short CSS transition (written to its style, off under reduced motion) that reports when it ends.
export const SETTLE_MS = 240;

export function reducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function isRtl() {
  return typeof document !== 'undefined' && typeof getComputedStyle === 'function'
    && getComputedStyle(document.documentElement).direction === 'rtl';
}

/** Puts `el` at `transform` (`''` is home) the way a finger let go: eased, or at once. `done` runs once. */
export function settle(el, transform, done) {
  if (!el) { done?.(); return; }
  if (reducedMotion()) {
    el.style.transition = 'none';
    el.style.transform = transform;
    done?.();
    return;
  }
  let finished = false;
  const end = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    el.removeEventListener('transitionend', onEnd);
    if (!transform) el.style.transition = '';
    done?.();
  };
  const onEnd = (e) => { if (e.target === el) end(); };
  const timer = setTimeout(end, SETTLE_MS + 60);
  el.addEventListener('transitionend', onEnd);
  el.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
  el.style.transform = transform;
}
