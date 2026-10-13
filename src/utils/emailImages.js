// An image in a message body as a file: the bytes behind its src, named the way
// the sender named it. Writing and opening are exportSaver's, the same paths the
// export window already uses, so nothing new goes into Rust for this.

import { getCleanBase64, safeLeaf } from '../services/attachmentUtils';
import { openInDefaultApp, saveOneFile } from '../services/export/exportSaver';

const DATA_IMAGE_RE = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is;
const EXTENSIONS = { jpeg: 'jpg', 'svg+xml': 'svg', 'x-icon': 'ico' };

/**
 * `{ name, base64 }` for an inline (`data:`) image, or null.
 *
 * Only inline images: they are the mail's own bytes (cid: parts the viewer
 * already resolved). A remote image would have to be fetched again, around the
 * tracker blocking and CSP that decided whether it loaded at all.
 */
export function imageFileFromSrc(src, attachments = []) {
  const match = typeof src === 'string' ? src.match(DATA_IMAGE_RE) : null;
  if (!match) return null;
  const base64 = getCleanBase64(match[2]);
  const subtype = match[1].toLowerCase().slice('image/'.length);
  const owner = attachments?.find(att => att?.filename && att.content && getCleanBase64(att.content) === base64);
  const name = owner ? safeLeaf(owner.filename) : `image.${EXTENSIONS[subtype] ?? subtype}`;
  return { name, base64 };
}

/** The inline image a pointer event in the message body landed on, as a file. */
export function inlineImageAt(target, attachments) {
  const img = target?.closest?.('img');
  return img ? imageFileFromSrc(img.getAttribute('src'), attachments) : null;
}

/**
 * Same, for a double click: a linked image's click already followed the link,
 * so its double click is not a second, different open.
 */
export function imageForDoubleClick(target, attachments) {
  return target?.closest?.('a[href]') ? null : inlineImageAt(target, attachments);
}

let opened = 0;

/**
 * Hand the image to the system viewer (Preview on macOS). Each open gets its
 * own name: a viewer that already shows a path keeps showing what it read
 * there, so a second image written over the same path would open as the first.
 */
export function openEmailImage(file) {
  const dot = file.name.lastIndexOf('.');
  const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
  const ext = dot > 0 ? file.name.slice(dot) : '';
  opened += 1;
  return openInDefaultApp({ ...file, name: `${stem}-${Date.now().toString(36)}${opened}${ext}` });
}

export function saveEmailImage(file, title) {
  return saveOneFile(file, title);
}
