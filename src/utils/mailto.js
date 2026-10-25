import { prepareMailto } from '../services/composePrep';
// ── mailto: links in a message body open compose, not the OS mail client ──
//
// The body renders in an iframe, so its click handler cannot reach App's
// compose state directly. Same seam services/localDrafts.js uses for reopening
// a draft row: App registers the opener, this module hands it the prefill.

const _escapeHtml = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
let _opener = null;
let openerGeneration = 0;
let onError = null;
let bridgeOwner = null;
const pendingIntents = [];
let work = Promise.resolve();
const isMailto = href => typeof href === 'string' && /^mailto:/i.test(href.trim());
const serialized = task => {
  const result = work.then(task);
  work = result.catch(() => {});
  return result;
};
async function deliver(owner = bridgeOwner) {
  const opener = _opener;
  const generation = openerGeneration;
  const current = () => Boolean(opener && opener === _opener && generation === openerGeneration
    && (!owner || owner === bridgeOwner && owner.active));
  while (pendingIntents.length && current()) {
    const intent = pendingIntents[0];
    if (intent.shell && !owner) return;
    const result = await prepareMailto(intent.href, intent.accountId, { isCurrent: current });
    if (!current()) return;
    if (result.initialData) await opener(result.initialData);
    if (!current()) return;
    pendingIntents.shift();
  }
}
export function retryMailtoCompose() {
  return serialized(() => deliver()).catch(error => { onError?.(error); throw error; });
}

export function setMailtoComposeOpener(fn, options = {}) { _opener = fn; openerGeneration++; onError = options.onError || null; }

export { parseMailto } from './mailtoPolicy';

/**
 * Open compose prefilled from a `mailto:` href. False when the href is not a
 * mailto: or no compose surface is mounted — the caller falls back to whatever
 * it did before.
 */
export function openMailtoCompose(href, accountId) {
  if (!isMailto(href) || !_opener) return false;
  pendingIntents.push({ href, accountId, shell: false });
  void retryMailtoCompose().catch(() => {});
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
 * The first address in a recipient field ("Bob <bob@x.com>, amy@y.com") and
 * the display name typed before it, if any: `{ address, name }` or null.
 */
export function firstRecipient(text) {
  const runs = splitAddresses(text);
  const at = runs.findIndex(r => r.address);
  if (at < 0) return null;
  const name = at > 0 ? runs[at - 1].text.replace(/^[\s,"]+|[\s"<]+$/g, '') : '';
  return { address: runs[at].address, name };
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

/**
 * A text/plain body as the fragment a frame renders. FullViewEmailModal and the
 * export share it: the export used to read `html` alone, so a message that
 * only ever had text (a contact form, most replies) came out as an empty card.
 */
// A <div>, not a <pre>: the reader's linkify skips <pre> as code, and a web
// address in a text/plain message has to become a link like one in HTML.
export function plainTextBodyHtml(text) {
  return `<div style="white-space: pre-wrap; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0;">${addressesToHtml(text || '')}</div>`;
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
export function startMailtoBridge({ invoke, listen, onError: reportError }) {
  const owner = { active: true };
  bridgeOwner = owner;
  let unlisten = null;
  const current = () => owner.active && bridgeOwner === owner;
  const drain = () => serialized(async () => {
    if (!current()) return;
    const urls = await invoke('take_pending_mailto');
    // take is destructive: retain accepted occurrences even if stop raced it.
    for (const href of urls || []) if (isMailto(href)) pendingIntents.push({ href, shell: true });
    if (!current()) return;
    await deliver(owner);
  });
  const report = error => { if (current()) (reportError || onError)?.(error); };
  const ready = Promise.resolve().then(() => listen('mailto-open', () => drain().catch(report)))
    .then(fn => {
      if (!current()) fn();
      else unlisten = fn;
    }).then(() => current() ? drain() : undefined);
  // Keep rejection observable to the owner while preventing unhandled loss.
  void ready.catch(report);
  return { ready, retry: () => drain().catch(report), stop: () => {
    owner.active = false;
    if (bridgeOwner === owner) bridgeOwner = null;
    unlisten?.();
  } };
}
