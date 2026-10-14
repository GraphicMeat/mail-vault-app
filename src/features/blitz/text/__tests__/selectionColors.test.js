// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { blendWithWhite, overlayFor, lightSelectionColor, inactiveSelectionColor, applySelectionColors } from '../selectionColors';

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

describe('inactive window highlight', () => {
  const active = { r: 0, g: 56, b: 201, a: 0.8 };
  const KEY = '-apple-system-unemphasized-selected-text-background';
  const withSupports = (fn) => { vi.stubGlobal('CSS', { supports: fn }); };
  afterEach(() => vi.unstubAllGlobals());

  it('is the active colour where the engine has no inactive highlight keyword', () => {
    withSupports(() => false);
    expect(inactiveSelectionColor(active)).toBe(active);
  });
  it('is the engine unemphasized highlight, blended like the active one, when it resolves', () => {
    withSupports((prop, v) => prop === 'color' && v === KEY);
    highlightIs('rgb(220, 220, 220)');
    expect(inactiveSelectionColor(active)).toEqual({ r: 196, g: 196, b: 196, a: 0.6 });
  });
  it('a keyword that resolves to something the parser cannot trust falls back to the active colour', () => {
    withSupports(() => true);
    highlightIs('color(display-p3 0.8 0.8 0.8)');
    expect(inactiveSelectionColor(active)).toBe(active);
  });
  it('applySelectionColors writes the active and the inactive variable; inactive defaults to active', () => {
    const el = document.createElement('div');
    applySelectionColors(el, active);
    expect(el.style.getPropertyValue('--mv-blitz-sel-bg')).toBe('rgba(0, 56, 201, 0.8)');
    expect(el.style.getPropertyValue('--mv-blitz-sel-inactive-bg')).toBe('rgba(0, 56, 201, 0.8)');
    applySelectionColors(el, active, { r: 196, g: 196, b: 196, a: 0.6 });
    expect(el.style.getPropertyValue('--mv-blitz-sel-inactive-bg')).toBe('rgba(196, 196, 196, 0.6)');
  });
  it('blitz.css paints the inactive highlight in its own ::selection:window-inactive rule', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/features/blitz/blitz.css'), 'utf8');
    // Its own rule: an engine without :window-inactive drops a rule it cannot parse, whole.
    expect(css).toMatch(/\n\.mv-blitz-text span::selection:window-inactive \{[^}]*background-color: var\(--mv-blitz-sel-inactive-bg, var\(--mv-blitz-sel-bg/);
    expect(css).not.toMatch(/,\s*\.mv-blitz-text span::selection:window-inactive/);
    expect(css).not.toMatch(/span::selection:window-inactive\s*,/);
  });
});
