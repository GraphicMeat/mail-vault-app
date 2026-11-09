import { inlineImageAt } from './emailImages';
import { stageFile } from '../services/export/exportSaver';
import { DRAG_FALLBACK_PNG, startFileDrag } from '../services/fileDrag';

const attached = new WeakMap();

export function dragThumbnail(img, max = 128) {
  try {
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) return DRAG_FALLBACK_PNG;
    const canvas = img.ownerDocument.createElement('canvas');
    const scale = Math.min(1, max / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return DRAG_FALLBACK_PNG;
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    return DRAG_FALLBACK_PNG;
  }
}

export function attachImageDrag(doc, getAttachments) {
  if (attached.has(doc)) return attached.get(doc);
  const onDragStart = (event) => {
    if (!window.__TAURI__) return;
    const file = inlineImageAt(event.target, getAttachments?.());
    if (!file) return;
    event.preventDefault();
    const image = event.target.closest('img');
    stageFile(file)
      .then(path => startFileDrag(path, dragThumbnail(image)))
      .catch(error => console.error('[emailImageDrag] drag failed:', error));
  };
  const detach = () => {
    doc.removeEventListener('dragstart', onDragStart);
    attached.delete(doc);
  };
  doc.addEventListener('dragstart', onDragStart);
  attached.set(doc, detach);
  return detach;
}
