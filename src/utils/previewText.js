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

export function cleanPreviewText(value) {
  if (!value) return '';
  return decodeEntities(String(value)).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}
