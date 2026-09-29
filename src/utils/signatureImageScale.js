// A logo shown at 40x40 in a signature looks soft on a 3x screen when the file
// is 40x40, and wasteful when it is 1200x1200. Once the person resizes a
// picture, the file is offered at 3x its display size: sharp everywhere, and
// smaller than the original.

import { dataUriBytes } from './signatureImages';

export const RETINA_SCALE = 3;

/** The pictures of an editor document, in order: `{ src, width, height }`. */
export function imageList(doc) {
  const images = [];
  doc.descendants(node => {
    if (node.type.name === 'image') {
      images.push({ src: node.attrs.src, width: node.attrs.width, height: node.attrs.height });
    }
  });
  return images;
}

/** The picture whose display size changed between two lists of the same length, or null. */
export function resizedImage(before, after) {
  if (before.length !== after.length) return null;
  return after.find((image, i) => image.src === before[i].src
    && image.width > 0 && (image.width !== before[i].width || image.height !== before[i].height)) || null;
}

/**
 * The file size that looks sharp on a 3x screen for a picture shown `width`
 * wide, keeping the file's proportions; null when the file is already no
 * bigger than that (nothing to gain, and it is never enlarged).
 */
export function retinaTarget(width, naturalWidth, naturalHeight) {
  if (!(width > 0) || !(naturalWidth > 0) || !(naturalHeight > 0)) return null;
  const targetWidth = Math.round(width * RETINA_SCALE);
  if (naturalWidth <= targetWidth + 1) return null;
  return { width: targetWidth, height: Math.max(1, Math.round(targetWidth * naturalHeight / naturalWidth)) };
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image'));
    img.src = src;
  });
}

/** The picture redrawn at `width` x `height`, in its own format (PNG unless it was JPEG or WebP). */
export async function scaleDataUri(src, width, height) {
  const img = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(img, 0, 0, width, height);
  const mime = /^data:image\/(jpeg|webp)[;,]/.exec(src)?.[0].slice(5, -1) || 'image/png';
  return canvas.toDataURL(mime, 0.92);
}

/**
 * What resizing `image` should offer: the sharp file and the numbers to weigh
 * it by, or null when there is nothing to offer (a remote or vector picture,
 * a file already small enough, a scaled file no lighter than the original).
 */
export async function scaleOffer(image, scale = scaleDataUri) {
  if (!/^data:image\/(?!svg)/.test(image.src || '')) return null;
  const natural = await loadImage(image.src).catch(() => null);
  if (!natural) return null;
  const target = retinaTarget(image.width, natural.naturalWidth, natural.naturalHeight);
  if (!target) return null;
  const scaled = await scale(image.src, target.width, target.height).catch(() => null);
  if (!scaled) return null;
  const before = dataUriBytes(image.src);
  const after = dataUriBytes(scaled);
  if (after >= before) return null;
  return {
    src: image.src,
    display: { width: image.width, height: Math.round(image.width * natural.naturalHeight / natural.naturalWidth) },
    natural: { width: natural.naturalWidth, height: natural.naturalHeight, bytes: before },
    target: { ...target, bytes: after, src: scaled },
  };
}
