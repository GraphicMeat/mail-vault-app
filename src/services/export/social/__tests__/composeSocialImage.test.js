// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { composeSocialImage } from '../composeSocialImage';
import { layoutSocial, SIZE_PRESETS } from '../socialLayout';

// jsdom has no 2d context. A recording fake: every method call and property
// write lands in `log` as [name, ...args].
let log;
let getContext;
function fakeContext() {
  return new Proxy({}, {
    get(_, key) {
      if (key === 'createLinearGradient') return (...args) => { log.push([key, ...args]); return { addColorStop() {} }; };
      return (...args) => { log.push([key, ...args]); };
    },
    set(_, key, value) { log.push([`set:${String(key)}`, value]); return true; },
  });
}

beforeEach(() => {
  log = [];
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
});
afterEach(() => getContext.mockRestore());

const contentCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const base = { padding: 64, radius: 16, chrome: true, theme: 'light', fit: 'crop' };

describe('composeSocialImage', () => {
  it('sizes the canvas and draws the content where the layout says', () => {
    const content = contentCanvas(1640, 6000);
    const out = composeSocialImage({ ...base, content, size: SIZE_PRESETS.portrait, background: { type: 'gradient', id: 'sunset' }, shadow: true });
    const L = layoutSocial({ contentW: 1640, contentH: 6000, size: SIZE_PRESETS.portrait, padding: 64, chrome: true, fit: 'crop' });
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
    const L = layoutSocial({ contentW: 1640, contentH: 6000, size: SIZE_PRESETS.story, padding: 64, chrome: true, fit: 'crop' });
    const scale = Math.min(720 / L.canvasW, 840 / L.canvasH);
    expect(out.height).toBeLessThanOrEqual(840);
    expect([out.width, out.height]).toEqual([Math.round(L.canvasW * scale), Math.round(L.canvasH * scale)]);
    expect(log).toContainEqual(['setTransform', scale, 0, 0, scale, 0, 0]);
    expect(log).toContainEqual(['set:shadowBlur', 80 * scale]);
  });
});

