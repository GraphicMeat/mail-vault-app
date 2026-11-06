// The mail frame's document (Viewer.jsx puts it in a sandboxed iframe's srcdoc). Mail is hostile
// input, and the frame is held by three things, none of which relies on cleaning the mail:
//   - the iframe's sandbox (Viewer.jsx): no scripts, no same origin, popups only;
//   - this CSP, the first element in <head>: nothing loads but inline styles and data: or cid:
//     images (https: images too once the user asked), no script source at all, no form posts;
//   - a pass over the parsed mail that takes out what a CSP does not cover or that could sit
//     before it: refresh and every other http-equiv <meta>, the mail's own <base>, <link>
//     (a dns-prefetch is not governed by the CSP), <script>, link `ping` attributes, any link
//     that is not http(s), mailto, tel or an in-page anchor (a `javascript:` popup), and every
//     explicit link target, so a link always leaves the frame (`_blank`, the system browser)
//     instead of loading a page inside it; only an in-page `#anchor` stays in the frame.
// The mail is parsed with DOMParser (scripting off: nothing runs, nothing loads), the CSP, our
// <base> and our stylesheet are put in front of everything in <head>, and the document is
// serialized again. Whatever the mail has (its own <html>, <head>, a comment first, or none), the
// parser gives it exactly one head, and ours comes first in it.
//
// Theme: a text body follows the app theme. An html body is always drawn on a light canvas:
// without scripts there is no Dark Reader, and mail written for white paper (dark text, no
// background) would be unreadable on dark. The mail's own `prefers-color-scheme: dark` rules
// are disabled for the same reason the desktop reader disables them (emailIframeTemplate.js):
// many flip only backgrounds and leave dark text on a dark card.

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

const DARK_SCHEME_FEATURE = /prefers-color-scheme(\s*:\s*)dark/gi;
const SUPPRESSED = 'mv-suppressed-color-scheme$1dark';

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
const TRAILING = /[.,;:!?'"]$/;
const PAIRS = { ')': '(', ']': '[', '}': '{' };
const count = (s, ch) => s.split(ch).length - 1;

function trimUrl(url) {
  for (;;) {
    const last = url.at(-1);
    if (TRAILING.test(last)) url = url.slice(0, -1);
    else if (PAIRS[last] && count(url, last) > count(url, PAIRS[last])) url = url.slice(0, -1);
    else return url;
  }
}

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
    const found = m[0].includes('@') && !/^(?:https?:\/\/|www\.)/i.test(m[0]) ? m[0] : trimUrl(m[0]);
    // `www.` alone, or a match that was all punctuation, is not an address.
    if (!/[a-z0-9]/i.test(found.replace(/^(?:https?:\/\/|www\.)/i, ''))) continue;
    out += escapeHtml(text.slice(last, m.index));
    out += `<a href="${escapeHtml(hrefOf(found))}" rel="noopener noreferrer">${escapeHtml(found)}</a>`;
    last = m.index + found.length;
  }
  return out + escapeHtml(text.slice(last));
}

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
  ].join('\n');
}

function cleanMail(doc) {
  for (const el of doc.querySelectorAll('meta[http-equiv], base, link, script')) el.remove();
  for (const a of doc.querySelectorAll('a, area')) {
    a.removeAttribute('ping');
    // Only web, mail and phone links and in-page anchors stay links: a `javascript:` or `data:`
    // URL must never reach a popup, which the sandbox lets escape.
    if (a.hasAttribute('href') && !SAFE_HREF.test(a.getAttribute('href'))) a.removeAttribute('href');
    if (/^\s*#/.test(a.getAttribute('href') || '')) {
      // An in-page anchor (a newsletter's table of contents) scrolls the frame; it loads nothing.
      a.setAttribute('target', '_self');
    } else if (a.hasAttribute('href')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('target');
    }
  }
  for (const form of doc.querySelectorAll('form')) form.setAttribute('target', '_blank');
  for (const style of doc.querySelectorAll('style')) {
    style.textContent = style.textContent.replace(DARK_SCHEME_FEATURE, SUPPRESSED);
    const media = style.getAttribute('media');
    if (media) style.setAttribute('media', media.replace(DARK_SCHEME_FEATURE, SUPPRESSED));
  }
}

/**
 * The frame's whole document for one message body: `html` if it has any, else `text` escaped
 * into a `<pre>`. `allowRemote` adds https: to the image sources; `theme` ('light' | 'dark') is
 * the app's. `trackerLabel` names the engine's tracker marker in the UI language.
 */
export function buildMailFrame({ html, text, allowRemote = false, theme = 'light', trackerLabel = '' }) {
  const isHtml = typeof html === 'string' && html.trim() !== '';
  const source = isHtml ? html : `<pre class="mv-text">${linkifyTextHtml(typeof text === 'string' ? text : '')}</pre>`;
  const doc = new DOMParser().parseFromString(source, 'text/html');
  if (isHtml) cleanMail(doc);

  const head = doc.head;
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', frameCsp(allowRemote));
  const base = doc.createElement('base');
  base.setAttribute('target', '_blank');
  const style = doc.createElement('style');
  style.setAttribute('data-mv-frame', '');
  style.textContent = frameCss({ colors: isHtml ? PAPER : THEMES[theme] || THEMES.light, trackerLabel });
  head.prepend(csp, base, style);

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
