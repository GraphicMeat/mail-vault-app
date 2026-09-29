// Size guidance for pictures in a signature. A logo pasted into the signature
// editor is a data: URI; at send time extractInlineImages turns it
// into a cid: part, so its bytes travel with EVERY message the account sends.
//
// The grade is the file size (decoded bytes, what Finder shows), not the
// base64 text, which is a third larger. It is taken on the whole KB the UI
// shows, so the number and the colour next to it always agree.

export const KB = 1024;
/** Below this many KB a signature's pictures are perfect. */
export const SIGNATURE_IMAGE_GOOD_BELOW_KB = 100;
/** Up to and including this many KB they are ok-ish; above it, too large. */
export const SIGNATURE_IMAGE_WARN_MAX_KB = 200;

const DATA_URI = /^data:[^;,]+;base64,(.*)$/s;

/** Decoded byte size of a base64 data: URI; 0 for any other src. */
export function dataUriBytes(src) {
  const m = DATA_URI.exec(src || '');
  if (!m) return 0;
  const payload = m[1].replace(/\s+/g, '');
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}

/**
 * Total bytes of the pictures embedded in a signature. A remote picture
 * (https:) is not part of the message, so it does not count.
 */
export function signatureImageBytes(html) {
  if (!html || !html.includes('data:')) return 0;
  const { body } = new DOMParser().parseFromString(html, 'text/html');
  let total = 0;
  for (const img of body.querySelectorAll('img[src^="data:"]')) total += dataUriBytes(img.getAttribute('src'));
  return total;
}

/** Whole KB as shown to the user; anything above zero shows as at least 1. */
export function signatureImageKb(bytes) {
  return bytes > 0 ? Math.max(1, Math.round(bytes / KB)) : 0;
}

/** 'good' | 'warn' | 'alert', or null when there is no picture to grade. */
export function classifySignatureImageSize(bytes) {
  const kb = signatureImageKb(bytes);
  if (!kb) return null;
  if (kb < SIGNATURE_IMAGE_GOOD_BELOW_KB) return 'good';
  if (kb <= SIGNATURE_IMAGE_WARN_MAX_KB) return 'warn';
  return 'alert';
}

/**
 * Whether a signature signs anything. A logo with no words is a signature:
 * its plain-text twin is empty, and judging by that alone saved it as nothing.
 */
export function signatureHasContent(html, text) {
  return !!text || /<img\b/i.test(html || '');
}
