import { describe, it, expect } from 'vitest';
import { boxStyle, scrollsInside, MIN_OPEN_WIDTH, LAZY_SURFACES } from '../surfaces/sizing';

const meta = (h) => ({ cssWidth: 600, cssHeight: h, tileCssHeight: 512, tileCount: Math.ceil(h / 512), links: [], plainText: '', folds: [] });

describe('boxStyle', () => {
  it('content: exactly the document height, keeps minHeight', () => {
    expect(boxStyle('content', meta(1234), { minHeight: 100 })).toEqual({ minHeight: 100, height: 1234, overflowX: 'auto', overflowY: 'hidden' });
  });
  it('content before the doc arrives: zero height, the minHeight floor holds the box', () => {
    expect(boxStyle('content', null, { minHeight: 100 }).height).toBe(0);
  });
  it('fill: the parent height, scrolls inside', () => {
    expect(boxStyle('fill', meta(5000))).toEqual({ height: '100%', overflowX: 'auto', overflowY: 'auto' });
  });
  it('collapsedMax: grows to content, caps and scrolls past it', () => {
    expect(boxStyle({ collapsedMax: 400 }, meta(250))).toEqual({ height: 250, overflowX: 'auto', overflowY: 'hidden' });
    expect(boxStyle({ collapsedMax: 400 }, meta(900))).toEqual({ height: 400, overflowX: 'auto', overflowY: 'auto' });
  });
  it('an unknown sizing is content', () => {
    expect(boxStyle(undefined, meta(10)).height).toBe(10);
  });
});

describe('constants', () => {
  it('MIN_OPEN_WIDTH is 40 and only thread and bubble are lazy (F2)', () => {
    expect(MIN_OPEN_WIDTH).toBe(40);
    expect([...LAZY_SURFACES].sort()).toEqual(['bubble', 'thread']);
  });
});

describe('scrollsInside', () => {
  it('fill and collapsedMax scroll inside; content and unknown do not', () => {
    expect(scrollsInside('fill')).toBe(true);
    expect(scrollsInside({ collapsedMax: 400 })).toBe(true);
    expect(scrollsInside('content')).toBe(false);
    expect(scrollsInside(undefined)).toBe(false);
    expect(scrollsInside({})).toBe(false);
  });
});
