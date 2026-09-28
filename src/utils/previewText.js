// A row's preview line is text lifted out of the message by the daemon (the
// search index's snippet, a vault row's own), and a plain-text part can still
// carry HTML entities: a marketing preheader pads itself with `&zwnj;` so a
// client shows nothing after the teaser. Display-time only, like bidiText, so
// every stored snippet reads right without a reindex.

// ZWSP ZWNJ ZWJ, WORD JOINER, BOM, SOFT HYPHEN, COMBINING GRAPHEME JOINER
const INVISIBLE = /[​-‍⁠﻿­͏]/g;

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  // `<` escaped first, so markup-looking text stays text; a DOMParser document
  // is inert, so nothing in the mail loads or runs.
  return new DOMParser().parseFromString(text.replace(/</g, '&lt;'), 'text/html').body.textContent;
}

// The daemon cuts a preview at 150 (vault row) or 200 (search index) characters
// whatever is there, so `&scaron;` can arrive as `&scar`. No decoder knows that
// one, and it would print raw. A tail like that is dropped, but only from a text
// long enough to have been cut: "Meet me at AT&T" is whole.
const MIN_CUT_LENGTH = 150;
const HALF_ENTITY = /&#?[a-z0-9]{1,31}$/i;

export function cleanPreviewText(value) {
  if (!value) return '';
  let text = String(value);
  if (text.length >= MIN_CUT_LENGTH) text = text.replace(HALF_ENTITY, '');
  return decodeEntities(text).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}
