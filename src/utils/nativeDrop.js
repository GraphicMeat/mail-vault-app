// Files dropped on the window arrive through Tauri's native drag-drop, not
// through HTML5 drop events. WebKit's own file-drop path receives a macOS drag
// as file PROMISES, and on the shipped app every second screenshot thumbnail
// dropped on the compose window was never handed to the page at all: the OS
// reported the drop as completed, WebKit's promise receiver never fetched the
// file, and no `drop` event fired (2026-09-03). With `dragDropEnabled: true`
// wry answers AppKit itself, reads plain paths off the pasteboard, and Tauri
// emits `tauri://drag-*` with those paths and the pointer position. These
// helpers turn that payload into what the compose window already stores.

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  json: 'application/json', zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime',
};

export function mimeFromName(name) {
  const base = String(name || '');
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * wry reports the drop point in points on macOS and in device pixels on the
 * other platforms; Tauri labels both PhysicalPosition. A point past the
 * viewport is the pixel case.
 */
export function toClientPoint(position, { dpr = 1, width = Infinity, height = Infinity } = {}) {
  const x = Number(position?.x) || 0;
  const y = Number(position?.y) || 0;
  if (dpr > 1 && (x > width || y > height)) return { x: x / dpr, y: y / dpr };
  return { x, y };
}

/** Which compose zone is under the point: 'editor', 'attach', or null outside the modal. */
export function dropZoneAt(point, elementAt) {
  const el = elementAt(point.x, point.y);
  if (!el) return null;
  if (el.closest('.ProseMirror')) return 'editor';
  if (el.closest('[data-testid="compose-modal"]')) return 'attach';
  return null;
}

/** One `read_dropped_files` record → the compose attachment shape. */
export const toAttachment = ({ name, size, content }) => ({
  filename: name,
  contentType: mimeFromName(name),
  size,
  content,
  isFromOriginal: false,
});
