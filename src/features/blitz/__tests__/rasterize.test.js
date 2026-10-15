// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
vi.mock('../parity/themeInputs', () => ({ blitzThemeFor: ({ dark, palette }) => ({ mode: dark ? 'dark' : 'light', palette }) }));
const { rasterizeWithBlitz } = await import('../surfaces/rasterize');
const { MAX_CSS_HEIGHT, MAX_IMAGE_AREA_PX, TILE_CSS_HEIGHT } = await import('../surfaces/sizing');

function deps(over = {}) {
  const ctx = { fillRect: vi.fn(), drawImage: vi.fn(), set fillStyle(v) { ctx._fill = v; } };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  return {
    ctx, canvas,
    openRender: vi.fn(async () => ({ docId: 11, rev: 1, meta: {} })),
    imageRender: vi.fn(async () => ({ png: 'iVBOR' })),
    settleRender: vi.fn(async () => ({ settled: true })),
    tileRender: vi.fn(async (_doc, i) => ({ png: `tile${i}` })),
    closeRender: vi.fn(async () => {}),
    decode: vi.fn(async () => ({ width: 1640, height: 3000 })),
    createCanvas: () => canvas,
    ...over,
  };
}

const metaOf = (cssHeight, over = {}) => ({ cssWidth: 820, cssHeight, tileCssHeight: 512, tileCount: Math.ceil(cssHeight / 512), ...over });
let warn;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

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
    expect(warn).toHaveBeenCalledWith('[blitz] export rasterize failed', 'render_unavailable');
  });

  it('a document clamped at MAX_CSS_HEIGHT is null (F12), is never painted, and is closed', async () => {
    const d = deps({ openRender: vi.fn(async () => ({ docId: 12, rev: 1, meta: { cssHeight: MAX_CSS_HEIGHT } })) });
    expect(MAX_CSS_HEIGHT).toBe(200000);
    expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d)).toBeNull();
    expect(d.imageRender).not.toHaveBeenCalled();
    expect(d.closeRender).toHaveBeenCalledWith(12);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('200000 CSS px height limit');
  });

  it('a document just under the clamp is exported', async () => {
    const d = deps({ openRender: vi.fn(async () => ({ docId: 13, rev: 1, meta: { cssHeight: MAX_CSS_HEIGHT - 1 } })) });
    expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d)).toBe(d.canvas);
  });

  it('an image failure returns null and still closes the doc', async () => {
    const d = deps({ imageRender: vi.fn(async () => { throw new Error('render_unavailable'); }) });
    expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d)).toBeNull();
    expect(d.closeRender).toHaveBeenCalledWith(11);
    expect(warn).toHaveBeenCalledWith('[blitz] export rasterize failed', 'render_unavailable');
  });

  it('a decode or canvas throw returns null and still closes the doc', async () => {
    const d = deps({ decode: vi.fn(async () => { throw new Error('bad png'); }) });
    expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d)).toBeNull();
    expect(d.closeRender).toHaveBeenCalledWith(11);
    expect(warn).toHaveBeenCalledWith('[blitz] export rasterize failed', 'bad png');
  });

  it('a throwing onCloneNode returns null before anything is opened', async () => {
    const d = deps();
    const onCloneNode = () => { throw new Error('redact failed'); };
    expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2, onCloneNode }, d)).toBeNull();
    expect(d.openRender).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[blitz] export rasterize failed', 'redact failed');
  });

  describe('past the image area cap (device px of the web canvas > 16.7M)', () => {
    const tallDeps = (over = {}) => {
      const tiles = [];
      const d = deps({
        openRender: vi.fn(async () => ({ docId: 14, rev: 1, meta: { cssHeight: 13447, tileCssHeight: 512, tileCount: 27 } })),
        decode: vi.fn(async (b64) => { const t = { width: 1640, height: 1024, id: b64, close: vi.fn() }; tiles.push(t); return t; }),
        ...over,
      });
      return { d, tiles };
    };

    it('draws every tile at full scale at its own offset into the web-sized canvas; render.image is never called', async () => {
      const { d, tiles } = tallDeps();
      const out = await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2, backgroundColor: '#abcdef' }, d);
      expect(out).toBe(d.canvas);
      expect([d.canvas.width, d.canvas.height]).toEqual([1640, 26894]); // 820x2 by 13447x2, as the web canvas
      expect(d.imageRender).not.toHaveBeenCalled();
      expect(d.tileRender.mock.calls).toEqual(Array.from({ length: 27 }, (_, i) => [14, i]));
      expect(d.ctx.drawImage.mock.calls.map(c => c.slice(1))).toEqual(Array.from({ length: 27 }, (_, i) => [0, i * 1024]));
      expect(d.ctx.drawImage.mock.calls.every((c, i) => c[0] === tiles[i])).toBe(true);
      expect(d.ctx._fill).toBe('#abcdef');
      expect(d.ctx.fillRect).toHaveBeenCalledWith(0, 0, 1640, 26894);
      expect(d.closeRender).toHaveBeenCalledWith(14);
    });

    it('waits for the doc fetches (settle) before the first tile, and draws tiles one at a time', async () => {
      const order = [];
      let open = 0; let maxOpen = 0;
      const { d } = tallDeps({
        settleRender: vi.fn(async () => { order.push('settle'); return { settled: true }; }),
        tileRender: vi.fn(async (_doc, i) => { order.push(`tile${i}`); open++; maxOpen = Math.max(maxOpen, open); await Promise.resolve(); open--; return { png: `t${i}` }; }),
      });
      await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d);
      expect(order.slice(0, 3)).toEqual(['settle', 'tile0', 'tile1']);
      expect(maxOpen).toBe(1);
    });

    it('sizes the canvas, the tile loop and the cap from the SETTLED meta, not open\'s (images relayout the doc): taller', async () => {
      const { d } = tallDeps({ settleRender: vi.fn(async () => ({ settled: true, rev: 2, meta: metaOf(20000) })) });
      await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d);
      expect([d.canvas.width, d.canvas.height]).toEqual([1640, 40000]);
      expect(d.tileRender).toHaveBeenCalledTimes(40); // ceil(20000 / 512), not open's 27
      expect(d.tileRender).toHaveBeenLastCalledWith(14, 39);
      expect(d.ctx.drawImage.mock.calls.at(-1).slice(1)).toEqual([0, 39 * 1024]);
    });

    it('a doc that SHRANK when its images landed asks for no tile past its new end', async () => {
      const { d } = tallDeps({ settleRender: vi.fn(async () => ({ settled: true, rev: 2, meta: metaOf(9000) })) });
      await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d);
      expect([d.canvas.width, d.canvas.height]).toEqual([1640, 18000]);
      expect(d.tileRender).toHaveBeenCalledTimes(18); // ceil(9000 / 512)
    });

    it('a doc that reaches the height limit only after its images landed is refused', async () => {
      const { d } = tallDeps({ settleRender: vi.fn(async () => ({ settled: true, rev: 2, meta: metaOf(MAX_CSS_HEIGHT) })) });
      expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d)).toBeNull();
      expect(d.tileRender).not.toHaveBeenCalled();
      expect(d.closeRender).toHaveBeenCalledWith(14);
      expect(warn.mock.calls[0][0]).toContain('200000 CSS px height limit');
    });

    it('the column is the worker\'s ceil(meta.cssWidth): a mail overflowing sideways gets tiles\' width', async () => {
      const { d } = tallDeps({ openRender: vi.fn(async () => ({ docId: 14, rev: 1, meta: metaOf(13447, { cssWidth: 900.4 }) })) });
      await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d);
      expect(d.canvas.width).toBe(1802); // ceil(900.4) * 2
    });

    it('a doc under the cap at open that the images grew past it is redrawn from tiles, not left as a shrunk PNG', async () => {
      const d = deps({
        openRender: vi.fn(async () => ({ docId: 17, rev: 1, meta: metaOf(4000) })), // 1640 x 8000: render.image
        settleRender: vi.fn(async () => ({ settled: true, rev: 2, meta: metaOf(9000) })), // grew: 1640 x 18000
        decode: vi.fn(async (b64) => (b64 === 'iVBOR' ? { width: 1010, height: 11000 } : { width: 1640, height: 1024, close: vi.fn() })),
      });
      await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d);
      expect(d.imageRender).toHaveBeenCalledWith(17);
      expect([d.canvas.width, d.canvas.height]).toEqual([1640, 18000]);
      expect(d.tileRender).toHaveBeenCalledTimes(18);
    });

    it('a tile failure returns null and still closes the doc', async () => {
      const { d } = tallDeps({ tileRender: vi.fn(async (_doc, i) => { if (i === 3) throw new Error('render_unavailable'); return { png: 'x' }; }) });
      expect(await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d)).toBeNull();
      expect(d.closeRender).toHaveBeenCalledWith(14);
      expect(warn).toHaveBeenCalledWith('[blitz] export rasterize failed', 'render_unavailable');
    });
  });

  it('under the cap it is render.image (which waits for the fetches itself): no settle, no tiles', async () => {
    const d = deps({ openRender: vi.fn(async () => ({ docId: 16, rev: 1, meta: { cssHeight: 4000, tileCssHeight: 512, tileCount: 8 } })) });
    await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d); // 1640 x 8000 = 13.1M px
    expect(d.imageRender).toHaveBeenCalledWith(16);
    expect(d.settleRender).not.toHaveBeenCalled();
    expect(d.tileRender).not.toHaveBeenCalled();
  });

  it('a PNG at the full export scale keeps its own size and is drawn 1:1', async () => {
    const bitmap = { width: 1640, height: 3000 };
    const d = deps({
      openRender: vi.fn(async () => ({ docId: 15, rev: 1, meta: { cssHeight: 1500 } })),
      decode: vi.fn(async () => bitmap),
    });
    await rasterizeWithBlitz({ html: '<p>x</p>', width: 820, scale: 2 }, d);
    expect([d.canvas.width, d.canvas.height]).toEqual([1640, 3000]);
    expect(d.ctx.drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
  });
});

describe('limits pinned to the worker', () => {
  const rust = (file, name) => {
    const rs = readFileSync(resolve(process.cwd(), 'src-render/src', file), 'utf8');
    const m = rs.match(new RegExp(`pub const ${name}: \\w+ = ([\\d_]+)(?:\\.0)?;`));
    expect(m).not.toBeNull();
    return Number(m[1].replace(/_/g, ''));
  };
  it('MAX_CSS_HEIGHT is what doc.rs clamps at', () => { expect(rust('doc.rs', 'MAX_CSS_HEIGHT')).toBe(MAX_CSS_HEIGHT); });
  it('TILE_CSS_HEIGHT is what doc.rs cuts tiles at', () => { expect(rust('doc.rs', 'TILE_CSS_HEIGHT')).toBe(TILE_CSS_HEIGHT); });
  it('MAX_IMAGE_AREA_PX is the area doc_image.rs shrinks the image past', () => { expect(rust('doc_image.rs', 'MAX_IMAGE_AREA_PX')).toBe(MAX_IMAGE_AREA_PX); });
});
