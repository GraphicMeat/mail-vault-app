// A font for a run of text, as an inline `font-family` on a <span>: the one
// style the compose editor schema keeps (signatures set it; quoted mail keeps
// its own). Only the declaration's family list is read, and only plain names
// and generic keywords survive it, so no URL, @import, @font-face or other
// declaration can reach the saved signature or a sent message.

import { Mark } from '@tiptap/core';

const MAX_FAMILIES = 8;
// Letters (any script), digits, spaces, dashes and underscores; no quote,
// paren, backslash, semicolon or brace.
const NAME = /^[\p{L}\p{N}_-][\p{L}\p{N} _-]{0,63}$/u;

// Written the way the browser's CSSOM writes it back (ProseMirror sets a
// span's style through `style.cssText`): plain words bare, anything else in
// double quotes, the declaration ended by `;`. Anything else would change on
// every load, and the compose window finds a signature by its exact HTML.
const cssName = name => (/^-?[A-Za-z][A-Za-z-]*$/.test(name) ? name : `"${name}"`);

/** The canonical family list for `value`, or '' when nothing in it is a plain name. */
export function sanitizeFontFamily(value) {
  if (typeof value !== 'string') return '';
  // Only the list itself: a `;` or `}` ends it, whatever follows.
  const list = value.split(/[;{}]/, 1)[0];
  return list.split(',')
    .map(part => part.trim().replace(/^(['"])(.*)\1$/, '$2').trim())
    .filter(name => NAME.test(name))
    .slice(0, MAX_FAMILIES)
    .map(cssName)
    .join(', ');
}

/** The raw `font-family` value of a style attribute, read as written. */
export function styleFontFamily(style) {
  const match = /(?:^|;)\s*font-family\s*:\s*([^;]*)/i.exec(style || '');
  return match ? match[1] : '';
}

const familyOf = el => sanitizeFontFamily(styleFontFamily(el.getAttribute('style'))) || null;

export const FontFamily = Mark.create({
  name: 'fontFamily',

  addAttributes() {
    return {
      fontFamily: {
        default: null,
        parseHTML: familyOf,
        renderHTML: attrs => (attrs.fontFamily ? { style: `font-family: ${attrs.fontFamily};` } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span', getAttrs: el => (familyOf(el) ? null : false) }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },

  addCommands() {
    return {
      setFontFamily: stack => ({ commands }) => {
        const clean = sanitizeFontFamily(stack);
        return clean ? commands.setMark(this.name, { fontFamily: clean }) : commands.unsetMark(this.name);
      },
      unsetFontFamily: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
});
