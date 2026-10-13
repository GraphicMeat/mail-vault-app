// One rule for what a click on a link in a message body does, shared by the
// iframe reader and the Blitz renderer so the two can never drift.
//
// Returns 'compose' (mailto: handled in-app), 'alert' (link-safety modal
// raised, nothing opened), 'opened' (handed to openUrl) or 'ignored' (the
// caller leaves the click alone: anchors, cid:, tel:, empty).
export function activateEmailLink(link, { accountId, linkSafetyEnabled, linkSafetyClickConfirm, openMailtoCompose, setLinkSafetyAlert, openUrl }) {
  const href = link?.href || '';
  if (!href) return 'ignored';
  // Schemes are case-insensitive. The iframe handler is handed the DOM's normalised
  // href; the Blitz worker returns the attribute as written (MAILTO:, Tel:).
  const lower = href.toLowerCase();
  // An address in the body composes here instead of waking the OS mail
  // client, which is not the vault this message lives in.
  if (lower.startsWith('mailto:')) { openMailtoCompose(href, accountId); return 'compose'; }
  if (lower.startsWith('cid:') || lower.startsWith('tel:') || lower.startsWith('#')) return 'ignored';
  if (linkSafetyEnabled && linkSafetyClickConfirm && link.alert) {
    setLinkSafetyAlert({ level: link.alert, textContent: (link.text || '').trim(), actualUrl: href, reason: link.title || '' });
    return 'alert';
  }
  openUrl(href);
  return 'opened';
}

export function openExternalUrl(url) {
  import('@tauri-apps/plugin-shell').then(({ open }) => open(url)).catch(() => window.open(url, '_blank'));
}
