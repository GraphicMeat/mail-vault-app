// Animation shims for the E2E build — never compiled into a normal build.
//
// The headless E2E runner has no display, so macOS marks the app window
// occluded and `document.visibilityState` stays 'hidden' for the whole run.
// WKWebView then stops requestAnimationFrame (a 1s counter reports 0 ticks) and
// freezes the WAAPI document timeline. Both of framer-motion's animation paths
// stall: values sit on their first frame — modals stuck at `opacity: 0` — and
// AnimatePresence never unmounts an exiting child, so dismissed bars and closed
// compose windows pile up in the DOM. Specs then read a zombie node and fail on
// a UI that actually worked.
//
// `VITE_E2E` is a compile-time constant, so a normal build drops this file and
// keeps the real animations.
if (import.meta.env.VITE_E2E === '1' && typeof window !== 'undefined') {
  // Timers still fire in a hidden window, and motion advances by elapsed time,
  // so a coarse tick lands every frame-locked animation on its end state. This
  // has to run before framer-motion's module init: it captures
  // requestAnimationFrame once, in frameloop/frame.mjs. Hence a plain script
  // body here and a dynamic import below — and this module imported first in
  // main.jsx, since static imports evaluate before the importer's own body.
  const nativeRequest = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  // rAF and setTimeout hand out ids from separate spaces, so remember which
  // ids are ours instead of guessing in cancelAnimationFrame.
  const timerIds = new Set();

  window.requestAnimationFrame = (callback) => {
    if (document.visibilityState !== 'hidden') return nativeRequest(callback);
    const id = setTimeout(() => {
      timerIds.delete(id);
      callback(performance.now());
    }, 16);
    timerIds.add(id);
    return id;
  };

  window.cancelAnimationFrame = (id) => {
    if (timerIds.has(id)) {
      timerIds.delete(id);
      clearTimeout(id);
      return;
    }
    nativeCancel(id);
  };

  // Timers alone don't cover opacity: motion runs it through WAAPI, whose
  // document timeline is frozen while hidden, so transforms completed and
  // opacity stayed at 0. skipAnimations resolves every value instantly on the
  // JS path instead — the switch framer-motion documents for tests.
  import('framer-motion')
    .then(({ MotionGlobalConfig }) => { MotionGlobalConfig.skipAnimations = true; })
    .catch((e) => console.error('[e2eMotion] could not disable animations', e));
}
