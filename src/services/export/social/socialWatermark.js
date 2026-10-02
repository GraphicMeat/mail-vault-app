import markUrl from '../../../assets/graphicmeat-watermark.webp';

let pending = null;

/**
 * The Graphic Meat lockup every social image carries, decoded once. Never
 * rejects: a mark that cannot load gives an image without it, and the next
 * call tries again.
 */
export function loadWatermark() {
  if (pending) return pending;
  // Cleared from outside the attempt: a throw before the first await would
  // otherwise clear `pending` before it is assigned and cache the failure.
  const attempt = (async () => {
    const image = new Image();
    image.src = markUrl;
    await image.decode();
    return image;
  })().catch(() => {
    if (pending === attempt) pending = null;
    return null;
  });
  pending = attempt;
  return attempt;
}
