import { openRender, imageRender, closeRender } from '../service';
import { blitzThemeFor } from '../parity/themeInputs';
import { stripScripts } from '../prepass';
import { MAX_CSS_HEIGHT } from './sizing';

export async function decodePng(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

const defaults = { openRender, imageRender, closeRender, decode: decodePng, createCanvas: () => document.createElement('canvas') };

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
    if (opened.meta?.cssHeight >= MAX_CSS_HEIGHT) return null;
    const { png } = await deps.imageRender(docId);
    const bitmap = await deps.decode(png);
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
