import { describe, it, expect } from 'vitest';
import { layoutSocial, SIZE_PRESETS } from '../socialLayout';
import { GRADIENT_PRESETS, SOLID_PRESETS, resolveBackground } from '../socialBackgrounds';

describe('layoutSocial', () => {
  it('auto wraps content in padding, plus chrome', () => {
    const l = layoutSocial({ contentW: 1640, contentH: 1200, size: SIZE_PRESETS.auto, padding: 48, chrome: true, fit: 'crop' });
    expect(l.chromeH).toBe(56);
    expect(l.card).toEqual({ x: 96, y: 96, w: 1640, h: 1256 });
    expect([l.canvasW, l.canvasH]).toEqual([1640 + 192, 1256 + 192]);
    expect(l.cropped).toBe(false);
  });
  it('square crops a tall email to the top and flags it', () => {
    const l = layoutSocial({ contentW: 1640, contentH: 6000, size: SIZE_PRESETS.square, padding: 64, chrome: false, fit: 'crop' });
    expect([l.canvasW, l.canvasH]).toEqual([2160, 2160]);
    expect(l.cropped).toBe(true);
    expect(l.content.sy).toBe(0);
    expect(l.card.y + l.card.h).toBeLessThanOrEqual(2160 - 128);
    expect(l.content.dw).toBe(2160 - 256);
  });
  it('contain fits a wide app shot into a story, centered', () => {
    const l = layoutSocial({ contentW: 2880, contentH: 1800, size: SIZE_PRESETS.story, padding: 32, chrome: true, fit: 'contain' });
    expect(l.card.x).toBe(64);
    expect(l.card.w).toBe(2160 - 128);
    expect(l.card.y).toBeGreaterThan(64); // vertically centred
    expect(l.cropped).toBe(false);
  });
  it('crop leaves a short email whole', () => {
    const l = layoutSocial({ contentW: 1640, contentH: 800, size: SIZE_PRESETS.portrait, padding: 64, chrome: true, fit: 'crop' });
    expect(l.cropped).toBe(false);
    expect(l.content.sh).toBe(800);
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
