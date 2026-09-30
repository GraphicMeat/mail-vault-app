// The signature editor's Code view: a signature's HTML as text, edited by hand.
//
// A signature is only ever sanitized by the editor's schema: whatever the
// compose editor cannot represent (scripts, styles, event handlers, unsafe
// link targets, tables, any span but a font's) is dropped when the HTML is
// loaded into it. A span keeps only its `font-family`, and only plain family
// names in it (utils/fontFamilyMark.js).
// Code view adds no second path: every draft is read back through that same
// schema before it reaches the stored signature, so the source a person types
// is never what is saved.

import { Editor } from '@tiptap/core';
import { editorExtensions, padEmptyLines } from '../components/RichTextEditor';

/**
 * `html` as the editor would hold it after loading it, written the way the
 * editor writes it (empty lines padded), so what Rendered view shows is what
 * is saved. Never throws: anything that cannot be read as a string or fails to
 * load gives `fallback`, so a bad draft never replaces a good signature.
 */
export function sanitizeSignatureHtml(html, fallback = '') {
  if (html === undefined || html === null || html === '') return '';
  if (typeof html !== 'string') return fallback;
  let editor = null;
  try {
    editor = new Editor({ extensions: editorExtensions(''), content: html });
    return padEmptyLines(editor.getHTML());
  } catch {
    return fallback;
  } finally {
    try { editor?.destroy(); } catch { /* nothing left to free */ }
  }
}

/**
 * The whole signature set in `stack` (a font-family list), or back to the
 * default font when `stack` is empty: the font control's answer when there
 * is no live editor to apply it to a selection.
 */
export function setSignatureFont(html, stack) {
  if (!html || typeof html !== 'string') return html || '';
  let editor = null;
  try {
    editor = new Editor({ extensions: editorExtensions(''), content: html });
    const chain = editor.chain().selectAll();
    (stack ? chain.setFontFamily(stack) : chain.unsetFontFamily()).run();
    return padEmptyLines(editor.getHTML());
  } catch {
    return html;
  } finally {
    try { editor?.destroy(); } catch { /* nothing left to free */ }
  }
}

// Whitespace between blocks is dropped when HTML is loaded, so breaking lines
// there changes nothing on the way back. Text, and a <pre>'s inside, is left alone.
const AFTER_BLOCK = /(<\/(?:p|pre)>)(?=<(?!\/li>))|(<\/(?:li|ul|ol|blockquote)>|<(?:ul|ol|blockquote)>)(?=<)/g;

/** One block per line: the editor writes its HTML as a single line. */
export function prettyPrintSignatureHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html.replace(AFTER_BLOCK, '$&\n');
}

/**
 * The Rendered / Code state. `html` is always the sanitized signature, the
 * one stored; `draft` is the source as typed, only while in Code view, so a
 * half-typed tag is not rewritten under the caret.
 */
export const initialSignatureSource = (html = '') => ({ mode: 'rendered', html, draft: '' });

export function signatureSourceReducer(state, action) {
  switch (action.type) {
    case 'mode':
      if (action.mode === state.mode) return state;
      if (action.mode === 'code') return { ...state, mode: 'code', draft: prettyPrintSignatureHtml(state.html) };
      if (action.mode === 'rendered') return { ...state, mode: 'rendered', draft: '' };
      return state;
    case 'draft':
      return { ...state, draft: action.draft, html: sanitizeSignatureHtml(action.draft, state.html) };
    case 'html':
      return state.html === action.html ? state : { ...state, html: action.html };
    case 'external':
      return initialSignatureSource(action.html);
    default:
      return state;
  }
}
