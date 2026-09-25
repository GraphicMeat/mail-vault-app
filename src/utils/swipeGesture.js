// Two-finger trackpad swipes on a message row, as a pure reducer over wheel
// samples. WKWebView, WebView2 and WebKitGTK all deliver the gesture as
// `wheel` events with a deltaX and no phase, so "released" can only mean "no
// wheel event for a while": the caller's timer sends `release` after
// SWIPE_RELEASE_MS of silence, and `quiet` after SWIPE_QUIET_MS while the
// macOS momentum tail after a swipe is being swallowed.
//
// Phases: idle -> pending (not sure yet) -> tracking (horizontal, the event is
// ours) or passthrough (a scroll, never touched) -> swallow -> idle.

export const SWIPE_RELEASE_MS = 150;
export const SWIPE_QUIET_MS = 250;
export const SWIPE_THRESHOLD_PX = 120;
const LOCK_RATIO = 1.5;
const LOCK_MIN_PX = 4;
const LOCK_SAMPLES = 3;
const RUBBER = 0.3;

export const idleSwipe = Object.freeze({
  phase: 'idle', sumX: 0, sumY: 0, samples: 0, raw: 0, offset: 0, side: null, preventDefault: false, outcome: null,
});

/** How far a row must travel to commit: 35% of it, at most 120px. */
export function swipeThreshold(width) {
  return width > 0 ? Math.min(SWIPE_THRESHOLD_PX, width * 0.35) : SWIPE_THRESHOLD_PX;
}

function track(state, raw, threshold) {
  const abs = Math.abs(raw);
  return {
    ...state,
    phase: 'tracking',
    raw,
    // Past the threshold the row keeps moving, only slower: the commit point is felt.
    offset: abs <= threshold ? raw : Math.sign(raw) * (threshold + (abs - threshold) * RUBBER),
    side: raw < 0 ? 'left' : raw > 0 ? 'right' : state.side,
    preventDefault: true,
    outcome: null,
  };
}

/**
 * One step. `input` is `{type:'wheel', deltaX, deltaY}`, `{type:'release'}`
 * or `{type:'quiet'}`. The result carries `preventDefault` for the wheel
 * event and `outcome` ('commit' | 'cancel') on the step that ends a swipe.
 */
export function swipeStep(state, input, { width = 0 } = {}) {
  const threshold = swipeThreshold(width);
  const quiet = { preventDefault: false, outcome: null };
  if (input.type === 'quiet') return { ...idleSwipe };
  if (input.type === 'release') {
    if (state.phase === 'tracking') {
      return { ...idleSwipe, phase: 'swallow', side: state.side, outcome: Math.abs(state.raw) >= threshold ? 'commit' : 'cancel' };
    }
    return state.phase === 'swallow' ? { ...state, ...quiet } : { ...idleSwipe };
  }

  const deltaX = input.deltaX || 0;
  const deltaY = input.deltaY || 0;
  if (state.phase === 'swallow') return { ...state, preventDefault: true, outcome: null };
  if (state.phase === 'passthrough') return { ...state, ...quiet };
  // The row follows the fingers: fingers left scroll right (deltaX > 0).
  if (state.phase === 'tracking') return track(state, state.raw - deltaX, threshold);

  const sumX = state.sumX + deltaX;
  const sumY = state.sumY + deltaY;
  const samples = state.samples + 1;
  if (Math.abs(sumX) >= LOCK_MIN_PX && Math.abs(sumX) > Math.abs(sumY) * LOCK_RATIO) {
    return track({ ...state, sumX, sumY, samples }, -sumX, threshold);
  }
  if (Math.abs(sumY) > Math.abs(sumX) || samples >= LOCK_SAMPLES) return { ...idleSwipe, phase: 'passthrough' };
  return { ...state, phase: 'pending', sumX, sumY, samples, ...quiet };
}
