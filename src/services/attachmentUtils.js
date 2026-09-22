/**
 * Filter attachments to only "real" ones (exclude inline embedded images
 * referenced in the HTML body, and tiny tracking pixels).
 *
 * Each returned attachment gets an `_originalIndex` property that maps back
 * to its position in the original `attachments` array — needed for on-demand
 * lazy loading via `maildir_read_attachment`.
 */
import { send } from './transport';
import { avoidReserved, isWindowsPlatform } from '../stores/slices/unifiedHelpers.js';

// Win32-invalid characters and controls. `:` is the dangerous one: on NTFS
// `a.pdf:x.exe` addresses a hidden stream of `a.pdf`.
// eslint-disable-next-line no-control-regex
const WIN32_UNSAFE_RE = /[<>:"|?*\u0000-\u001f]/g;

/**
 * The one component of a sender-chosen attachment name that may name a file
 * we write. Only the last path component survives (`path.join` resolves `..`,
 * so `../../x` would otherwise land outside the folder), a name that is only
 * `.`/`..`/empty falls back, and Win32-invalid characters become `_` on every
 * platform. Mirrors `safe_leaf` + `win32_safe` in src-core/src/vault_files.rs.
 */
export function safeLeaf(filename) {
  const leaf = String(filename ?? '').split(/[/\\]/).pop().replace(WIN32_UNSAFE_RE, '_');
  if (!leaf || leaf === '.' || leaf === '..') return 'attachment';
  // Reserved device names only exist on Windows; elsewhere `CON.txt` is a name.
  return isWindowsPlatform() ? avoidReserved(leaf) : leaf;
}

export function getRealAttachments(attachments, html) {
  if (!attachments) return [];
  return attachments
    .map((att, index) => ({ ...att, _originalIndex: index }))
    .filter(att => {
      const type = (att.contentType || '').toLowerCase();
      if (!type.startsWith('image/')) return true;
      // Only hide if the image has a Content-ID that is actually
      // referenced in the HTML body (i.e. embedded via cid:)
      if (att.contentId && html) {
        const cid = att.contentId.replace(/^<|>$/g, '');
        if (html.includes(`cid:${cid}`)) return false;
      }
      // Tracking pixels: tiny unnamed images
      if (!att.filename && att.size && att.size < 5000) return false;
      return true;
    });
}

/**
 * Replace cid: URLs in HTML with inline data: URIs from attachment content.
 * This makes embedded images render correctly inside sandboxed iframes.
 */
export function replaceCidUrls(html, attachments) {
  if (!html || !attachments?.length) return html;
  let result = html;
  for (const att of attachments) {
    if (!att.contentId || !att.content) continue;
    const cid = att.contentId.replace(/^<|>$/g, '');
    if (!result.includes(`cid:${cid}`)) continue;
    const contentType = (att.contentType || 'application/octet-stream').split(';')[0].trim();
    const dataUri = `data:${contentType};base64,${att.content}`;
    result = result.replaceAll(`cid:${cid}`, dataUri);
  }
  return result;
}

/**
 * Fill in `content` for the inline images an email's HTML references via `cid:`.
 *
 * The light email path (server fetch and Maildir read alike) strips attachment
 * bytes, so `replaceCidUrls` has nothing to substitute and embedded images
 * render as broken boxes. Read just the referenced parts back from the cached
 * .eml — real attachments stay lazy.
 *
 * Returns the same object when there is nothing to hydrate.
 */
export async function hydrateInlineImages(email, accountId, mailbox) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke || !email?.html || !email.attachments?.length) return email;

  // One daemon call per message: it resolves and parses the .eml once for
  // every referenced part, not once per image.
  const indices = [];
  email.attachments.forEach((att, index) => {
    if (att.content || !att.contentId) return;
    // ponytail: 10MB cap keeps a pathological inline image out of the email cache
    if (att.size > 10 * 1024 * 1024) return;
    const cid = att.contentId.replace(/^<|>$/g, '');
    if (email.html.includes(`cid:${cid}`)) indices.push(index);
  });
  if (!indices.length) return email;

  let contents;
  try {
    contents = await send('maildir_read_attachments', {
      accountId,
      mailbox,
      uid: email.uid,
      attachmentIndices: indices,
    });
  } catch {
    return email; // .eml not cached yet — images stay placeholders
  }
  if (!Array.isArray(contents)) return email;

  // A null slot is a part that could not be read: that image alone stays a placeholder.
  let hydrated = false;
  const attachments = [...email.attachments];
  indices.forEach((index, i) => {
    if (typeof contents[i] !== 'string') return;
    attachments[index] = { ...attachments[index], content: contents[i] };
    hydrated = true;
  });

  return hydrated ? { ...email, attachments } : email;
}

/**
 * Determine whether an email has real (non-inline) attachments.
 * Used by the store to update `hasAttachments` on list items.
 */
export function hasRealAttachments(email) {
  if (!email?.attachments?.length) return false;
  return getRealAttachments(email.attachments, email.html).length > 0;
}

/**
 * What the viewer can render in-app for an attachment: 'image', 'pdf', or
 * null (download only). The MIME type decides; a generic type falls back to
 * the extension, because scanners and some phones send every file as
 * application/octet-stream.
 */
export function previewKind({ contentType, filename } = {}) {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  const ext = (filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  return null;
}
