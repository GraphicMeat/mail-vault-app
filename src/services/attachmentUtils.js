/**
 * Filter attachments to only "real" ones (exclude inline embedded images
 * referenced in the HTML body, and tiny tracking pixels).
 *
 * Each returned attachment gets an `_originalIndex` property that maps back
 * to its position in the original `attachments` array — needed for on-demand
 * lazy loading via `maildir_read_attachment`.
 */
import { send } from './transport';
import { bareContentId, htmlReferencesCid, replaceCidRefs } from '../utils/cidRefs';
import { t } from '../i18n/index.js';
import { avoidReserved, isWindowsPlatform } from '../stores/slices/unifiedHelpers.js';

/** Bare base64 from a daemon read or a `data:` URI: the prefix and any line breaks dropped. */
export function getCleanBase64(content) {
  let base64Content = content;
  if (typeof base64Content === 'string' && base64Content.startsWith('data:')) {
    const matches = base64Content.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) base64Content = matches[2];
  }
  if (typeof base64Content === 'string') {
    base64Content = base64Content.replace(/[\s\n\r]/g, '');
  }
  return base64Content;
}

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
      if (htmlReferencesCid(html, att.contentId)) return false;
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
  const byCid = new Map();
  for (const att of attachments) {
    if (!att.contentId || !att.content) continue;
    const contentType = (att.contentType || 'application/octet-stream').split(';')[0].trim();
    byCid.set(bareContentId(att.contentId), `data:${contentType};base64,${att.content}`);
  }
  return byCid.size ? replaceCidRefs(html, cid => byCid.get(cid)) : html;
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
    if (htmlReferencesCid(email.html, att.contentId)) indices.push(index);
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
 * `attachments` with every missing `content` read back from where `_source`
 * says it came from: `{ accountId, mailbox, uid, attachmentIndex }`.
 *
 * A forward copies the original's attachment list, and the light fetch that
 * loaded it carries no bytes. One daemon call per source message. A file that
 * cannot be read throws, naming it: the daemon refuses a payload with a
 * contentless attachment anyway, and sending without the file would be worse.
 *
 * Returns the same array when nothing is missing.
 */
export async function withAttachmentBytes(attachments) {
  const unavailable = att => new Error(t('errors.composeAttachmentUnavailable', { filename: att.filename || '' }));
  const groups = new Map();
  for (const att of attachments) {
    if (att.content) continue;
    const src = att._source;
    if (!src) throw unavailable(att);
    const key = `${src.accountId}\u0000${src.mailbox}\u0000${src.uid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(att);
  }
  if (!groups.size) return attachments;

  const filled = new Map();
  for (const group of groups.values()) {
    const { accountId, mailbox, uid } = group[0]._source;
    let contents;
    try {
      contents = await send('maildir_read_attachments', {
        accountId, mailbox, uid, attachmentIndices: group.map(att => att._source.attachmentIndex),
      });
    } catch {
      throw unavailable(group[0]);
    }
    group.forEach((att, i) => {
      if (typeof contents?.[i] !== 'string') throw unavailable(att);
      filled.set(att, contents[i]);
    });
  }
  return attachments.map(att => (filled.has(att) ? { ...att, content: filled.get(att) } : att));
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
