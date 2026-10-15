// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
vi.mock('../parity/themeInputs', () => ({ blitzThemeFor: ({ dark, palette }) => ({ mode: dark ? 'dark' : 'light', palette }) }));
const { rasterizeWithBlitz } = await import('../surfaces/rasterize');
const { MAX_CSS_HEIGHT } = await import('../surfaces/sizing');

function deps(over = {}) {
  const ctx = { fillRect: vi.fn(), drawImage: vi.fn(), set fillStyle(v) { ctx._fill = v; } };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  return {
    ctx, canvas,
    openRender: vi.fn(async () => ({ docId: 11, rev: 1, meta: {} })),
    imageRender: vi.fn(async () => ({ png: 'iVBOR' })),
    closeRender: vi.fn(async () => {}),
    decode: vi.fn(async () => ({ width: 1640, height: 3000 })),
    createCanvas: () => canvas,
    ...over,
  };
}

describe('rasterizeWithBlitz', () => {
  it('opens the document at the column width and export scale, paints the PNG over the fill', async () => {
    const d = deps();
    const out = await rasterizeWithBlitz({ html: '<html><body><p onclick="x()">x</p><script>s()</script></body></html>', width: 820, scale: 2, backgroundColor: '#123456' }, d);
    expect(out).toBe(d.canvas);
    expect(d.openRender).toHaveBeenCalledWith(expect.objectContaining({ cssWidth: 820, scale: 2, allowRemote: true, theme: { mode: 'light', palette: undefined } }));
    expect(d.openRender.mock.calls[0][0].html).not.toMatch(/<script|onclick/i);
    expect([d.canvas.width, d.canvas.height]).toEqual([1640, 3000]);
    expect(d.ctx._fill).toBe('#123456');
    expect(d.ctx.drawImage).toHaveBeenCalled();
    expect(d.closeRender).toHaveBeenCalledWith(11);
  });

  it('dark social body: dark theme with the palette', async () => {
    const d = deps();
    await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2, dark: true, palette: 'indigo' }, d);
    expect(d.openRender.mock.calls[0][0].theme).toEqual({ mode: 'dark', palette: 'indigo' });
  });

  it('runs onCloneNode on the parsed copy before rendering (redaction)', async () => {
    const d = deps();
    const onCloneNode = (body) => { body.querySelectorAll('p').forEach(p => { p.textContent = '███'; }); };
    await rasterizeWithBlitz({ html: '<html><body><p>Ann Lee</p></body></html>', width: 820, scale: 2, onCloneNode }, d);
    expect(d.openRender.mock.calls[0][0].html).toContain('███');
    expect(d.openRender.mock.calls[0][0].html).not.toContain('Ann Lee');
  });

  it('an open failure returns null and closes nothing it did not open', async () => {
    const d = deps({ openRender: vi.fn(async () => { throw new Error('render_unavailable'); }) });
    expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d)).toBeNull();
    expect(d.closeRender).not.toHaveBeenCalled();
  });

  it('a document clamped at MAX_CSS_HEIGHT is null (F12), is never painted, and is closed', async () => {
    const d = deps({ openRender: vi.fn(async () => ({ docId: 12, rev: 1, meta: { cssHeight: MAX_CSS_HEIGHT } })) });
    expect(MAX_CSS_HEIGHT).toBe(200000);
    expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d)).toBeNull();
    expect(d.imageRender).not.toHaveBeenCalled();
    expect(d.closeRender).toHaveBeenCalledWith(12);
  });

  it('a document just under the clamp is exported', async () => {
    const d = deps({ openRender: vi.fn(async () => ({ docId: 13, rev: 1, meta: { cssHeight: MAX_CSS_HEIGHT - 1 } })) });
    expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d)).toBe(d.canvas);
  });

  it('an image failure returns null and still closes the doc', async () => {
    const d = deps({ imageRender: vi.fn(async () => { throw new Error('render_unavailable'); }) });
    expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d)).toBeNull();
    expect(d.closeRender).toHaveBeenCalledWith(11);
  });

  it('a decode or canvas throw returns null and still closes the doc', async () => {
    const d = deps({ decode: vi.fn(async () => { throw new Error('bad png'); }) });
    expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d)).toBeNull();
    expect(d.closeRender).toHaveBeenCalledWith(11);
  });

  it('a throwing onCloneNode returns null before anything is opened', async () => {
    const d = deps();
    const onCloneNode = () => { throw new Error('redact failed'); };
    expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2, onCloneNode }, d)).toBeNull();
    expect(d.openRender).not.toHaveBeenCalled();
  });
});
