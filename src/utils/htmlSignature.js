// A signature written as HTML the compose schema cannot hold: the table
// layouts and inline styles signature generators make. Such a signature is
// stored as one block, `<div data-mv-signature-html="">…</div>`, which the
// editor keeps whole (the HtmlSignature node below) and writes back exactly as
// it read it, so the compose window still finds the signature by its HTML when
// From changes (utils/signatureCaret.js).
//
// The block is drawn in the app's own window, not the viewer's sandboxed
// frame, and quoted mail can carry one too, so its HTML goes through an
// allowlist every time it is read: listed tags and attributes only, links to
// http(s), mailto and tel only, pictures from http(s), cid or a data: image,
// no style declaration that loads anything or leaves the block.

import { Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

export const SIGNATURE_HTML_ATTR = 'data-mv-signature-html';
export const SIGNATURE_HTML_SELECTOR = `div[${SIGNATURE_HTML_ATTR}]`;

// Dropped with everything inside them.
const DROP = /^(APPLET|AUDIO|BASE|BUTTON|CANVAS|DIALOG|EMBED|FORM|FRAME|FRAMESET|HEAD|IFRAME|INPUT|LINK|MATH|META|NOSCRIPT|OBJECT|OPTION|PORTAL|SCRIPT|SELECT|SOURCE|STYLE|SVG|TEMPLATE|TEXTAREA|TITLE|TRACK|VIDEO)$/;
// Kept; any other element gives way to its children.
const TAGS = /^(A|ABBR|B|BIG|BLOCKQUOTE|BR|CAPTION|CENTER|CODE|COL|COLGROUP|DEL|DIV|EM|FONT|H[1-6]|HR|I|IMG|INS|LI|OL|P|PRE|S|SMALL|SPAN|STRIKE|STRONG|SUB|SUP|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|U|UL)$/;
const ATTRS = new Set([
  'align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'color', 'colspan', 'dir',
  'face', 'height', 'href', 'rel', 'rowspan', 'size', 'span', 'src', 'start', 'style', 'target',
  'title', 'valign', 'width',
]);
const HREF = /^(https?:|mailto:|tel:)/i;
const SRC = /^(https?:|cid:|data:image\/(png|jpe?g|gif|webp);base64,)/i;
// A declaration that fetches something (a tracking pixel in compose), runs
// something, or takes the block out of its place in the window.
const UNSAFE_STYLE = /url\s*\(|expression\s*\(|javascript:|@import|\\|behavior|binding/i;
const UNSAFE_PROPERTY = /^(position|z-index|inset|top|right|bottom|left)$/;

// Declarations are kept as written, not through CSSOM, which would rewrite
// `#ff7300` as `rgb(...)` and change the stored signature on every load.
function cleanStyle(style) {
  return style.split(';')
    .map(decl => decl.trim())
    .filter((decl) => {
      const colon = decl.indexOf(':');
      if (colon < 1) return false;
      const property = decl.slice(0, colon).trim().toLowerCase();
      return /^-?[a-z][a-z-]*$/.test(property) && !UNSAFE_PROPERTY.test(property) && !UNSAFE_STYLE.test(decl);
    })
    .join('; ');
}

function cleanElement(el) {
  for (const { name, value } of [...el.attributes]) {
    const v = value.trim();
    let keep = ATTRS.has(name);
    if (keep && name === 'href') keep = el.tagName === 'A' && HREF.test(v);
    else if (keep && name === 'src') keep = el.tagName === 'IMG' && SRC.test(v);
    else if (keep && name === 'target') keep = v === '_blank';
    else if (keep && name === 'style') {
      const style = cleanStyle(value);
      keep = !!style;
      if (keep && style !== value) el.setAttribute('style', style);
    }
    if (!keep) el.removeAttribute(name);
  }
}

function cleanChildren(parent) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === 3) continue;
    if (node.nodeType !== 1) { node.remove(); continue; }
    if (DROP.test(node.tagName)) { node.remove(); continue; }
    cleanChildren(node);
    if (TAGS.test(node.tagName)) cleanElement(node);
    else node.replaceWith(...node.childNodes);
  }
}

let inert = null;
// A document with no window: nothing parsed into it loads or runs.
const inertDocument = () => (inert ||= document.implementation.createHTMLDocument(''));

function parse(html) {
  const box = inertDocument().createElement('div');
  box.innerHTML = html;
  return box;
}

/** `html` with only the allowlisted markup left. Stable: cleaning its own output changes nothing. */
export function cleanSignatureMarkup(html) {
  if (!html || typeof html !== 'string') return '';
  const box = parse(html);
  cleanChildren(box);
  return box.innerHTML;
}

/** `html` with every stored block opened back up into the markup it holds. */
export function unwrapSignatureHtml(html) {
  if (!html || typeof html !== 'string' || !html.includes(SIGNATURE_HTML_ATTR)) return html || '';
  const box = parse(html);
  for (const block of box.querySelectorAll(SIGNATURE_HTML_SELECTOR)) block.replaceWith(...block.childNodes);
  return box.innerHTML;
}

export const isHtmlSignature = html => typeof html === 'string' && html.includes(`<div ${SIGNATURE_HTML_ATTR}`);

// What the compose schema reads without losing anything: tag -> the attributes
// it keeps. A font-family span is checked on its own.
const SCHEMA = {
  P: [], BR: [], DIV: [], STRONG: [], B: [], EM: [], I: [], U: [], S: [], STRIKE: [], DEL: [],
  CODE: [], PRE: [], BLOCKQUOTE: [], UL: [], OL: ['start'], LI: [], HR: [],
  A: ['href', 'target', 'rel'], IMG: ['src', 'alt', 'title', 'width', 'height'], SPAN: ['style'],
};
const onlyFontFamily = style => style.split(';').map(d => d.trim()).filter(Boolean)
  .every(d => /^font-family\s*:/i.test(d));

/** True when the schema would drop part of `clean` (cleanSignatureMarkup output): it needs the block. */
export function needsHtmlSignature(clean) {
  if (!clean) return false;
  for (const el of parse(clean).querySelectorAll('*')) {
    const kept = SCHEMA[el.tagName];
    if (!kept) return true;
    for (const { name, value } of el.attributes) {
      if (!kept.includes(name)) return true;
      if (el.tagName === 'SPAN' && !onlyFontFamily(value)) return true;
    }
  }
  return false;
}

/** The HTML the editor loads for a signature typed as source: the block when the schema would lose something. */
export function signatureMarkupForEditor(html) {
  const clean = cleanSignatureMarkup(unwrapSignatureHtml(html));
  return needsHtmlSignature(clean) ? `<div ${SIGNATURE_HTML_ATTR}="">${clean}</div>` : clean;
}

/**
 * The stored block in the editor: one piece, shown as it will look, selected
 * and deleted whole, written back as the HTML it was read from.
 */
export const HtmlSignature = Node.create({
  name: 'htmlSignature',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      html: { default: '', rendered: false, parseHTML: el => cleanSignatureMarkup(el.innerHTML) },
    };
  },

  parseHTML() {
    return [{ tag: SIGNATURE_HTML_SELECTOR, priority: 1000 }];
  },

  // A link inside the block is not editable, so a click on it would follow
  // it and take the compose or Settings window away from the draft.
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleDOMEvents: {
          click: (_view, event) => {
            if (event.target?.closest?.(`${SIGNATURE_HTML_SELECTOR} a`)) event.preventDefault();
            return false;
          },
        },
      },
    })];
  },

  renderHTML({ node }) {
    const block = inertDocument().createElement('div');
    block.setAttribute(SIGNATURE_HTML_ATTR, '');
    // Cleaned again on the way out: the attribute is only ever set by
    // parseHTML today, and the window this lands in runs inline handlers.
    block.innerHTML = cleanSignatureMarkup(node.attrs.html);
    return block;
  },
});
