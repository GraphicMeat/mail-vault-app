// ── ChangeServerModal pure helpers — unit tested in isolation from React/store. ──

/**
 * Compare a DNS-detected server suggestion against the account's current
 * hosts. Ports are ignored — DNS detection resolves hosts, not ports, and a
 * host match with a different port isn't a meaningful "unchanged" signal.
 * @param {{imapHost?: string, smtpHost?: string}} current
 * @param {{imapHost?: string, smtpHost?: string}|null} detected
 * @returns {{apply: boolean, unchanged: boolean}}
 */
export function deriveSuggestion(current, detected) {
  if (!detected) return { apply: false, unchanged: false };

  const norm = (v) => (v || '').trim().toLowerCase();
  const same = norm(detected.imapHost) === norm(current?.imapHost)
    && norm(detected.smtpHost) === norm(current?.smtpHost);

  return same ? { apply: false, unchanged: true } : { apply: true, unchanged: false };
}

/**
 * Map a changeServer() error message to which leg failed, for inline display.
 * changeServer() throws `IMAP: ...` / `SMTP: ...` prefixed messages for the
 * respective verification leg; anything else is a general failure.
 * @param {string} message
 * @returns {{leg: 'imap'|'smtp'|'general', text: string}}
 */
export function classifyVerifyError(message) {
  const msg = message || 'Something went wrong';
  if (msg.startsWith('IMAP:')) return { leg: 'imap', text: msg.slice('IMAP:'.length).trim() };
  if (msg.startsWith('SMTP:')) return { leg: 'smtp', text: msg.slice('SMTP:'.length).trim() };
  return { leg: 'general', text: msg };
}

/**
 * Decide which step follows server verification, based on how much local
 * mail exists to restore. No local mail → skip the restore step entirely.
 * @param {{localCount: number}[]} folders
 * @returns {2|3}
 */
export function nextStepAfterVerify(folders) {
  const total = (folders || []).reduce((n, f) => n + (f.localCount || 0), 0);
  return total > 0 ? 2 : 3;
}
