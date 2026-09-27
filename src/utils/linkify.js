import { splitAddresses } from './mailto';

// Bare web addresses in mail text. Only these two starts are ever linked, so
// the only schemes a new link can carry are http, https and mailto.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'"]$/;
const PAIRS = { ')': '(', ']': '[', '}': '{' };
// Text in these is code, a style sheet, a script, a field, or already a link.
const SKIP = 'a,code,pre,style,script,textarea,title,noscript,button,select,option';

const count = (s, ch) => s.split(ch).length - 1;

/// A match with the sentence it sits in trimmed off: `see https://x.com/a.`
/// ends at `a`, and `(https://x.com/a)` keeps no `)` it did not open.
function trimUrl(url) {
  for (;;) {
    const last = url.at(-1);
    if (TRAILING.test(last)) url = url.slice(0, -1);
    else if (PAIRS[last] && count(url, last) > count(url, PAIRS[last])) url = url.slice(0, -1);
    else return url;
  }
}

const hrefFor = url => (/^www\./i.test(url) ? `https://${url}` : url);

/**
 * Text as runs `{ text, href }`, `href` null for plain text. Joining the
 * `text` fields gives the input back exactly. Web addresses first, then email
 * addresses in what is left, so an address inside a URL stays part of it.
 */
export function linkifyText(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const plain = chunk => {
    for (const seg of splitAddresses(chunk)) out.push({ text: seg.text, href: seg.address ? `mailto:${seg.address}` : null });
  };
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    // `www.` alone, or a match that was all punctuation, is not an address.
    if (!/[a-z0-9]/i.test(url.replace(/^(?:https?:\/\/|www\.)/i, ''))) continue;
    if (m.index > last) plain(text.slice(last, m.index));
    out.push({ text: url, href: hrefFor(url) });
    last = m.index + url.length;
  }
  if (last < text.length) plain(text.slice(last));
  return out;
}

/// The whole text is one link and nothing else: its href, else null.
function soleHref(text) {
  const runs = linkifyText(text.trim());
  return runs.length === 1 ? runs[0].href : null;
}

/**
 * An email body with its bare web and email addresses made into links, and an
 * `<a>` that has no href but whose text is an address given one.
 *
 * Built with DOM nodes, never by pasting strings, so no character of the mail
 * can become markup. The links land in the body before the link-safety scan
 * and go through the frames' own click handler, like any link the sender wrote.
 * The input comes back untouched (the same string) when nothing needed a link.
 */
export function linkifyHtml(html) {
  if (!html || typeof DOMParser === 'undefined' || !/https?:\/\/|www\.|@/i.test(html)) return html;
  // Wrapped the way scanEmailLinks parses it: without a <body>, a leading
  // <style> would be parsed into <head> and lost on the way back out.
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
  let changed = false;

  for (const a of doc.body.querySelectorAll('a:not([href])')) {
    const href = soleHref(a.textContent || '');
    if (href) { a.setAttribute('href', href); changed = true; }
  }

  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest(SKIP)) nodes.push(node);
  }
  for (const node of nodes) {
    const runs = linkifyText(node.nodeValue);
    if (!runs.some(run => run.href)) continue;
    const fragment = doc.createDocumentFragment();
    for (const run of runs) {
      if (!run.href) { fragment.append(doc.createTextNode(run.text)); continue; }
      const a = doc.createElement('a');
      a.setAttribute('href', run.href);
      a.textContent = run.text;
      fragment.append(a);
    }
    node.replaceWith(fragment);
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}
