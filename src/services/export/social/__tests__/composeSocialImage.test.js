// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { composeSocialImage } from '../composeSocialImage';
import { layoutSocial, SIZE_PRESETS } from '../socialLayout';

// jsdom has no 2d context. A recording fake: every method call and property
// write lands in `log` as [name, ...args]. Text is half its font size wide per character.
let log;
let getContext;
function fakeContext() {
  let font = '10px sans-serif';
  return new Proxy({}, {
    get(_, key) {
      if (key === 'createLinearGradient') return (...args) => { log.push([key, ...args]); return { addColorStop() {} }; };
      if (key === 'measureText') return (text) => ({ width: String(text).length * Number(/([\d.]+)px/.exec(font)?.[1] ?? 10) * 0.5 });
      return (...args) => { log.push([key, ...args]); };
    },
    set(_, key, value) { if (key === 'font') font = value; log.push([`set:${String(key)}`, value]); return true; },
  });
}

beforeEach(() => {
  log = [];
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
});
afterEach(() => getContext.mockRestore());

const contentCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const base = { padding: 64, radius: 16, chrome: true, theme: 'light' };
// The decoded lockup: the app icon and the Graphic Meat logo.
const lockup = () => ({ icon: { naturalWidth: 256, naturalHeight: 256 }, mark: { naturalWidth: 478, naturalHeight: 84 } });

describe('composeSocialImage', () => {
  it('sizes the canvas and draws the content where the layout says', () => {
    const content = contentCanvas(1640, 6000);
    const out = composeSocialImage({ ...base, content, size: SIZE_PRESETS.portrait, background: { type: 'gradient', id: 'sunset' }, shadow: true });
    const L = layoutSocial({ contentW: 1640, contentH: 6000, size: SIZE_PRESETS.portrait, padding: 64, chrome: true });
    expect([out.width, out.height]).toEqual([L.canvasW, L.canvasH]);
    const c = L.content;
    expect(log).toContainEqual(['drawImage', content, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh]);
  });

  it('sets a shadow only when asked', () => {
    const content = contentCanvas(1640, 1200);
    composeSocialImage({ ...base, content, size: null, background: { type: 'solid', id: 'white' }, shadow: true });
    expect(log.some(([k]) => k === 'set:shadowBlur')).toBe(true);
    log = [];
    composeSocialImage({ ...base, content, size: null, background: { type: 'solid', id: 'white' }, shadow: false });
    expect(log.some(([k]) => k === 'set:shadowBlur')).toBe(false);
  });

  it('paints no background for transparent', () => {
    const content = contentCanvas(1640, 1200);
    const out = composeSocialImage({ ...base, content, size: SIZE_PRESETS.square, background: { type: 'transparent' }, shadow: false });
    const full = ([k, x, y, w, h]) => k === 'fillRect' && x === 0 && y === 0 && w === out.width && h === out.height;
    expect(log.some(full)).toBe(false);
    // Control: a solid one does.
    log = [];
    composeSocialImage({ ...base, content, size: SIZE_PRESETS.square, background: { type: 'solid', id: 'black' }, shadow: false });
    expect(log.some(full)).toBe(true);
  });

  it('paints a preview at preview scale, not full size, shadow scaled with it', () => {
    const content = contentCanvas(1640, 6000);
    const out = composeSocialImage({ ...base, content, size: SIZE_PRESETS.story, background: { type: 'solid', id: 'white' }, shadow: true, maxSize: { w: 720, h: 840 } });
    const L = layoutSocial({ contentW: 1640, contentH: 6000, size: SIZE_PRESETS.story, padding: 64, chrome: true });
    const scale = Math.min(720 / L.canvasW, 840 / L.canvasH);
    expect(out.height).toBeLessThanOrEqual(840);
    expect([out.width, out.height]).toEqual([Math.round(L.canvasW * scale), Math.round(L.canvasH * scale)]);
    expect(log).toContainEqual(['setTransform', scale, 0, 0, scale, 0, 0]);
    expect(log).toContainEqual(['set:shadowBlur', 80 * scale]);
  });

  it('puts the maker\'s lockup in the band under the card, right-aligned with it, after the card', () => {
    const content = contentCanvas(1640, 1200);
    const wm = lockup();
    composeSocialImage({ ...base, content, size: null, background: { type: 'solid', id: 'white' }, shadow: false, watermark: wm });
    const L = layoutSocial({ contentW: 1640, contentH: 1200, size: null, padding: 64, chrome: true });
    const at = log.findIndex(([k, img]) => k === 'drawImage' && img === wm.mark);
    expect(at).toBeGreaterThan(log.findIndex(([k, img]) => k === 'drawImage' && img === content));
    const [, , x, y, w, h] = log[at];
    expect(y).toBeGreaterThanOrEqual(L.card.y + L.card.h);
    expect(y + h).toBeLessThanOrEqual(L.canvasH);
    expect(x + w).toBeCloseTo(L.card.x + L.card.w, 5);
    expect(h).toBeGreaterThanOrEqual(40);
    expect(w / h).toBeCloseTo(478 / 84, 1);
  });

  it('draws the lockup left to right on one line: icon, MailVault, made with, heart, by, Graphic Meat', () => {
    const wm = lockup();
    composeSocialImage({ ...base, content: contentCanvas(1640, 1200), size: null, background: { type: 'solid', id: 'white' }, shadow: false, watermark: wm });
    const icon = log.find(([k, img]) => k === 'drawImage' && img === wm.icon);
    const mark = log.find(([k, img]) => k === 'drawImage' && img === wm.mark);
    const texts = log.filter(([k]) => k === 'fillText');
    expect(texts.map(t => t[1])).toEqual(['MailVault', 'made with', 'by']);
    const xs = [icon[2], ...texts.map(t => t[2]), mark[2]];
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    // One line, centered on the icon's middle.
    const cy = icon[3] + icon[5] / 2;
    texts.forEach(t => expect(t[3]).toBe(cy));
    expect(mark[3] + mark[5] / 2).toBe(cy);
    expect(icon[4]).toBe(icon[5]); // the icon stays square
    expect(log).toContainEqual(['set:font', expect.stringMatching(/^600 [\d.]+px /)]);
    expect(log).toContainEqual(['set:fillStyle', '#e5484d']);
    expect(log.some(([k]) => k === 'bezierCurveTo')).toBe(true);
  });

  it('prints dark lettering on a light background and white on a dark one', () => {
    const run = (background) => {
      log = [];
      composeSocialImage({ ...base, content: contentCanvas(1640, 1200), size: null, background, shadow: false, watermark: lockup() });
      const at = log.findIndex(([k]) => k === 'fillText');
      return log.slice(0, at).filter(([k]) => k === 'set:fillStyle').at(-1)[1];
    };
    expect(run({ type: 'solid', id: 'white' })).toBe('#1d1d1f');
    expect(run({ type: 'solid', id: 'black' })).toBe('#ffffff');
  });

  it('adds a soft shadow under the lettering only where the background is an image or empty', () => {
    const run = (background) => {
      log = [];
      composeSocialImage({ ...base, content: contentCanvas(1640, 1200), size: null, background, shadow: false, watermark: lockup() });
      return log.some(([k, v]) => k === 'set:shadowBlur' && v > 0);
    };
    expect(run({ type: 'transparent' })).toBe(true);
    expect(run({ type: 'solid', id: 'black' })).toBe(false);
  });

  it('shrinks a lockup wider than its room to fit between the canvas inset and the card\'s right edge', () => {
    const wm = lockup();
    // A narrow card with room under it: the full-height lockup would not fit.
    composeSocialImage({ ...base, content: contentCanvas(400, 400), size: null, background: { type: 'solid', id: 'white' }, shadow: false, watermark: wm });
    const L = layoutSocial({ contentW: 400, contentH: 400, size: null, padding: 64, chrome: true });
    const icon = log.find(([k, img]) => k === 'drawImage' && img === wm.icon);
    const mark = log.find(([k, img]) => k === 'drawImage' && img === wm.mark);
    expect(mark[2] + mark[4]).toBeLessThanOrEqual(L.card.x + L.card.w + 0.001);
    expect(icon[2]).toBeGreaterThanOrEqual(24);
  });

  it('with no padding, puts the lockup inside the card\'s bottom-right corner', () => {
    const content = contentCanvas(1640, 1200);
    const wm = lockup();
    const out = composeSocialImage({ ...base, padding: 0, content, size: null, background: { type: 'solid', id: 'white' }, shadow: false, watermark: wm });
    const [, , x, y, w, h] = log.find(([k, img]) => k === 'drawImage' && img === wm.mark);
    expect(x + w).toBeLessThan(out.width);
    expect(y + h).toBeLessThan(out.height);
    expect(x).toBeGreaterThan(0);
  });

  it('draws no lockup without one', () => {
    const content = contentCanvas(1640, 1200);
    composeSocialImage({ ...base, content, size: null, background: { type: 'solid', id: 'white' }, shadow: false });
    expect(log.filter(([k]) => k === 'drawImage')).toHaveLength(1);
    expect(log.some(([k]) => k === 'fillText')).toBe(false);
  });

  it('fits a tall card whole into a fixed size: the whole content is drawn, no fade', () => {
    const content = contentCanvas(1640, 6000);
    composeSocialImage({ ...base, content, size: SIZE_PRESETS.portrait, background: { type: 'solid', id: 'white' }, shadow: false });
    const [, , sx, sy, sw, sh] = log.find(([k, img]) => k === 'drawImage' && img === content);
    expect([sx, sy, sw, sh]).toEqual([0, 0, 1640, 6000]);
    expect(log.some(([k]) => k === 'createLinearGradient')).toBe(false);
  });
});
