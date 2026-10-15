import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { send } from '../../services/transport';
import { reportDocGone } from './surfaces/docGone';

export const RENDER_UPDATED = 'render-updated';

// An op on a doc the worker no longer has (evicted, or lost with a restart) tells the doc registry.
const forDoc = (docId, p) => p.catch((e) => { reportDocGone(docId, e); throw e; });

export function openRender({ html, cssWidth, scale, allowRemote, theme }) {
  return send('render.open', { html, cssWidth, scale, allowRemote, theme });
}
// The shell's mvrender scheme serves tile <index> of <docId>; <rev> only busts
// the webview's cache when images arrive or the layout changes.
export function tileUrl(docId, rev, index) {
  return convertFileSrc(`${docId}/${rev}/${index}`, 'mvrender');
}
export function hitRender(docId, x, y) {
  return forDoc(docId, send('render.hit', { docId, x, y }));
}
export async function closeRender(docId) {
  try { await send('render.close', { docId }); } catch { /* worker gone: nothing to close */ }
}
export function onRenderUpdated(cb) {
  return listen(RENDER_UPDATED, e => cb(e.payload));
}
export function textRunsRender(docId, index) {
  return forDoc(docId, send('render.textRuns', { docId, index }));
}
export function serializeRender(docId, start, end) {
  return forDoc(docId, send('render.serialize', { docId, start, end }));
}
export function foldRender(docId, id, open) {
  return forDoc(docId, send('render.fold', { docId, id, open }));
}
// The whole document as one PNG ({ png: base64 }) once its remote images have landed.
export function imageRender(docId) {
  return forDoc(docId, send('render.image', { docId }));
}
// render.image's wait for the doc's fetches (5 s cap) without the paint: resolves { settled }.
export function settleRender(docId) {
  return forDoc(docId, send('render.image', { docId, settleOnly: true }));
}
// One tile's PNG over the RPC (not the mvrender scheme: a canvas drawn from a cross-origin image cannot be read back).
export function tileRender(docId, index) {
  return forDoc(docId, send('render.tile', { docId, index }));
}
// Fonts are a best effort: a family that does not register leaves the stack's fallback drawing.
export async function fontsRender(families) {
  try { return await send('render.fonts', { families }); } catch { return { registered: [] }; }
}
