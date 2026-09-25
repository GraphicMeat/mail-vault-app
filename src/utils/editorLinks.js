import { getMarkRange } from '@tiptap/core';

/**
 * Link operations for the compose editor, as plain transactions so the
 * toolbar, the hover card and the tests all run the same code. None of them
 * focuses the editor; the caller does that.
 */

/** The whole link at `pos` (inside it, or right after it): `{ from, to, href, text }`, else null. */
export function linkRangeAt(editor, pos) {
  const type = editor.schema.marks.link;
  const $pos = editor.state.doc.resolve(pos);
  const range = getMarkRange($pos, type);
  if (!range) return null;
  let href = '';
  editor.state.doc.nodesBetween(range.from, range.to, (node) => {
    href ||= node.marks.find((m) => m.type === type)?.attrs.href || '';
  });
  return { ...range, href, text: editor.state.doc.textBetween(range.from, range.to, ' ') };
}

/** A typed address as a link: `example.com` means https, `bob@example.com` means mail. */
export function normalizeHref(value) {
  const href = String(value || '').trim();
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  return (/^[^\s/@]+@[^\s/@]+$/.test(href) ? 'mailto:' : 'https://') + href;
}

/**
 * Make `from..to` read `text` and link to `href`. Text left as it was keeps
 * its formatting; an empty address removes the link. The address goes through
 * TipTap's own setLink, so its allowed-protocol check decides: a refused one
 * (`javascript:`) returns false and changes nothing.
 */
export function applyLink(editor, { from, to }, { text, href }) {
  const url = normalizeHref(href);
  if (!url) return from === to || removeLink(editor, { from, to });
  // A chain dispatches even when a command in it fails, so ask first, with
  // the range selected: that is what setLink will check against.
  editor.commands.setTextSelection({ from, to });
  if (!editor.can().setLink({ href: url })) return false;
  const current = editor.state.doc.textBetween(from, to, ' ');
  const label = text || current || url;
  const chain = editor.chain();
  let end = to;
  if (label !== current) {
    chain.insertContentAt({ from, to }, { type: 'text', text: label });
    end = from + label.length;
  }
  return chain.setTextSelection({ from, to: end }).setLink({ href: url }).setTextSelection(end).run();
}

/** Drop the link over `range`, keeping its text. */
export function removeLink(editor, { from, to }) {
  return editor.chain().setTextSelection({ from, to }).unsetLink().setTextSelection(to).run();
}

/** Delete the link and its text. */
export function removeLinkWithText(editor, { from, to }) {
  return editor.chain().deleteRange({ from, to }).run();
}

/** Open a link in the system browser or mail app. Only web and mail addresses. */
export function openLink(href) {
  if (!/^(https?:|mailto:)/i.test(href || '')) return Promise.resolve(false);
  return import('@tauri-apps/plugin-shell')
    .then(({ open }) => open(href))
    .catch(() => window.open(href, '_blank'))
    .then(() => true);
}
