const _dec = (s) => {
  // RFC 6068: every octet is percent-encoded and '+' is literal — NOT a space,
  // so URLSearchParams (form-urlencoded rules) would eat the plus out of
  // addresses like `rokas+lists@example.com`.
  try { return decodeURIComponent(s); } catch { return s; }
};

const _addresses = (s) => s.split(',').map(a => a.trim()).filter(Boolean).join(', ');

const _escapeHtml = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Parse a `mailto:` href into ComposeModal's `initialData` shape.
 *
 * Returns null for anything that is not a mailto: URI. `body` comes back as
 * HTML because that is what compose loads into the editor — and it is escaped
 * on the way, since the href came out of someone else's email.
 */
export function parseMailto(href, accountId) {
  if (typeof href !== 'string') return null;
  const m = /^mailto:([^?]*)(?:\?([\s\S]*))?$/i.exec(href.trim());
  if (!m) return null;

  const fields = { to: _addresses(_dec(m[1])), cc: '', bcc: '', subject: '', body: '' };
  for (const pair of (m[2] || '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = _dec(eq === -1 ? pair : pair.slice(0, eq)).trim().toLowerCase();
    const value = eq === -1 ? '' : _dec(pair.slice(eq + 1));
    if (key === 'to') fields.to = _addresses([fields.to, value].filter(Boolean).join(','));
    else if (key === 'cc' || key === 'bcc') fields[key] = _addresses(value);
    else if (key === 'subject' || key === 'body') fields[key] = value;
    // Every other header (RFC 6068 allows arbitrary ones) is dropped: compose
    // has no field for them and a silent one would leave the sender guessing.
  }

  return {
    ...fields,
    body: fields.body ? _escapeHtml(fields.body).replace(/\r?\n/g, '<br>') : '',
    // A prefill is a fresh compose, not a restored draft: it records its own
    // dirty-check baseline so closing it untouched asks nothing.
    _prefill: true,
    // Which account the message carrying the link arrived on, so the reply
    // leaves from the address it was addressed to. Only unified-inbox rows
    // carry one; without it compose falls back to its usual precedence.
    ...(accountId ? { _accountId: accountId } : {}),
  };
}

