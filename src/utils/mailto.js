// ── mailto: links in a message body open compose, not the OS mail client ──
//
// The body renders in an iframe, so its click handler cannot reach App's
// compose state directly. Same seam services/localDrafts.js uses for reopening
// a draft row: App registers the opener, this module hands it the prefill.

let _opener = null;

export function setMailtoComposeOpener(fn) { _opener = fn; }

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

/**
 * Open compose prefilled from a `mailto:` href. False when the href is not a
 * mailto: or no compose surface is mounted — the caller falls back to whatever
 * it did before.
 */
export function openMailtoCompose(href, accountId) {
  const initialData = parseMailto(href, accountId);
  if (!initialData || !_opener) return false;
  _opener(initialData);
  return true;
}

// ── Addresses printed in a plain-text body ──────────────────────────────────
//
// A text/plain message has no anchors: an address in it is characters. These
// split one into linkable runs so the reader can click it like any other
// address in the app.

// Deliberately conservative. Over-matching turns ordinary prose into links,
// which is worse than missing an exotic address: the local part is the common
// subset, and the last label must be alphabetic so a trailing "." or "," in a
// sentence stays punctuation.
const ADDRESS_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;

/**
 * Split text into runs: `{ text, address }` with `address` null for the parts
 * that are not one. Always covers the whole input, in order, so joining the
 * `text` fields returns the original string exactly.
 */
export function splitAddresses(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  let last = 0;
  for (const m of text.matchAll(ADDRESS_RE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), address: null });
    out.push({ text: m[0], address: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), address: null });
  return out;
}

/**
 * The same thing as an HTML fragment, for the one plain-text body that renders
 * inside an iframe rather than as React children (FullViewEmailModal). Escaped
 * here because nothing downstream will do it.
 */
export function addressesToHtml(text) {
  return splitAddresses(text)
    .map(seg => seg.address
      ? `<a href="mailto:${encodeURI(seg.address)}">${_escapeHtml(seg.text)}</a>`
      : _escapeHtml(seg.text))
    .join('');
}

// ── mailto: handed over by the OS ───────────────────────────────────────────

/**
 * Bridges `mailto:` URLs the OS hands to the app into compose.
 *
 * The queue in Rust is the source of truth, not the event payload: when the
 * click *launches* the app the URL is queued before this webview exists, so a
 * listener alone would drop the first mailto of every cold start. The event is
 * only a wake-up — every path drains the same queue.
 *
 * Returns `stop` synchronously so a React cleanup can detach without awaiting,
 * and `ready` for tests and anyone who needs the first drain to have landed.
 */
export function startMailtoBridge({ invoke, listen }) {
  let active = true;
  let unlisten = null;

  const drain = async () => {
    const urls = await invoke('take_pending_mailto');
    for (const url of urls || []) openMailtoCompose(url);
  };

  const ready = listen('mailto-open', drain)
    .then(fn => {
      // Stopped while `listen` was still in flight: detach immediately rather
      // than leaving a handler nobody holds a reference to.
      if (!active) fn();
      else unlisten = fn;
    })
    .then(() => (active ? drain() : undefined));

  return {
    ready,
    stop: () => { active = false; if (unlisten) unlisten(); },
  };
}
