// The pure gesture logic (src/mobile/gestures/recognizers.js): thresholds, outcomes, the
// long-press timer, the axis lock. No DOM here beyond plain objects.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EDGE_ZONE, LONG_PRESS_MS, LONG_PRESS_SLOP,
  inEdgeZone, backOutcome, sheetOutcome, stepOutcome, createVelocityTracker, createAxisLock,
  createLongPress, findScrollableX, pullMayStart,
} from '../gestures/recognizers.js';
import { neighborRow } from '../gestures/neighbors.js';

afterEach(() => vi.useRealTimers());

describe('edge zone', () => {
  it('is the first 20px on the leading side', () => {
    expect(EDGE_ZONE).toBe(20);
    expect(inEdgeZone(0, 400)).toBe(true);
    expect(inEdgeZone(19, 400)).toBe(true);
    expect(inEdgeZone(20, 400)).toBe(false);
    expect(inEdgeZone(380, 400)).toBe(false);
  });
  it('mirrors in a right-to-left layout', () => {
    expect(inEdgeZone(381, 400, true)).toBe(true);
    expect(inEdgeZone(380, 400, true)).toBe(false);
    expect(inEdgeZone(5, 400, true)).toBe(false);
  });
});

describe('outcomes', () => {
  it('back commits past a third of the width, or on a flick, else cancels', () => {
    expect(backOutcome({ dx: 134, width: 400, velocity: 0 })).toBe('commit');
    expect(backOutcome({ dx: 120, width: 400, velocity: 0 })).toBe('cancel');
    expect(backOutcome({ dx: 40, width: 400, velocity: 0.8 })).toBe('commit');
    expect(backOutcome({ dx: 3, width: 400, velocity: 2 })).toBe('cancel');
    expect(backOutcome({ dx: -200, width: 400, velocity: -1 })).toBe('cancel');
  });
  it('a sheet dismisses past 30% of its height, or on a downward flick', () => {
    expect(sheetOutcome({ dy: 91, height: 300, velocity: 0 })).toBe('commit');
    expect(sheetOutcome({ dy: 80, height: 300, velocity: 0 })).toBe('cancel');
    expect(sheetOutcome({ dy: 30, height: 300, velocity: 0.7 })).toBe('commit');
    expect(sheetOutcome({ dy: -90, height: 300, velocity: 0 })).toBe('cancel');
  });
  it('a step needs 60px or a flick, left is next, and right-to-left flips it', () => {
    expect(stepOutcome({ dx: -70 })).toBe('next');
    expect(stepOutcome({ dx: 70 })).toBe('prev');
    expect(stepOutcome({ dx: -40 })).toBe(null);
    expect(stepOutcome({ dx: -25, velocity: -0.8 })).toBe('next');
    expect(stepOutcome({ dx: -70, rtl: true })).toBe('prev');
  });
});

describe('velocity tracker', () => {
  it('is px per ms over the recent samples, signed', () => {
    let t = 0;
    const v = createVelocityTracker(() => t);
    v.add(0); t = 50; v.add(30); t = 100; v.add(60);
    expect(v.velocity()).toBeCloseTo(0.6, 2);
    t = 150; v.add(30); t = 200; v.add(0);
    expect(v.velocity()).toBeLessThan(0);
  });
  it('is 0 with one sample or no time passing', () => {
    const v = createVelocityTracker(() => 5);
    v.add(10);
    expect(v.velocity()).toBe(0);
    v.add(50);
    expect(v.velocity()).toBe(0);
  });
});

describe('axis lock', () => {
  it('stays open inside the slop, then locks to the larger axis', () => {
    const a = createAxisLock(10);
    a.down(0, 0);
    expect(a.move(4, 4)).toBe(null);
    expect(a.move(14, 3)).toBe('x');
    expect(a.move(0, 90)).toBe('x');
    const b = createAxisLock(10);
    b.down(0, 0);
    expect(b.move(3, 14)).toBe('y');
  });
});

describe('long press', () => {
  const setup = () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    return { onFire, lp: createLongPress({ onFire }) };
  };
  it('fires once after 350ms with the start point', () => {
    expect(LONG_PRESS_MS).toBe(350);
    expect(LONG_PRESS_SLOP).toBe(10);
    const { onFire, lp } = setup();
    lp.down(50, 60);
    vi.advanceTimersByTime(349);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith({ x: 50, y: 60 });
    vi.advanceTimersByTime(1000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
  it('cancels when the finger lifts early', () => {
    const { onFire, lp } = setup();
    lp.down(0, 0); vi.advanceTimersByTime(200); lp.up(); vi.advanceTimersByTime(500);
    expect(onFire).not.toHaveBeenCalled();
  });
  it('cancels past 10px in either axis, not within it', () => {
    let r = setup();
    r.lp.down(0, 0); r.lp.move(8, -8); vi.advanceTimersByTime(400);
    expect(r.onFire).toHaveBeenCalledTimes(1);
    r = setup();
    r.lp.down(0, 0); r.lp.move(11, 0); vi.advanceTimersByTime(400);
    expect(r.onFire).not.toHaveBeenCalled();
    r = setup();
    r.lp.down(0, 0); r.lp.move(0, -11); vi.advanceTimersByTime(400);
    expect(r.onFire).not.toHaveBeenCalled();
  });
  it('cancels on scroll', () => {
    const { onFire, lp } = setup();
    lp.down(0, 0); vi.advanceTimersByTime(100); lp.scroll(); vi.advanceTimersByTime(500);
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe('pull-to-refresh start', () => {
  it('counts only from the very top with one finger', () => {
    expect(pullMayStart(0, 1)).toBe(true);
    expect(pullMayStart(-4, 1)).toBe(true);
    expect(pullMayStart(1, 1)).toBe(false);
    expect(pullMayStart(0, 2)).toBe(false);
  });
});

describe('findScrollableX', () => {
  const el = (over = {}) => ({ scrollWidth: 100, clientWidth: 100, parentElement: null, ...over });
  const style = (map) => (n) => ({ overflowX: map.get(n) || 'visible' });
  it('finds a wide auto or scroll ancestor below the root, and ignores the root itself', () => {
    const root = el();
    const wide = el({ scrollWidth: 300, parentElement: root });
    const leaf = el({ parentElement: wide });
    const map = new Map([[wide, 'auto'], [root, 'auto']]);
    expect(findScrollableX(leaf, root, style(map))).toBe(wide);
    expect(findScrollableX(root, root, style(map))).toBe(null);
  });
  it('skips an overflow-x:auto box that does not overflow', () => {
    const root = el();
    const narrow = el({ parentElement: root });
    expect(findScrollableX(narrow, root, style(new Map([[narrow, 'auto']])))).toBe(null);
  });
});

describe('neighborRow', () => {
  const rows = [{ uid: 1 }, { uid: 2 }, { uid: 3 }];
  const list = { total: 3, rowAt: (i) => rows[i], keyFor: (a, u) => `${a}/${u}`, indexOf: (k) => rows.findIndex((r) => `a/${r.uid}` === k) };
  it('is the row after or before the open one, undefined at the ends or when not loaded', () => {
    expect(neighborRow(list, 'a', 2, 'next')).toEqual({ row: rows[2], index: 2 });
    expect(neighborRow(list, 'a', 2, 'prev')).toEqual({ row: rows[0], index: 0 });
    expect(neighborRow(list, 'a', 3, 'next')).toBe(null);
    expect(neighborRow(list, 'a', 1, 'prev')).toBe(null);
    expect(neighborRow({ ...list, rowAt: () => undefined }, 'a', 2, 'next')).toBe(null);
    expect(neighborRow(null, 'a', 2, 'next')).toBe(null);
  });
});
