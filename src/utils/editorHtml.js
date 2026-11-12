import StarterKit from '@tiptap/starter-kit';
import HardBreak from '@tiptap/extension-hard-break';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import { CODE_LOOK } from './codeLook';
import { FontFamily } from './fontFamilyMark';
import { HtmlSignature, SIGNATURE_HTML_SELECTOR } from './htmlSignature';

// The compose editor's schema and the HTML helpers around it. They live here,
// not in components/RichTextEditor.jsx, so utils and services can use them
// without importing a component. RichTextEditor.jsx re-exports every name.

// Tags a renderer starts a new line for (prosemirror-model's block list).
const BLOCK_TAGS = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|CANVAS|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HGROUP|HR|LI|NOSCRIPT|OL|OUTPUT|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;
// Inline wrappers a <br> can sit inside and still be the end of its line.
const INLINE_TAGS = /^(A|ABBR|ACRONYM|B|BDI|BDO|CITE|CODE|DEL|DFN|EM|FONT|I|INS|KBD|LABEL|MARK|Q|RUBY|S|SAMP|SMALL|SPAN|STRIKE|STRONG|SUB|SUP|TIME|TT|U|VAR)$/;

/**
 * True for a <br> that nothing follows on its line. Such a break draws no line
 * of its own: it only holds an otherwise empty line open, so `<p><br></p>` is
 * one blank line and `<p>Hi<br></p>` is one line, in every mail client.
 * ProseMirror's own paste parser reads it the same way.
 */
export function isPaddingBreak(br) {
  let node = br;
  for (;;) {
    let next = node.nextSibling;
    // Collapsible whitespace and comments put nothing on the line.
    while (next && (next.nodeType === 8 || (next.nodeType === 3 && !/[^ \t\n\r\f]/.test(next.nodeValue)))) {
      next = next.nextSibling;
    }
    // ponytail: anything else after it, a block included, keeps it a line break.
    // Ignoring a <br> that sits alone between two <div>s opens a paragraph the
    // next <div>'s text merges into, so Gmail's reply/quote gap would vanish
    // rather than show double height.
    if (next) return false;
    const parent = node.parentNode;
    if (!parent || !INLINE_TAGS.test(parent.nodeName)) return true;
    node = parent;
  }
}

// Reading mail HTML with the stock rule turned a padding <br> into a line
// break inside the blank line it belongs to: a blank line from a template, a
// plain-text signature or a forwarded Gmail message showed two lines tall.
const MailHardBreak = HardBreak.extend({
  parseHTML() {
    return [
      { tag: 'br', ignore: true, getAttrs: (el) => (isPaddingBreak(el) ? null : false) },
      ...this.parent(),
    ];
  },
});

/** The compose schema. Exported so the tests read and write HTML through the same one. */
export const editorExtensions = (placeholder, { resizeImages = false } = {}) => [
  StarterKit.configure({
    heading: false,
    // StarterKit ships its own link and underline; the two below replace
    // them, and registering both names warns and leaves which one wins
    // up to extension order.
    link: false,
    underline: false,
    hardBreak: false,
  }),
  MailHardBreak,
  Underline,
  // Not inclusive: text typed at a link's end is plain text. Stock TipTap
  // ties this to `autolink`, so a pasted URL swallowed everything after it.
  Link.extend({ inclusive: () => false }).configure({
    openOnClick: false,
    HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
  }),
  Placeholder.configure({ placeholder }),
  // A signature's chosen font, and the fonts quoted mail was written in: an
  // inline family list only (utils/fontFamilyMark.js).
  FontFamily,
  // A signature kept as the HTML it was written in (utils/htmlSignature.js).
  HtmlSignature,
  // allowBase64: compose restores initialData.body HTML after minimize /
  // undo-send, and the inline picture must parse back out of that string.
  // `resizeImages`: a picture gets corner handles; the size lands in its
  // width/height attributes, which the email carries.
  Image.configure({
    allowBase64: true,
    ...(resizeImages && {
      resize: {
        enabled: true,
        directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
        minWidth: 16,
        minHeight: 16,
        alwaysPreserveAspectRatio: true,
      },
    }),
  }),
];

/**
 * The editor's HTML with its empty lines made real. TipTap writes an empty
 * paragraph as `<p></p>` and a line break that ends a paragraph as a bare
 * trailing `<br>`; ProseMirror gives both their height on screen with a <br>
 * of its own, and anywhere else they collapse. This adds that <br>, the way
 * Thunderbird, Gmail and Apple Mail write a blank line. Takes getHTML()
 * output only: HTML that is already padded would gain a second line.
 */
export function padEmptyLines(html) {
  if (!html) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const p of doc.body.querySelectorAll('p')) {
    // An HTML signature goes out exactly as it was written.
    if (p.closest(SIGNATURE_HTML_SELECTOR)) continue;
    let last = p;
    while (last.lastChild) last = last.lastChild;
    if (last === p || last.nodeName === 'BR') p.appendChild(doc.createElement('br'));
  }
  return doc.body.innerHTML;
}

const SKIP_TAGS = /^(HEAD|SCRIPT|STYLE|TEMPLATE|TITLE)$/;

/**
 * The text/plain twin of a message body, line for line as the HTML reads: one
 * line per paragraph and line break, an empty paragraph as a blank line, list
 * items marked, quoted lines prefixed with "> ", a link followed by its
 * address when the text does not already say it. DOMParser, so nothing in the
 * HTML (the quoted original included) loads or runs.
 */
export function htmlToText(html) {
  if (!html) return '';
  const { body } = new DOMParser().parseFromString(html, 'text/html');
  const lines = [];
  let line = null;   // the line being written, null between lines
  let quote = '';    // one "> " per enclosing blockquote
  let marker = '';   // a list item's marker, waiting for the item's first line
  const lists = [];  // per enclosing list: null for <ul>, the count so far for <ol>

  const open = () => {
    if (line === null) { line = marker; marker = ''; }
  };
  const close = () => {
    if (line !== null) { lines.push((quote + line).trimEnd()); line = null; }
  };

  const walk = (node) => {
    if (node.nodeType === 3) {
      let value = node.nodeValue.replace(/[ \t\n\r\f]+/g, ' ');
      if (line === null || line === '' || line.endsWith(' ')) value = value.replace(/^ /, '');
      if (!value) return;
      open();
      line += value.replace(/\u00a0/g, ' ');
      return;
    }
    if (node.nodeType !== 1 || SKIP_TAGS.test(node.nodeName)) return;
    const tag = node.nodeName;
    // A padding <br> ends its line too: nothing follows it on that line, so
    // ending the line here or at the block's end writes the same text.
    if (tag === 'BR') {
      open();
      close();
      return;
    }
    if (tag === 'PRE') {
      close();
      for (const row of node.textContent.replace(/\n$/, '').split('\n')) { open(); line += row; close(); }
      return;
    }
    const block = BLOCK_TAGS.test(tag);
    if (block) close();
    if (tag === 'BLOCKQUOTE') quote += '> ';
    else if (tag === 'UL' || tag === 'OL') lists.push(tag === 'OL' ? 0 : null);
    else if (tag === 'LI') {
      const depth = Math.max(lists.length - 1, 0);
      const ordered = lists.length > 0 && lists[lists.length - 1] !== null;
      marker = '  '.repeat(depth) + (ordered ? `${++lists[lists.length - 1]}. ` : '- ');
    }
    // A paragraph is a line even when it is empty: that is the blank line.
    if (tag === 'P') open();
    node.childNodes.forEach(walk);
    if (tag === 'A') {
      const href = node.getAttribute('href') || '';
      const address = href.replace(/^mailto:/i, '');
      const bare = (s) => s.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      const shown = node.textContent.trim();
      if (/^(https?:|mailto:)/i.test(href) && shown && bare(address) !== bare(shown)) {
        open();
        line = `${line.trimEnd()} <${address}>`;
      }
    }
    if (block) close();
    if (tag === 'BLOCKQUOTE') quote = quote.slice(0, -2);
    else if (tag === 'UL' || tag === 'OL') lists.pop();
    else if (tag === 'LI') marker = '';
  };

  body.childNodes.forEach(walk);
  close();
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}

// The compose window renders paragraphs nearly flush (`.tiptap p { margin: 0 0
// 0.25em }` in index.css) but ships bare tags. Every reader — our own viewer
// included — then applies its default `p { margin: 1em 0 }`, so the message
// arrives with a blank line more between paragraphs than the window showed.
// Carry the editor's own spacing out with the message; inline, because mail
// clients drop <style> blocks. Blockquote is left out on purpose: its default
// `margin: 1em 40px` is the indent that makes a quote read as a quote.
const EDITOR_SPACING = {
  P: '0 0 0.25em',
  UL: '0.5em 0',
  OL: '0.5em 0',
  LI: '0.15em 0',
  PRE: '0.5em 0',
};

// Code, carried the same way: the look lives in utils/codeLook (a <pre> holds its
// <code>, so the block gets the background and the code inside it only the font).
function inlineCodeLook(doc) {
  doc.body.querySelectorAll('pre, code').forEach((el) => {
    if (el.closest(SIGNATURE_HTML_SELECTOR)) return;
    const look = el.tagName === 'PRE' ? CODE_LOOK.block : el.closest('pre') ? CODE_LOOK.inBlock : CODE_LOOK.inline;
    for (const [property, value] of Object.entries(look)) {
      // A style the message already carries is the author's, not ours.
      if (!el.style[property]) el.style[property] = value;
    }
  });
}

export function inlineComposeSpacing(html) {
  if (!html) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.body.querySelectorAll(Object.keys(EDITOR_SPACING).join(',')).forEach((el) => {
    // An HTML signature carries its own spacing, or means to have none.
    if (el.closest(SIGNATURE_HTML_SELECTOR)) return;
    // A margin the message already carries is the author's, not ours.
    if (el.style.margin || el.style.marginTop || el.style.marginBottom) return;
    el.style.margin = EDITOR_SPACING[el.tagName];
  });
  inlineCodeLook(doc);
  return doc.body.innerHTML;
}
