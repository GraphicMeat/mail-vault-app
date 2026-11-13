// Full-screen layers over the on-screen keyboard.
//
// iOS (WKWebView) keeps the layout viewport (innerHeight) when the keyboard shows: it shrinks the
// visual viewport (`resize`) and then pans it to the focused field (`scroll`, offsetTop > 0). A
// `position: fixed; inset: 0` layer sits on the layout viewport, so the pan pushes its top bar off
// the screen and its bottom stays under the keyboard. The layer is instead placed on the visual
// viewport itself: top = offsetTop, height = visual height (--mv-vv-top / --mv-vv-height, set only
// while the keyboard is up; the CSS falls back to the full screen). An Android WebView that resizes
// shrinks innerHeight along with the visual viewport, so it reads as "no keyboard" and keeps
// `inset: 0` on the already smaller window.
import { useEffect } from 'react';

// innerHeight minus the visual height below this is a toolbar or rounding, not a keyboard.
const KEYBOARD_MIN = 80;

/** The visible box of the screen, from `visualViewport` and `innerHeight` (CSS px). */
export function viewportBox({ innerHeight, height, offsetTop }) {
  return {
    top: Math.max(0, Math.round(offsetTop || 0)),
    height: Math.round(height),
    keyboard: innerHeight - height >= KEYBOARD_MIN,
  };
}

/**
 * How far to scroll a scroller (its visible `view` rect) so `target` shows with `margin` to spare:
 * > 0 scrolls down. A target taller than the view gets its top aligned.
 */
export function revealDelta(view, target, margin = 8) {
  const top = view.top + margin;
  const bottom = view.bottom - margin;
  if (target.top < top) return target.top - top;
  if (target.bottom > bottom) return Math.min(target.bottom - bottom, target.top - top);
  return 0;
}

/**
 * Keeps the `layer` element on the visible part of the screen while the keyboard is up, and the
 * focused field inside `scroller` in view. Only `scroller` scrolls: never the document.
 */
export function useKeyboardViewport(layer, scroller) {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const el = layer.current;
    if (!vv || !el) return undefined;
    const reveal = () => {
      const box = scroller.current;
      const focused = document.activeElement;
      if (!box || !focused || focused === box || !box.contains(focused)) return;
      const delta = revealDelta(box.getBoundingClientRect(), focused.getBoundingClientRect());
      if (delta) box.scrollTop += delta;
    };
    const update = () => {
      const { top, height, keyboard } = viewportBox({ innerHeight: window.innerHeight, height: vv.height, offsetTop: vv.offsetTop });
      if (keyboard) {
        el.style.setProperty('--mv-vv-top', `${top}px`);
        el.style.setProperty('--mv-vv-height', `${height}px`);
        el.setAttribute('data-mv-keyboard', '');
      } else {
        el.style.removeProperty('--mv-vv-top');
        el.style.removeProperty('--mv-vv-height');
        el.removeAttribute('data-mv-keyboard');
      }
      // The layers are fixed and the document has nothing to scroll; a scroll left over from the
      // keyboard pan is put back so it cannot add to the offset above.
      if (window.scrollY > 0) window.scrollTo(0, 0);
      reveal();
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    el.addEventListener('focusin', reveal);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      el.removeEventListener('focusin', reveal);
      el.style.removeProperty('--mv-vv-top');
      el.style.removeProperty('--mv-vv-height');
      el.removeAttribute('data-mv-keyboard');
    };
  }, [layer, scroller]);
}
