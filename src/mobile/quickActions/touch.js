// A finger on desktop's wheel. A wedge lights and names itself on hover, and a touch never
// hovers: its pointer stays with the element it started on. So the wheel host follows the finger
// itself: it finds the wedge under it (`wedgeAt`), and tells desktop's wheel what a pointer
// entering and leaving would, by dispatching the mouse events React turns into onMouseEnter and
// onMouseLeave (`hotWedge`), so the centre label, the category arcs and their hover intent behave
// exactly as with a mouse. `data-hot` is the lit look (quick-actions.css), set by hand.

/** The wedge (or arc item) under a point, or null. A wedge's clip-path is its hit area. */
export function wedgeAt(x, y, doc = document) {
  const el = doc.elementFromPoint ? doc.elementFromPoint(x, y) : null;
  return el && el.closest ? el.closest('.quick-action-radial-item') : null;
}

/** Moves the hot wedge from `prev` to `next` (either may be null); returns `next`. */
export function hotWedge(prev, next) {
  if (prev === next) return next;
  if (prev) prev.removeAttribute('data-hot');
  if (next) next.setAttribute('data-hot', '');
  const MouseEventCtor = (prev || next).ownerDocument.defaultView.MouseEvent;
  // React derives enter and leave from mouseout (its relatedTarget is where the pointer went) and
  // from a mouseover that comes from nowhere.
  if (prev) prev.dispatchEvent(new MouseEventCtor('mouseout', { bubbles: true, relatedTarget: next }));
  else next.dispatchEvent(new MouseEventCtor('mouseover', { bubbles: true, relatedTarget: null }));
  return next;
}

/** How long after a hold lets go the click the browser follows it with is still the hold's. */
export const CLICK_SHADOW_MS = 700;

/**
 * Swallows the click that follows a finger lifting off a row it held (the browser sends it to the
 * row, which would open the message), once, for `CLICK_SHADOW_MS`. Outlives the wheel, which may
 * already be gone when the click arrives.
 */
export function shadowNextRowClick(win = window, ms = CLICK_SHADOW_MS) {
  const until = Date.now() + ms;
  const done = () => {
    win.removeEventListener('click', onClick, true);
    clearTimeout(timer);
  };
  const onClick = (e) => {
    if (Date.now() >= until) { done(); return; }
    if (e.target && e.target.closest && e.target.closest('.mv-row-slot')) {
      e.stopPropagation();
      e.preventDefault();
      done();
    }
  };
  const timer = setTimeout(done, ms);
  win.addEventListener('click', onClick, true);
  return done;
}
