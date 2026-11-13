// The visual-viewport math behind sheets that stay usable over the on-screen keyboard.
import { describe, it, expect } from 'vitest';
import { viewportBox, revealDelta } from '../keyboardViewport.js';

describe('viewportBox', () => {
  it('iOS: layout viewport unchanged, visual viewport shrunk and panned', () => {
    expect(viewportBox({ innerHeight: 844, height: 508, offsetTop: 280 })).toEqual({ top: 280, height: 508, keyboard: true });
  });
  it('iOS before the pan: a keyboard box at the top', () => {
    expect(viewportBox({ innerHeight: 844, height: 508, offsetTop: 0 })).toEqual({ top: 0, height: 508, keyboard: true });
  });
  it('Android adjustResize: innerHeight shrinks with the visual viewport, so no keyboard box', () => {
    expect(viewportBox({ innerHeight: 500, height: 500, offsetTop: 0 }).keyboard).toBe(false);
  });
  it('no keyboard', () => {
    expect(viewportBox({ innerHeight: 844, height: 844, offsetTop: 0 }).keyboard).toBe(false);
  });
  it('ignores a small toolbar change and rounds', () => {
    expect(viewportBox({ innerHeight: 844, height: 800, offsetTop: 0 }).keyboard).toBe(false);
    expect(viewportBox({ innerHeight: 844, height: 507.6, offsetTop: 279.5 })).toEqual({ top: 280, height: 508, keyboard: true });
  });
  it('clamps a rubber-band negative offset', () => {
    expect(viewportBox({ innerHeight: 844, height: 508, offsetTop: -12 }).top).toBe(0);
  });
});

describe('revealDelta', () => {
  const view = { top: 100, bottom: 500 };
  it('leaves a visible field alone', () => {
    expect(revealDelta(view, { top: 200, bottom: 244 })).toBe(0);
  });
  it('scrolls a field below the area up, with a margin', () => {
    expect(revealDelta(view, { top: 600, bottom: 644 }, 8)).toBe(152);
  });
  it('scrolls a field above the area down', () => {
    expect(revealDelta(view, { top: 40, bottom: 84 }, 8)).toBe(-68);
  });
  it('aligns the top of a field taller than the area', () => {
    expect(revealDelta(view, { top: 300, bottom: 900 }, 8)).toBe(192);
  });
});
