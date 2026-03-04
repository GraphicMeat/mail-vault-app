/**
 * Filter attachments to only "real" ones (exclude inline embedded images
 * referenced in the HTML body, and tiny tracking pixels).
 *
 * Each returned attachment gets an `_originalIndex` property that maps back
 * to its position in the original `attachments` array — needed for on-demand
 * lazy loading via `maildir_read_attachment`.
 */
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
 * Determine whether an email has real (non-inline) attachments.
 * Used by the store to update `hasAttachments` on list items.
 */
export function hasRealAttachments(email) {
  if (!email?.attachments?.length) return false;
  return getRealAttachments(email.attachments, email.html).length > 0;
}
