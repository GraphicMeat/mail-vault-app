// An image in a message body as a file: the bytes behind its src, named the way
// the sender named it. Writing and opening are exportSaver's, the same paths the
// export window already uses, so nothing new goes into Rust for this.

import { getCleanBase64, safeLeaf } from '../services/attachmentUtils';
import { openInDefaultApp, saveOneFile } from '../services/export/exportSaver';
import { refuseWindowUnderPrivacy } from './privacy/windowBlocked';
import { useMailStore } from '../stores/mailStore';
import { t } from '../i18n/index.js';

const DATA_IMAGE_RE = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is;
const EXTENSIONS = { jpeg: 'jpg', 'svg+xml': 'svg', 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico' };
// What the system viewer (Preview) shows as a picture. Not svg: on most Macs it
// opens in a browser, from file://, where the sender's script would run.
const VIEWABLE = new Set(['png', 'jpg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'ico', 'avif']);

/**
 * `{ name, base64 }` for an inline (`data:`) image, or null.
 *
 * Only inline images: they are the mail's own bytes (cid: parts the viewer
 * already resolved). A remote image would have to be fetched again, around the
 * tracker blocking and CSP that decided whether it loaded at all.
 *
 * The name's stem is the attachment's, its extension always the image type's:
 * the extension picks the app that opens the file, and the sender picks the
 * attachment name.
 */
export function imageFileFromSrc(src, attachments = []) {
  const match = typeof src === 'string' ? src.match(DATA_IMAGE_RE) : null;
  if (!match) return null;
  const subtype = match[1].toLowerCase().slice('image/'.length);
  const ext = (EXTENSIONS[subtype] ?? subtype).replace(/[^a-z0-9]/g, '') || 'img';
  const base64 = getCleanBase64(match[2]);
  // replaceCidUrls embeds the content verbatim, so the exact comparison hits
  // first; cleaning every attachment's payload is only the fallback.
  const named = (attachments || []).filter(att => att?.filename && att.content);
  const owner = named.find(att => att.content === match[2])
    ?? named.find(att => getCleanBase64(att.content) === base64);
  const leaf = owner ? safeLeaf(owner.filename) : 'image';
  const dot = leaf.lastIndexOf('.');
  return { name: `${dot > 0 ? leaf.slice(0, dot) : leaf}.${ext}`, base64 };
}

/** Whether the system viewer should get this file. Save As takes any image. */
export function canOpenImage(file) {
  return !!file && VIEWABLE.has(file.name.slice(file.name.lastIndexOf('.') + 1));
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

/** Open from a message body: refused under privacy mode, failures said. */
export function openImageFromMail(file) {
  // Like Open in window: the viewer is out of reach of the masking pass.
  if (!canOpenImage(file) || refuseWindowUnderPrivacy()) return;
  openEmailImage(file).catch((err) => {
    console.error('[emailImages] open failed:', err);
    useMailStore.setState({ error: t('viewer.imageOpenFailed') });
  });
}

export function saveImageFromMail(file) {
  saveEmailImage(file, t('email.attachments.save')).catch((err) => {
    console.error('[emailImages] save failed:', err);
    useMailStore.setState({ error: t('email.attachments.failedSave') });
  });
}

/**
 * Double-click an inline image in a message body to open it, in every frame
 * that shows one. `getAttachments` is read at event time: the inline parts'
 * bytes can arrive after the body. Returns the detach.
 */
const attached = new WeakMap();

export function attachImageDoubleClick(doc, getAttachments) {
  // A host that sets up on `load` and once more "in case already loaded" would
  // otherwise open every image twice.
  if (attached.has(doc)) return attached.get(doc);
  const onDblClick = (e) => {
    if (!window.__TAURI__) return;
    const file = imageForDoubleClick(e.target, getAttachments?.());
    if (!canOpenImage(file)) return;
    e.preventDefault();
    openImageFromMail(file);
  };
  const detach = () => {
    doc.removeEventListener('dblclick', onDblClick);
    attached.delete(doc);
  };
  doc.addEventListener('dblclick', onDblClick);
  attached.set(doc, detach);
  return detach;
}
