import { openRender, imageRender, closeRender, settleRender, tileRender } from '../service';
import { blitzThemeFor } from '../parity/themeInputs';
import { stripScripts } from '../prepass';
import { MAX_CSS_HEIGHT, MAX_IMAGE_AREA_PX, TILE_CSS_HEIGHT } from './sizing';

export async function decodePng(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

const defaults = { openRender, imageRender, closeRender, settleRender, tileRender, decode: decodePng, createCanvas: () => document.createElement('canvas') };

/**
 * One export document (exportDocument.buildMessageDocument) as a canvas, drawn
 * by Blitz: the whole document as one PNG (`render.image`), over the same fill
 * the frame rasterizer uses. Null on any failure: the caller turns that into an
 * export failure for this message, never a hidden frame (overview A10).
 *
 * A document the worker clamped at MAX_CSS_HEIGHT is null too: the PNG would be a
 * silently truncated mail (the worker never errors for height).
 *
 * The export doc is not a registry body: an op on it that finds it gone reports
 * render_unknown_doc to the doc registry, whose forgetDoc of an id it does not
 * hold is a no-op, and no BlitzTiles holds this id.
 */
export async function rasterizeWithBlitz({ html, width, scale, dark = false, palette, onCloneNode, backgroundColor = '#ffffff' }, deps = defaults) {
  let docId = null;
  try {
    // One inert parse serves both the script strip and the redaction callback.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    stripScripts(doc);
    if (onCloneNode) await onCloneNode(doc.body);
    const source = `<!doctype html>\n${doc.documentElement.outerHTML}`;
    const opened = await deps.openRender({ html: source, cssWidth: width, scale, allowRemote: true, theme: blitzThemeFor({ dark, palette }) });
    docId = opened.docId;
    const refuse = (cssHeight) => {
      if (!(cssHeight >= MAX_CSS_HEIGHT)) return false;
      console.warn(`[blitz] export refused: the document reaches the ${MAX_CSS_HEIGHT} CSS px height limit`);
      return true;
    };
    if (refuse(opened.meta?.cssHeight)) return null;
    // The frame rasterizer's canvas is always columnWidth*scale by height*scale, however tall (modern-screenshot
    // has no area cap; imagePacker splits pages, never downscales). The column is the worker's: its tiles are
    // ceil(meta.cssWidth) * scale wide, which a mail that overflows sideways makes wider than `width`.
    const geometry = (meta) => {
      const w = Math.round(Math.ceil(meta?.cssWidth ?? width) * scale);
      const h = Number.isFinite(meta?.cssHeight) ? Math.round(meta.cssHeight * scale) : 0;
      // 0.99: the worker compares unrounded floats, so a doc right at the cap must not land on its shrinking side.
      return { w, h, over: h > 0 && w * h > MAX_IMAGE_AREA_PX * 0.99 };
    };
    // Past the worker's image area cap `render.image` would shrink the PNG, so the tiles, which are always at doc
    // scale, are drawn at their own offsets instead: as sharp as the web canvas. The size comes from the meta the
    // settle returns, not from `open`'s: the doc's images land after open and relayout it (taller or shorter).
    const drawTiles = async () => {
      const settled = await deps.settleRender(docId); // render.image's fetch wait, without its paint; also applies what landed
      const meta = settled?.meta ?? opened.meta;
      if (refuse(meta?.cssHeight)) return null;
      const { w, h } = geometry(meta);
      if (!(h > 0)) throw new Error('render_unavailable');
      const canvas = deps.createCanvas();
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, w, h);
      const tileCssHeight = meta.tileCssHeight || TILE_CSS_HEIGHT;
      const count = meta.tileCount || Math.ceil(meta.cssHeight / tileCssHeight);
      for (let i = 0; i < count; i++) { // one at a time: a tile is up to 1640x1024 px, and the worker is one thread
        const { png } = await deps.tileRender(docId, i);
        const tile = await deps.decode(png);
        ctx.drawImage(tile, 0, Math.round(i * tileCssHeight * scale));
        tile.close?.();
      }
      return canvas;
    };
    if (geometry(opened.meta).over) return await drawTiles();
    const { png } = await deps.imageRender(docId); // waits for the doc's fetches itself
    const bitmap = await deps.decode(png);
    // The images may have grown the doc past the cap after all: the worker then shrank this PNG. Redo it from tiles.
    if (bitmap.width < geometry(opened.meta).w - 1) return await drawTiles();
    const canvas = deps.createCanvas();
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    return canvas;
  } catch (err) {
    console.warn('[blitz] export rasterize failed', err?.message || err);
    return null;
  } finally {
    if (docId != null) { try { await deps.closeRender(docId); } catch { /* the worker is gone: nothing to close */ } }
  }
}
