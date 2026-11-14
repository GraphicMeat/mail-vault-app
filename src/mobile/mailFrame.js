// The mail frame's document (Viewer.jsx puts it in a sandboxed iframe's srcdoc). Mail is hostile
// input, and the frame is held by three things, none of which relies on cleaning the mail:
//   - the iframe's sandbox (Viewer.jsx): no scripts, no same origin, popups only;
//   - this CSP, the first element in <head>: nothing loads but inline styles and data: or cid:
//     images (https: images too once the user asked), no script source at all, no form posts;
//   - a pass over the parsed mail that takes out what a CSP does not cover or that could sit
//     before it: refresh and every other http-equiv <meta>, a referrer <meta>, the mail's own
//     <base>, <link> (a dns-prefetch is not governed by the CSP), <script>, <template> (a
//     declarative shadow root the frame would attach), frames and plugins, every `ping`, any
//     link that is not http(s), mailto, tel or an in-page anchor (a `javascript:` popup), SVG
//     and MathML references that leave the document, and every explicit link target, so a link
//     always leaves the frame (`_blank`) instead of loading a page inside it; only an in-page
//     `#anchor` stays in the frame. The pass repeats on a re-parse of its own output until
//     nothing changes (mXSS shapes reshape on a second parse); a mail that never settles, or
//     still holds something forbidden, is shown as text.
// The mail is parsed with DOMParser (scripting off: nothing runs, nothing loads), the CSP, a
// no-referrer policy, DNS prefetch turned off (`x-dns-prefetch-control: off`, so a link's host is
// not resolved ahead of a tap), our <base> and our stylesheet are put in front of everything in
// <head>, and the document is
// serialized again. Whatever the mail has (its own <html>, <head>, a comment first, or none), the
// parser gives it exactly one head, and ours comes first in it.
//
// Link safety: the engine marks each disguised link it listed (`data-link-alert`, core's link scan)
// and the frame wears desktop's warning marks on them. With click confirmation (`markLinks`) every
// marked link loses its URL: it points at the frame's own `about:blank` instead (an exact,
// per-prepare form the cleaner lets through, opened in the frame itself), so a tap only reloads the
// frame. The frame runs no script and the page cannot read where it went, but the iframe's `load`
// event reaches the page, and the mail cannot cause one (none of its links may go to `about:`), so
// Viewer.jsx takes any load after the first as a tap on a marked link: it puts the mail back and
// asks in the app's own sheet, outside the mail's reach (its CSS cannot hide, restyle or overlay
// it), listing the flagged links with their real URLs (`prepared.linkAlerts`). A marked link whose
// URL and level the engine did not list is guarded all the same, never left live. With link safety
// on, a link core's scan cannot read (it reads `a` with a plain `href`) loses its URL: an SVG
// `xlink:href` link and an image map's `<area href>` would otherwise stay live and unchecked.
//
// Theme: a text body follows the app theme. An html body is always drawn on a light canvas:
// without scripts there is no Dark Reader, and mail written for white paper (dark text, no
// background) would be unreadable on dark. The mail's own `prefers-color-scheme: dark` rules
// are disabled for the same reason the desktop reader disables them (emailIframeTemplate.js):
// many flip only backgrounds and leave dark text on a dark card.

import { suppressDarkScheme } from '../shared/darkScheme.js';
import { hasAddressBody, isUrlStart, trimUrl } from '../shared/linkUrls.js';

const CSP_BASE = "default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:";
const CSP_TAIL = "; font-src data:; form-action 'none'";

/** The frame's CSP with remote images blocked. */
export const FRAME_CSP = `${CSP_BASE}${CSP_TAIL}`;

/** The CSP for the frame: https: images only once the user allowed them. */
export function frameCsp(allowRemote) {
  return `${CSP_BASE}${allowRemote ? ' https:' : ''}${CSP_TAIL}`;
}

const THEMES = {
  light: { scheme: 'light', bg: '#f6f7fb', fg: '#1a1a2e', link: '#4338ca' },
  dark: { scheme: 'dark', bg: '#0a0a12', fg: '#e8e8ef', link: '#a5b4fc' },
};
const PAPER = { scheme: 'light', bg: '#ffffff', fg: '#1a1a2e', link: '#4338ca' };

const SAFE_HREF = /^\s*(?:https?:|mailto:|tel:|#)/i;
/** A marked link under click confirmation (`markLinks`): it reloads the frame and goes nowhere.
 *  Only this prepare's own prefix passes (`rules.tap`), so a mail cannot write one of its own. */
const LINK_TAP = /^about:blank#(mv[0-9a-f]{18})-\d+$/;
const isTap = (value, rules) => Boolean(rules.tap) && LINK_TAP.exec(value)?.[1] === rules.tap;
/** What one prepare's cleaning allows beyond the fixed rules: `tap`, its tap prefix (none: no
 *  `about:` link at all); `safety`, link safety is on, so no link the engine's scan cannot see (an
 *  SVG `xlink:href`, an image map's `<area href>`) stays a link. */
const NO_RULES = { tap: null, safety: false };

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A CSS string literal: no quote, backslash, newline or `<` (so never `</style>`) survives raw. */
function cssString(s) {
  const ESC = { '\\': '\\\\', '"': '\\"', '<': '\\3c ', '\n': '\\a ', '\r': '\\d ', '\f': '\\c ' };
  return `"${String(s).replace(/[\\"<\n\r\f]/g, (c) => ESC[c])}"`;
}

// Bare web and mail addresses in a text body. Only these starts are ever linked, so the only
// schemes a link can carry are http, https and mailto.
const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi;
function hrefOf(match) {
  if (/^https?:\/\//i.test(match)) return match;
  if (/^www\./i.test(match)) return `https://${match}`;
  return `mailto:${match}`;
}

/** Plain text as escaped html with its web and mail addresses as links. */
export function linkifyTextHtml(text) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const found = m[0].includes('@') && !isUrlStart(m[0]) ? m[0] : trimUrl(m[0]);
    // `www.` alone, or a match that was all punctuation, is not an address.
    if (!hasAddressBody(found)) continue;
    out += escapeHtml(text.slice(last, m.index));
    out += `<a href="${escapeHtml(hrefOf(found))}" rel="noopener noreferrer">${escapeHtml(found)}</a>`;
    last = m.index + found.length;
  }
  return out + escapeHtml(text.slice(last));
}

/** Desktop's marks on a flagged link (bodyScan.js LINK_ALERT_STYLE). */
const LINK_CSS = [
  'a[data-link-alert]::before{display:inline!important;margin-right:3px!important;font-size:.9em!important}',
  'a[data-link-alert="red"]::before{content:"\\26A0"!important;color:#ef4444!important}',
  'a[data-link-alert="yellow"]::before{content:"\\26A0"!important;color:#f59e0b!important}',
  'a[data-link-alert="red"]{outline:2px solid rgba(239,68,68,.3)!important;outline-offset:2px!important;border-radius:2px!important}',
  'a[data-link-alert="yellow"]{outline:2px solid rgba(245,158,11,.3)!important;outline-offset:2px!important;border-radius:2px!important}',
];

function frameCss({ colors, trackerLabel }) {
  return [
    `:root{color-scheme:${colors.scheme};background:${colors.bg};color:${colors.fg}}`,
    'body{margin:0;padding:12px 16px 24px;font:16px/1.5 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere;-webkit-text-size-adjust:100%}',
    'img,video{max-width:100%;height:auto}',
    'table{max-width:100%}',
    `a{color:${colors.link}}`,
    'pre.mv-text{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit}',
    // The engine's marker for a removed tracking pixel carries no text: it is labelled here.
    `[data-mv-tracker-blocked]::after { content: ${cssString(trackerLabel)} }`,
    ...LINK_CSS,
  ].join('\n');
}

const XLINK = 'http://www.w3.org/1999/xlink';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
/** Gone with everything in them (lower-cased local names): scripts, frames and plugins, a
 *  declarative shadow root (whose children a DOMParser leaves in `template.content`, out of
 *  `querySelectorAll`'s reach, while the frame's own parse would attach them), what can load or
 *  redirect before or beside the CSP, and SVG animation, which can rewrite a link's href at
 *  runtime without any script (`<set attributeName="href" to="javascript:…">`). */
const FORBIDDEN = new Set([
  'template', 'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'fencedframe',
  'base', 'link', 'animate', 'set', 'animatemotion', 'animatetransform', 'discard',
]);
/** Attributes no mail element keeps. */
const STRIPPED = ['ping', 'shadowrootmode', 'shadowroot', 'referrerpolicy', 'attributionsrc', 'formaction', 'formtarget'];
/** A reference an SVG element may keep: inside the document, or an inline image. */
const LOCAL_REF = /^\s*(?:#|data:image\/)/i;
/** `lang` / `dir` on <html> survive only in this shape, so the serialized prefix is predictable. */
const PLAIN_ATTR = /^[A-Za-z0-9-]*$/;

const isReferrerMeta = (el) => el.localName === 'meta' && /^\s*referrer\s*$/i.test(el.getAttribute('name') || '');
const isHtmlLink = (el) => el.namespaceURI === HTML_NS && (el.localName === 'a' || el.localName === 'area');
const isSvgLink = (el) => el.namespaceURI !== HTML_NS && el.namespaceURI !== MATHML_NS && el.localName === 'a';
const isForbidden = (el) => FORBIDDEN.has(el.localName.toLowerCase())
  || (el.localName === 'meta' && el.namespaceURI === HTML_NS && (el.hasAttribute('http-equiv') || isReferrerMeta(el)));

/** Whether an `href` / `xlink:href` (`ns`) value may stay on this element (MathML keeps none:
 *  some engines follow a MathML href like a link). Under link safety a link keeps only what core's
 *  scan reads (`a` with a plain `href`): an `<area>` or an SVG `xlink:href` link was never
 *  checked, so it loses its URL and keeps its text. */
function hrefAllowed(el, value, ns, rules) {
  if (el.namespaceURI === MATHML_NS) return false;
  if (rules.safety && (ns || (isHtmlLink(el) && el.localName === 'area'))) return isSvgLink(el) || isHtmlLink(el) ? false : LOCAL_REF.test(value);
  if (isHtmlLink(el) && isTap(value, rules)) return true;
  return isHtmlLink(el) || isSvgLink(el) ? SAFE_HREF.test(value) : LOCAL_REF.test(value);
}

function hrefsOf(el) {
  const out = [];
  if (el.hasAttribute('href')) out.push(['href', null, el.getAttribute('href')]);
  if (el.hasAttributeNS(XLINK, 'href')) out.push(['href', XLINK, el.getAttributeNS(XLINK, 'href')]);
  return out;
}

/** What the cleaning pass removes, still in `doc`: empty for a clean document. */
function violations(doc, rules) {
  const found = [];
  for (const el of doc.querySelectorAll('*')) {
    if (isForbidden(el)) found.push(el.localName);
    for (const name of STRIPPED) if (el.hasAttribute(name)) found.push(name);
    for (const [, ns, value] of hrefsOf(el)) if (!hrefAllowed(el, value, ns, rules)) found.push(`${el.localName} href`);
  }
  return found;
}

function cleanMail(doc, rules) {
  for (const el of [...doc.querySelectorAll('*')].filter(isForbidden)) el.remove();
  const root = doc.documentElement;
  for (const { name } of [...root.attributes]) {
    if (!['lang', 'dir'].includes(name) || !PLAIN_ATTR.test(root.getAttribute(name))) root.removeAttribute(name);
  }
  for (const { name } of [...doc.head.attributes]) doc.head.removeAttribute(name);
  for (const el of doc.querySelectorAll('*')) {
    for (const name of STRIPPED) el.removeAttribute(name);
    // Only web, mail and phone links and in-page anchors stay links (a `javascript:` or `data:`
    // URL must never reach a popup, which the sandbox lets escape); any other SVG reference
    // stays inside the document.
    for (const [name, ns, value] of hrefsOf(el)) {
      if (hrefAllowed(el, value, ns, rules)) continue;
      if (ns) el.removeAttributeNS(ns, name);
      else el.removeAttribute(name);
    }
    if (!isHtmlLink(el) && !isSvgLink(el)) continue;
    const href = el.getAttribute('href') ?? el.getAttributeNS(XLINK, 'href');
    if (href != null && (/^\s*#/.test(href) || isTap(href, rules))) {
      // An in-page anchor (a newsletter's table of contents) scrolls the frame; it loads nothing.
      el.setAttribute('target', '_self');
    } else if (href != null) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    } else {
      el.removeAttribute('target');
    }
  }
  for (const form of doc.querySelectorAll('form')) form.setAttribute('target', '_blank');
  for (const style of doc.querySelectorAll('style')) {
    style.textContent = suppressDarkScheme(style.textContent);
    const media = style.getAttribute('media');
    if (media) style.setAttribute('media', suppressDarkScheme(media));
  }
}

const parseHtml = (source) => new DOMParser().parseFromString(source, 'text/html');
const serialize = (doc) => `<!doctype html>${doc.documentElement.outerHTML}`;

const LEVELS = new Set(['red', 'yellow']);

/** A fresh, unguessable prefix for one prepare's link taps. */
function tapPrefix() {
  const bytes = new Uint8Array(9);
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `mv${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Whether `markLinks` has anything to do: a string check, so a clean mail is parsed no more. */
const hasLinkMarks = (html) => /data-link-alert/i.test(html);

/**
 * The mail with link safety applied, before it is cleaned (so it is cleaned and checked like the
 * rest), and the flagged links the app's sheet lists: `{source, alerts}`. With `confirm`, every
 * marked link (`data-link-alert`) is guarded: its URL and title go, and it points at `about:blank`
 * in the frame itself. It is listed with the engine's alert for its URL and level (several links
 * may share a URL, at any level), or, when the engine listed none for it, as red with its own URL
 * and no reason: a mark never fails open. Without `confirm` the marks only show.
 */
function markLinks(html, { alerts, confirm = false }, parse) {
  if (!confirm) return { source: html, alerts: [], tap: null };
  const doc = parse(html);
  const listed = new Map(); // `${level} ${url}` -> the engine's alert
  for (const a of Array.isArray(alerts) ? alerts : []) {
    if (a && typeof a.actualUrl === 'string' && LEVELS.has(a.level)) listed.set(`${a.level} ${a.actualUrl}`, a);
  }
  const shown = new Map(); // the same key -> what the sheet lists, once each
  const prefix = tapPrefix();
  let n = 0;
  for (const link of doc.querySelectorAll('[data-link-alert]')) {
    const mark = link.getAttribute('data-link-alert');
    const level = LEVELS.has(mark) ? mark : 'red';
    const href = link.getAttribute('href') ?? '';
    const key = `${level} ${href}`;
    if (!shown.has(key)) {
      const alert = listed.get(key);
      shown.set(key, {
        level,
        actualUrl: href,
        textContent: (alert?.textContent ?? link.textContent ?? '').trim(),
        reason: alert?.reason ?? '',
      });
    }
    link.setAttribute('data-link-alert', level);
    link.setAttribute('href', `about:blank#${prefix}-${n++}`);
    link.removeAttribute('title');
  }
  return { source: serialize(doc), alerts: [...shown.values()], tap: prefix };
}
const MAX_PASSES = 4;

/**
 * The mail's html cleaned until a parse of the serialization gives back the same serialization
 * (the frame parses the string, not our DOM, and some markup reshapes itself on a second parse).
 * Every pass serializes with a doctype, so it is parsed in no-quirks mode as the frame parses
 * it. `null` when it never settles or something forbidden is still there. `parse` is for tests.
 */
export function cleanToFixpoint(source, parse = parseHtml, rules = NO_RULES) {
  let previous = null;
  let current = source;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const doc = parse(current);
    cleanMail(doc, rules);
    previous = current;
    current = serialize(doc);
    if (current === previous) break;
  }
  if (current !== previous) return null;
  return violations(parse(current), rules).length === 0 ? current : null;
}

/** The text of a mail the cleaner refused: its text part, else what its html says, as text. */
function fallbackText(html, text) {
  if (typeof text === 'string' && text.trim()) return text;
  const doc = parseHtml(html);
  for (const el of doc.querySelectorAll('script, style, template, title, noscript')) el.remove();
  return doc.body?.textContent?.trim() ?? '';
}

const textMarkup = (text) =>
  `<!doctype html><html><head></head><body><pre class="mv-text">${linkifyTextHtml(text)}</pre></body></html>`;
/** A cleaned document starts exactly like this; our head goes right after the match. */
const PREFIX = /^<!doctype html><html(?: (?:lang|dir)="[A-Za-z0-9-]*")*><head>/;

/** Our part of <head>, in the order the frame must see it: the CSP first. */
function frameHead(prepared, { allowRemote = false, theme = 'light', trackerLabel = '' }) {
  const colors = prepared.kind === 'html' ? PAPER : THEMES[theme] || THEMES.light;
  return `<meta http-equiv="Content-Security-Policy" content="${frameCsp(allowRemote)}">`
    + '<meta name="referrer" content="no-referrer"><meta http-equiv="x-dns-prefetch-control" content="off">'
    + '<base target="_blank">'
    + `<style data-mv-frame="">${frameCss({ colors, trackerLabel })}</style>`;
}

/** Puts our head into a prepared body: string work only, no parse. */
export function assembleMailFrame(prepared, options = {}) {
  const at = prepared.markup.match(PREFIX)[0].length;
  return prepared.markup.slice(0, at) + frameHead(prepared, options) + prepared.markup.slice(at);
}

/** Whether the frame's parse of an assembled document is exactly ours and clean: our five head
 *  elements first, nothing forbidden anywhere else. */
function assembledClean(doc, rules) {
  const [csp, referrer, dns, base, style] = doc.head.children;
  const ours = csp?.getAttribute('http-equiv') === 'Content-Security-Policy'
    && referrer?.getAttribute('name') === 'referrer' && referrer.getAttribute('content') === 'no-referrer'
    && dns?.localName === 'meta' && dns.getAttribute('http-equiv') === 'x-dns-prefetch-control' && dns.getAttribute('content') === 'off'
    && base?.localName === 'base' && base.attributes.length === 1 && base.getAttribute('target') === '_blank'
    && style?.localName === 'style' && style.hasAttribute('data-mv-frame');
  if (!ours) return false;
  for (const el of [csp, referrer, dns, base]) el.remove();
  return violations(doc, rules).length === 0;
}

/**
 * The expensive half, once per message body (Viewer.jsx memoizes it on the body): the cleaned
 * html, checked once more as the frame will parse the assembled document, or the text part (or,
 * for an html body the cleaner cannot settle, what that html says) escaped into a `<pre>`.
 * Assembling with other options changes only our own constant head strings. `links`:
 * `{alerts, confirm, safety}` for link safety (`markLinks`; `safety`: link safety is on, so no link
 * the engine's scan cannot see stays live), or null; `linkAlerts` then lists what a tap on a
 * guarded link asks about.
 */
export function prepareMailBody({ html, text }, parse = parseHtml, links = null) {
  if (typeof html === 'string' && html.trim() !== '') {
    const marked = links && hasLinkMarks(html) ? markLinks(html, links, parse) : { source: html, alerts: [], tap: null };
    const rules = { tap: marked.tap, safety: Boolean(links?.safety) };
    const cleaned = cleanToFixpoint(marked.source, parse, rules);
    if (cleaned != null && PREFIX.test(cleaned)) {
      const prepared = { kind: 'html', markup: cleaned, linkAlerts: marked.alerts };
      if (assembledClean(parse(assembleMailFrame(prepared)), rules)) return prepared;
    }
    return { kind: 'text', markup: textMarkup(fallbackText(html, text)) };
  }
  return { kind: 'text', markup: textMarkup(typeof text === 'string' ? text : '') };
}

/**
 * The frame's whole document for one message body: `html` if it has any, else `text` escaped
 * into a `<pre>`. `allowRemote` adds https: to the image sources; `theme` ('light' | 'dark') is
 * the app's. `trackerLabel` names the engine's tracker marker in the UI language.
 */
export function buildMailFrame({ html, text, allowRemote = false, theme = 'light', trackerLabel = '', links = null, parse = parseHtml }) {
  return assembleMailFrame(prepareMailBody({ html, text }, parse, links), { allowRemote, theme, trackerLabel });
}
