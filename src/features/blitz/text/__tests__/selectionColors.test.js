import { describe, it, expect } from 'vitest';
import { blendWithWhite, overlayFor } from '../selectionColors';

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
});
