// @vitest-environment jsdom
//
// A tall mail through the REAL renderSocialCard + renderMessageToCanvas, with the
// Blitz rasterizer fed a worker PNG that was shrunk past the area wall. The card
// must be what the web (iframe + modern-screenshot) path makes: the header's
// width, header height + body height (columnWidth*scale by cssHeight*scale), the
// header at y 0 and the body at y = header height. modern-screenshot has no area
// cap (maximumCanvasSize 0) and imagePacker splits pages, never downscales, so
// the web card is never narrower than the column.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('modern-screenshot', () => ({ domToCanvas: vi.fn() }));
vi.mock('../parity/themeInputs', () => ({ blitzThemeFor: ({ dark }) => ({ mode: dark ? 'dark' : 'light' }) }));
const { rasterizeWithBlitz } = await import('../surfaces/rasterize');
const { renderSocialCard } = await import('../../../services/export/social/renderSocialCard');
const { registerBodyRenderer, _resetBodyRenderersForTest } = await import('../../../components/email/bodyRendererRegistry');
const { useSettingsStore } = await import('../../../stores/settingsStore');

const message = { subject: 'Tall', from: 'a@b.c', date: new Date('2026-08-28T09:14:00') };
let drawImage; let getContext;
beforeEach(() => {
  drawImage = vi.fn();
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, fillRect: vi.fn(), set fillStyle(v) { this.fill = v; } });
});
afterEach(() => { getContext.mockRestore(); _resetBodyRenderersForTest(); useSettingsStore.setState({ emailRenderer: 'web' }); });

describe('a tall card through Blitz', () => {
  it('keeps the web card size: one shared width, heights added, body under the header', async () => {
    const shrunk = { width: 1010, height: 16565 }; // 820x13447 css at scale 2 is 44M px: the worker drew it at ~0.616
    const deps = {
      openRender: vi.fn(async () => ({ docId: 3, rev: 1, meta: { cssHeight: 13447 } })),
      imageRender: vi.fn(async () => ({ png: 'x' })),
      closeRender: vi.fn(async () => {}),
      decode: vi.fn(async () => shrunk),
      createCanvas: () => document.createElement('canvas'),
    };
    const head = { width: 1640, height: 240 };
    registerBodyRenderer('blitz', {
      Body: () => null,
      rasterize: (a) => (a.html.includes('TALLBODY') ? rasterizeWithBlitz(a, deps) : Promise.resolve(head)),
    });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    const card = await renderSocialCard({ message, bodyHtml: '<p>TALLBODY</p>', appearance: 'light', mail: 'light' });
    expect([card.width, card.height]).toEqual([1640, 240 + 26894]);
    // header drawn at the top, then the body canvas (full size) right under it
    const stackCalls = drawImage.mock.calls.filter(c => c.length === 3);
    expect(stackCalls[0][0]).toBe(head);
    expect(stackCalls.map(c => [c[1], c[2]])).toEqual([[0, 0], [0, 240]]);
    expect(stackCalls[1][0]).toMatchObject({ width: 1640, height: 26894 });
    // and the shrunk PNG was stretched over the whole body canvas, not left in its corner
    expect(drawImage).toHaveBeenCalledWith(shrunk, 0, 0, 1640, 26894);
  });
});
