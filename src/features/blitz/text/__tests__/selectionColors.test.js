// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { blendWithWhite, overlayFor, lightSelectionColor } from '../selectionColors';

afterEach(() => vi.restoreAllMocks());
const highlightIs = (color) => vi.spyOn(window, 'getComputedStyle').mockReturnValue({ color });

describe('selection colours', () => {
  it('blendWithWhite matches WebKit Color::blendWithWhite for the classic macOS highlight', () => {
    expect(blendWithWhite({ r: 179, g: 215, b: 255 })).toEqual({ r: 128, g: 188, b: 255, a: 0.6 });
  });
  it('blendWithWhite raises alpha until no channel goes negative, then clamps', () => {
    expect(blendWithWhite({ r: 0, g: 96, b: 212 })).toEqual({ r: 0, g: 56, b: 201, a: 0.8 });
  });
  it('overlayFor reproduces the target over the paper', () => {
    const paper = { r: 24, g: 26, b: 27 };
    const target = { r: 40, g: 80, b: 140 };
    const o = overlayFor(target, paper);
    const over = (c, p) => Math.round(o.a * c + (1 - o.a) * p);
    expect([over(o.r, paper.r), over(o.g, paper.g), over(o.b, paper.b)]).toEqual([40, 80, 140]);
  });
  it('lightSelectionColor reads an opaque rgb highlight', () => {
    highlightIs('rgb(0, 96, 212)');
    expect(lightSelectionColor()).toEqual({ r: 0, g: 56, b: 201, a: 0.8 });
  });
  it('a highlight the parser cannot trust falls back to the classic one', () => {
    const classic = { r: 128, g: 188, b: 255, a: 0.6 };
    for (const c of ['color(display-p3 0.7 0.83 1)', 'rgba(0, 96, 212, 0.5)', 'Highlight', '']) {
      highlightIs(c);
      expect(lightSelectionColor()).toEqual(classic);
    }
  });
  it('an explicitly opaque rgba and the space syntax are read', () => {
    highlightIs('rgba(0, 96, 212, 1)');
    expect(lightSelectionColor()).toEqual({ r: 0, g: 56, b: 201, a: 0.8 });
    highlightIs('rgb(0 96 212 / 100%)');
    expect(lightSelectionColor()).toEqual({ r: 0, g: 56, b: 201, a: 0.8 });
  });
});
