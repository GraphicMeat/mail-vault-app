// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { computeView } from '../view.js';

// Roughly the countryside island on the camera plane.
const BOUNDS = { x0: -14.5, x1: 14.5, y0: -11.5, y1: 10.5 };
const BASE = { w: 1512, h: 860, dpr: 2, insetTop: 255, bounds: BOUNDS, detail: 32, fill: 0.86 };

// Window sizes from a phone to an ultrawide, each with the countdown height it gets.
const SCREENS = [
  [375, 812, 199], [768, 1024, 287], [800, 500, 162], [1024, 600, 184], [1280, 800, 237],
  [1366, 768, 229], [1512, 860, 255], [1920, 1080, 313], [2560, 1080, 313], [3440, 1440, 358],
];

/** Where a point on the camera plane lands on screen, in CSS px. */
function toCss(v, x, y) {
  const { left, right, top, bottom } = v.frustum;
  return [((x - left) / (right - left)) * v.cssW, ((top - y) / (top - bottom)) * v.cssH];
}

describe('computeView', () => {
  it('makes every art pixel a whole number of device pixels, at any OS scale', () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2, 3]) {
      const v = computeView({ ...BASE, dpr });
      expect(Number.isInteger(v.px), `dpr ${dpr}`).toBe(true);
      expect(v.cssW * dpr).toBeCloseTo(v.rw * v.px, 6);
      expect(v.cssH * dpr).toBeCloseTo(v.rh * v.px, 6);
    }
  });

  it('never draws an art pixel smaller than one CSS pixel, so it stays pixel art', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      for (const [w, h, insetTop] of SCREENS) {
        const v = computeView({ ...BASE, w, h, insetTop, dpr });
        expect(v.px / dpr, `${w}x${h} @${dpr}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('is never coarser than the detail asked for, unless it is already at the finest', () => {
    for (const [w, h, insetTop] of SCREENS) {
      const v = computeView({ ...BASE, w, h, insetTop, dpr: 1, detail: 12 });
      if (v.px > 2) expect(1 / v.upp, `${w}x${h}`).toBeGreaterThanOrEqual(12);
    }
  });

  it('keeps the diorama on screen and below the countdown, centred in the free space', () => {
    for (const [w, h, insetTop] of SCREENS) {
      const v = computeView({ ...BASE, w, h, insetTop });
      const [x0, yTop] = toCss(v, BOUNDS.x0, BOUNDS.y1);
      const [x1, yBottom] = toCss(v, BOUNDS.x1, BOUNDS.y0);
      expect(yTop, `${w}x${h} top`).toBeGreaterThanOrEqual(insetTop - 0.5);
      expect(yBottom, `${w}x${h} bottom`).toBeLessThanOrEqual(h + 0.5);
      expect(x0, `${w}x${h} left`).toBeGreaterThanOrEqual(-0.5);
      expect(x1, `${w}x${h} right`).toBeLessThanOrEqual(w + 0.5);
      expect((yTop + yBottom) / 2).toBeCloseTo(insetTop + (h - insetTop) / 2, 0);
      expect((x0 + x1) / 2).toBeCloseTo(w / 2, 0);
    }
  });

  it('leaves the scene at least 45% of a short window under a tall countdown', () => {
    const v = computeView({ ...BASE, w: 800, h: 400, insetTop: 380 });
    const [, yTop] = toCss(v, 0, BOUNDS.y1);
    expect(yTop).toBeGreaterThanOrEqual(400 * 0.55 - 0.5);
    expect(yTop).toBeLessThan(400);
  });

  it('keeps art pixels square', () => {
    for (const [w, h, insetTop] of SCREENS) {
      const { frustum: f, rw, rh } = computeView({ ...BASE, w, h, insetTop });
      expect((f.right - f.left) / rw).toBeCloseTo((f.top - f.bottom) / rh, 9);
    }
  });

  it('survives a zero-sized host while the lock is still laying out', () => {
    const v = computeView({ ...BASE, w: 0, h: 0, insetTop: 0 });
    expect(v.rw).toBeGreaterThan(0);
    expect(v.rh).toBeGreaterThan(0);
    expect(Object.values(v.frustum).every(Number.isFinite)).toBe(true);
  });
});
