import { t } from '../i18n/index.js';
// Shared iframe template for rendering HTML email bodies.
//
// Baseline is always LIGHT (white bg, dark text). This gives Dark Reader a
// clean set of colors to invert from when the app is in dark mode. We also
// force `color-scheme: light` so the OS-level prefers-color-scheme doesn't
// partially activate some emails' own dark variants — Dark Reader is the
// single source of truth for dark mode.
//
// Kept separate from ChatBubbleView's iframe (transparent bg, per-bubble tint).

// Only unwrap when the string really is a whole document. A reply that quotes
// another mail carries the quoted message's <html><body> *inside* a blockquote —
// unwrapping that returns the quote and drops what the sender actually wrote.
// Greedy match so a nested </body> can't truncate a genuine document either.
const DOC_START = /^\s*(?:<!doctype[^>]*>|<\?xml[^>]*\?>|<!--[\s\S]*?-->|\s)*<(?:html|head|body)[\s>]/i;

export function getEmailBodyContent(html) {
  if (!html) return '';
  if (!DOC_START.test(html)) return html;
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : html;
}

// Dark Reader overrides inline styles from a stylesheet rule
// (`[data-darkreader-inline-color] { color: var(--darkreader-inline-color) !important }`).
// An `!important` declaration in the element's own `style` attribute outranks
// that rule — element-attached styles win over style rules of the same origin
// and importance — so a mail shipping `style="color:#000 !important"` keeps
// black text on Dark Reader's dark background and reads as invisible.
//
// Drop the priority from colour-carrying inline declarations only (dark mode
// only), so Dark Reader can win. Layout `!important`s are left alone: emails
// use them to beat webmail stylesheets, and removing them changes light mode.
const IMPORTANT_DECL = /(^|;)(\s*)([-a-zA-Z]+)(\s*:\s*[^;]*?)\s*!\s*important\s*(?=;|$)/g;
const COLOR_PROP = /(?:^|-)color$|^(?:background|fill|stroke)$/i;

export function stripInlineColorImportant(html) {
  if (!html || html.indexOf('!important') === -1) return html;
  const dropPriority = (css) => css.replace(
    IMPORTANT_DECL,
    (decl, sep, pad, prop, value) => (COLOR_PROP.test(prop) ? `${sep}${pad}${prop}${value}` : decl)
  );
  return html
    .replace(/style\s*=\s*"([^"]*)"/gi, (_m, css) => `style="${dropPriority(css)}"`)
    .replace(/style\s*=\s*'([^']*)'/gi, (_m, css) => `style='${dropPriority(css)}'`);
}

// Content height of an email iframe document, VALID ONLY WITH THE FRAME
// COLLAPSED. That precondition is the whole contract — see
// attachEmailIframeAutoSize, the only caller.
//
// At its real height the frame cannot be measured against itself. The root box
// is never smaller than the frame's own viewport, and a body sized in `%` or
// `vh` (`html, body { height: 100% }` is standard email boilerplate) is not
// either: both report the number we last wrote, so every pass adds `pad` again
// and the frame grows without end.
//
// What breaks that loop is measuring at a height we did NOT derive from the
// content — not reaching zero. The caller writes `1px`, but the frame's own
// inline `min-height` (300 in the viewer, 100 in a thread) floors it there, so
// a `%` body reports that same floor on every pass instead of the number we
// just wrote, and the height settles. Don't "fix" the floor away on the
// strength of the word collapsed: a real 1px frame would be a much larger
// shrink for the pane's scroll position to survive, and that is measured
// behaviour, not theory.
//
// Read the ROOT box, not the body box. Half the page inset sits on `html`, and
// a first child's margin collapses through a mail's own `body{margin:0}` and
// out of the body box entirely — both are inside the root box and outside the
// body's, and both left the document taller than the frame it was sized to.
export function measureCollapsedEmailIframeHeight(doc) {
  const root = doc?.documentElement;
  if (!root) return 0;
  return Math.ceil(Math.max(
    root.getBoundingClientRect?.().height || 0,
    root.scrollHeight || 0,
    root.offsetHeight || 0
  ));
}

// Keep an email frame exactly as tall as its document, for its whole life.
//
// The reading pane is the one scroller. A frame that is shorter than its own
// document scrolls internally — a scrollbar inside the pane's scrollbar. Load
// events and a couple of timers can't hold that: images finishing decode,
// remote images, web fonts and Dark Reader all change the height seconds after
// the last timer would have fired. A ResizeObserver on the body follows all of
// them, so the timers are gone.
//
// Every measure collapses the frame first, so the document is never measured
// against a height we wrote ourselves — see measureCollapsedEmailIframeHeight.
//
// Returns a detach function. `pad` covers sub-pixel rounding in the measure.
export function attachEmailIframeAutoSize(iframe, { minHeight = 0, pad = 8 } = {}) {
  if (!iframe) return () => {};
  let observer = null;
  let applied = -1;
  let measuring = false;

  const docOf = () => {
    try {
      return iframe.contentDocument || iframe.contentWindow?.document || null;
    } catch {
      return null; // frame detached or not same-origin yet
    }
  };

  // Collapse, measure, apply — one synchronous block. Reading layout forces
  // style and layout, not a paint, so nothing renders at the collapsed height
  // and there is no flicker. Same trick the HTML export uses
  // (services/export/exportHtml.js). The frame's inline `min-height` floors
  // the collapse — see measureCollapsedEmailIframeHeight for why that is the
  // property that matters, and why it is fine.
  const measure = () => {
    // The collapse resizes the body we observe. A synchronous delivery would
    // re-enter here with the frame still collapsed and never come back out.
    if (measuring) return;
    const doc = docOf();
    if (!doc?.documentElement) return;
    measuring = true;
    const was = iframe.style.height;
    // A pane that shrinks clamps its own scrollTop, and the restore does not
    // bring it back — without this the reader is thrown to the top of the
    // message every time a late image resizes the frame.
    const scrolled = [];
    for (let el = iframe.parentElement; el; el = el.parentElement) {
      if (el.scrollTop) scrolled.push([el, el.scrollTop]);
    }
    try {
      iframe.style.height = '1px';
      const height = measureCollapsedEmailIframeHeight(doc);
      const next = height ? Math.max(height + pad, minHeight) : 0;
      // Only write on a real change; otherwise put back exactly what we
      // collapsed from.
      if (!next || next === applied) {
        iframe.style.height = was;
      } else {
        applied = next;
        iframe.style.height = next + 'px';
      }
    } finally {
      scrolled.forEach(([el, top]) => { el.scrollTop = top; });
      measuring = false;
    }
  };

  // Re-point the observer at whichever document the frame is showing now.
  const observe = () => {
    const body = docOf()?.body;
    if (!body) return;
    observer?.disconnect();
    const Observer = globalThis.ResizeObserver;
    if (!Observer) return;
    observer = new Observer(measure);
    observer.observe(body);
  };

  const onLoad = () => { applied = -1; observe(); measure(); };

  // The quote/signature fold scripts post from inside the frame when the user
  // folds something. The height they report is their own body box, taken at
  // the frame's current height — take the message as a signal and measure it
  // ourselves. Without the source check, one message's fold resized every
  // other frame on screen: thread view mounts one per message.
  const onMessage = (e) => {
    if (e.source !== iframe.contentWindow) return;
    if (e.data?.type === 'iframe-resize') measure();
  };

  iframe.addEventListener('load', onLoad);
  window.addEventListener('message', onMessage);
  observe();
  measure();

  return () => {
    iframe.removeEventListener('load', onLoad);
    window.removeEventListener('message', onMessage);
    observer?.disconnect();
    observer = null;
  };
}

// Build a complete HTML document for an email iframe.
//
// opts:
//   bodyHtml   — inner body HTML (already CID-resolved, script-free, etc.)
//   themeTag   — 'dark' | 'light'. Stamped into the document so srcDoc differs
//                per theme (forces iframe reload on theme switch so DR can
//                re-inject cleanly). Does NOT change the baseline colors.
//   extraHead  — optional raw HTML appended inside <head> (e.g. Dark Reader
//                script for standalone popup windows)
//   extraBody  — optional raw HTML appended inside <body> (e.g. fold scripts)
//   tableMode  — 'preserve' (let emails own their table layout, default)
//              | 'clip'    (legacy: table-layout:fixed to clip overflow)
export function buildEmailIframeHtml({ bodyHtml, themeTag = 'light', extraHead = '', extraBody = '', tableMode = 'preserve' } = {}) {
  const tableCss = tableMode === 'clip'
    ? 'table { table-layout: fixed; width: 100% !important; overflow: hidden; } td, th { overflow: hidden; text-overflow: ellipsis; }'
    : 'table { max-width: 100% !important; width: auto !important; }';

  // Inline `!important` colours outrank Dark Reader's override sheet — strip
  // their priority when DR is going to run (themeTag 'dark' is the single
  // signal every caller pairs with getDarkReaderInlineScripts()).
  const body = themeTag === 'dark' ? stripInlineColorImportant(bodyHtml) : bodyHtml;

  // <meta charset> is first in <head> so WKWebView decodes correctly even
  // when the document is loaded from a file:// URL (which would otherwise
  // fall back to Latin-1 and mojibake UTF-8 bytes).
  return `<!DOCTYPE html>
<html data-mv-theme="${themeTag}">
  <head>
    <meta charset="UTF-8">
    <base target="_blank">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light">
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        padding: 16px;
        background: #ffffff;
        color: #333333;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        word-wrap: break-word;
        overflow-wrap: break-word;
        overflow-x: hidden;
        max-width: 100%;
      }
      img { max-width: 100%; height: auto; }
      * { overflow-wrap: break-word; word-wrap: break-word; }
      ${tableCss}
      pre, code { white-space: pre-wrap; overflow-x: auto; max-width: 100%; overflow-wrap: break-word; }
      blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #ddd; overflow: hidden; }
    </style>
    ${extraHead}
  </head>
  <body>${body}${extraBody}</body>
</html>`;
}

// Right-click context menu colors. DR's MutationObserver will catch the
// dynamically-appended menu and invert it in dark mode, so we always emit
// light colors here — DR is the single source of truth for theming inside
// the iframe.
export function getContextMenuColors() {
  return {
    menuBg: '#ffffff',
    menuBorder: '#d1d5db',
    menuShadow: '0 4px 12px rgba(0,0,0,.15)',
    itemColor: '#333333',
    itemHoverBg: '#f3f4f6',
  };
}
