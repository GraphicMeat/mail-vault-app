import { describe, it, expect } from 'vitest';
import { layoutSocial, SIZE_PRESETS, MACOS_WINDOW_RADIUS, EMAIL_WIDTH } from '../socialLayout';
import { EXPORT_WIDTH_PX } from '../../exportDocument';
import { GRADIENT_PRESETS, SOLID_PRESETS, resolveBackground, backgroundLuminance, inkForBackground } from '../socialBackgrounds';

describe('layoutSocial', () => {
  it('auto wraps content in padding, plus chrome', () => {
    const l = layoutSocial({ contentW: 1640, contentH: 1200, size: SIZE_PRESETS.auto, padding: 48, chrome: true });
    expect(l.chromeH).toBe(56);
    expect(l.card).toEqual({ x: 96, y: 96, w: 1640, h: 1256 });
    expect([l.canvasW, l.canvasH]).toEqual([1640 + 192, 1256 + 192]);
  });
  it('a tall card is fitted whole into a fixed size, never cut, and centered', () => {
    const l = layoutSocial({ contentW: 1640, contentH: 6000, size: SIZE_PRESETS.portrait, padding: 64, chrome: true });
    const availH = 1350 * 2 - 128 * 2 - l.chromeH;
    expect(l.content.sy).toBe(0);
    expect(l.content.sh).toBe(6000);
    expect(l.content.dh).toBeLessThanOrEqual(availH);
    expect(l.content.dw).toBeLessThan(1640);
    expect(l.card.x).toBe(Math.round((l.canvasW - l.content.dw) / 2));
    expect(l.card.y).toBe(Math.round((l.canvasH - l.content.dh - l.chromeH) / 2));
    expect(l.card.y + l.card.h).toBeLessThanOrEqual(l.canvasH - 128);
  });
  it('contain fits a wide app shot into a story, centered', () => {
    const l = layoutSocial({ contentW: 2880, contentH: 1800, size: SIZE_PRESETS.story, padding: 32, chrome: true });
    expect(l.card.x).toBe(64);
    expect(l.card.w).toBe(2160 - 128);
    expect(l.card.y).toBeGreaterThan(64); // vertically centred
  });
  it('a short card is scaled to fill the width, whole', () => {
    const l = layoutSocial({ contentW: 1640, contentH: 800, size: SIZE_PRESETS.portrait, padding: 64, chrome: true });
    expect(l.content.sh).toBe(800);
    expect(l.content.dw).toBe(2160 - 256);
  });
});

describe('social backgrounds', () => {
  it('has ten gradients and six solids, white and black among them', () => {
    expect(GRADIENT_PRESETS).toHaveLength(10);
    expect(new Set(GRADIENT_PRESETS.map(g => g.id)).size).toBe(10);
    expect(SOLID_PRESETS.map(s => s.color)).toEqual(expect.arrayContaining(['#ffffff', '#000000']));
    expect(SOLID_PRESETS).toHaveLength(6);
  });
  it('resolves each kind, and an unknown preset to the first one', () => {
    expect(resolveBackground({ type: 'gradient', id: 'ocean' })).toMatchObject({ kind: 'linear', stops: GRADIENT_PRESETS[1].stops });
    expect(resolveBackground({ type: 'gradient', id: 'nope' }).stops).toEqual(GRADIENT_PRESETS[0].stops);
    expect(resolveBackground({ type: 'solid', id: 'black' })).toEqual({ kind: 'solid', color: '#000000' });
    expect(resolveBackground({ type: 'custom', stops: ['#111111', '#222222'] })).toMatchObject({ kind: 'linear', stops: ['#111111', '#222222'] });
    expect(resolveBackground({ type: 'transparent' })).toEqual({ kind: 'none' });
    expect(resolveBackground({ type: 'image' })).toEqual({ kind: 'none' });
  });
});

describe('inkForBackground', () => {
  it('measures a solid by its color and a gradient by the average of its stops', () => {
    expect(backgroundLuminance({ type: 'solid', id: 'white' })).toBeCloseTo(1, 5);
    expect(backgroundLuminance({ type: 'solid', id: 'black' })).toBe(0);
    expect(backgroundLuminance({ type: 'custom', stops: ['#000000', '#ffffff'] })).toBeCloseTo(0.214, 2);
    expect(backgroundLuminance({ type: 'solid', color: '#fff' })).toBeCloseTo(1, 5);
  });
  it('has nothing to measure for an image or no background', () => {
    expect(backgroundLuminance({ type: 'transparent' })).toBeNull();
    expect(backgroundLuminance({ type: 'image', image: {} })).toBeNull();
  });
  it('dark text on a light background, white on a dark one', () => {
    expect(inkForBackground({ type: 'solid', id: 'white' })).toEqual({ color: '#1d1d1f', shadow: false });
    expect(inkForBackground({ type: 'solid', id: 'cream' })).toEqual({ color: '#1d1d1f', shadow: false });
    expect(inkForBackground({ type: 'solid', id: 'black' })).toEqual({ color: '#ffffff', shadow: false });
    expect(inkForBackground({ type: 'gradient', id: 'midnight' })).toEqual({ color: '#ffffff', shadow: false });
    expect(inkForBackground({ type: 'gradient', id: 'mint' }).color).toBe('#1d1d1f');
  });
  it('white with a soft shadow where the backdrop is unknown', () => {
    expect(inkForBackground({ type: 'transparent' })).toEqual({ color: '#ffffff', shadow: true });
    expect(inkForBackground({ type: 'image', image: {} })).toEqual({ color: '#ffffff', shadow: true });
  });
});

describe('MACOS_WINDOW_RADIUS', () => {
  it('is the macOS window corner radius, within the Radius slider\'s 0..40', () => {
    expect(MACOS_WINDOW_RADIUS).toBe(12);
  });
});

describe('EMAIL_WIDTH', () => {
  it('defaults to the export column and spans 480 to 1600 in steps of 20', () => {
    expect(EMAIL_WIDTH).toEqual({ min: 480, max: 1600, step: 20, default: EXPORT_WIDTH_PX });
  });
});
