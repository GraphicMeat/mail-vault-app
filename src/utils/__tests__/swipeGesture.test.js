import { describe, it, expect } from 'vitest';
import { idleSwipe, swipeStep, swipeThreshold, SWIPE_THRESHOLD_PX } from '../swipeGesture';

// Two-finger trackpad swipes arrive as wheel events. Fingers moving left
// scroll right (deltaX > 0), and the row follows the fingers.
const WIDE = { width: 1000 };

function run(samples, opts = WIDE) {
  let state = idleSwipe;
  const steps = [];
  for (const sample of samples) {
    state = swipeStep(state, sample.type ? sample : { type: 'wheel', deltaX: 0, deltaY: 0, ...sample }, opts);
    steps.push(state);
  }
  return { state, steps };
}
const left = (px, n = 10) => Array.from({ length: n }, () => ({ deltaX: px / n }));
const right = (px, n = 10) => Array.from({ length: n }, () => ({ deltaX: -px / n }));

describe('swipeStep', () => {
  it('locks onto a clearly horizontal gesture and only then takes the event', () => {
    const { steps } = run([{ deltaX: 2 }, { deltaX: 10, deltaY: 1 }, { deltaX: 12 }]);
    expect(steps[0].phase).not.toBe('tracking');
    expect(steps[0].preventDefault).toBe(false);
    expect(steps[1].phase).toBe('tracking');
    expect(steps[1].preventDefault).toBe(true);
    expect(steps[2].side).toBe('left');
  });

  it('lets a vertical scroll through untouched, all the way', () => {
    const { steps } = run([{ deltaY: 12 }, { deltaY: 20, deltaX: 30 }, { deltaY: 40 }]);
    expect(steps.every(s => s.preventDefault === false)).toBe(true);
    expect(steps.every(s => s.phase !== 'tracking')).toBe(true);
    expect(steps.at(-1).offset).toBe(0);
  });

  it('does not lock a diagonal gesture that is not clearly horizontal', () => {
    const { state } = run([{ deltaX: 10, deltaY: 8 }, { deltaX: 10, deltaY: 8 }, { deltaX: 10, deltaY: 8 }]);
    expect(state.phase).not.toBe('tracking');
    expect(state.preventDefault).toBe(false);
  });

  it('commits a swipe released past the threshold', () => {
    const { state } = run([...left(150), { type: 'release' }]);
    expect(state.outcome).toBe('commit');
    expect(state.side).toBe('left');
  });

  it('cancels a swipe released short of the threshold', () => {
    const { state } = run([...right(60), { type: 'release' }]);
    expect(state.outcome).toBe('cancel');
    expect(state.side).toBe('right');
  });

  it('follows the fingers when they turn back, and commits the side it ends on', () => {
    const { steps, state } = run([...left(80), ...right(240), { type: 'release' }]);
    expect(steps[9].side).toBe('left');
    expect(state.side).toBe('right');
    expect(state.outcome).toBe('commit');
  });

  it('rubber-bands the row past the threshold', () => {
    const { state } = run(left(400));
    expect(state.offset).toBeLessThan(0);
    expect(Math.abs(state.offset)).toBeGreaterThan(SWIPE_THRESHOLD_PX);
    expect(Math.abs(state.offset)).toBeLessThan(400);
  });

  it('swallows the momentum after a commit until a quiet gap, then starts fresh', () => {
    const { state: afterCommit } = run([...left(150), { type: 'release' }]);
    let state = afterCommit;
    for (const deltaX of [30, 20, 10, 5]) {
      state = swipeStep(state, { type: 'wheel', deltaX, deltaY: 0 }, WIDE);
      expect(state.preventDefault).toBe(true);
      expect(state.outcome).toBeFalsy();
      expect(state.phase).toBe('swallow');
    }
    state = swipeStep(state, { type: 'release' }, WIDE);
    expect(state.phase).toBe('swallow');
    state = swipeStep(state, { type: 'quiet' }, WIDE);
    expect(state.phase).toBe('idle');
    state = swipeStep(state, { type: 'wheel', deltaX: 20, deltaY: 0 }, WIDE);
    expect(state.phase).toBe('tracking');
  });

  it('uses 35% of a narrow row as the threshold, 120px otherwise', () => {
    expect(swipeThreshold(200)).toBe(70);
    expect(swipeThreshold(1000)).toBe(SWIPE_THRESHOLD_PX);
    const { state } = run([...left(80), { type: 'release' }], { width: 200 });
    expect(state.outcome).toBe('commit');
  });
});
