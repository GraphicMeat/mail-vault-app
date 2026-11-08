// Pure helpers of the compose screen: recipient lists as chips, the fields a draft or a send
// carries, and the send error codes each to its translated message.

import { splitRecipientList } from '../shared/recipientTokens.js';

/** `mobile.compose.send` refusals, each to its message. Literal keys for the catalog tests. */
export const SEND_ERROR_KEYS = Object.freeze({
  TOO_LARGE: 'mobile.compose.error.TOO_LARGE',
  ATTACHMENT_MISSING: 'mobile.compose.error.ATTACHMENT_MISSING',
  INVALID: 'mobile.compose.error.INVALID',
  INTERNAL: 'mobile.compose.error.INTERNAL',
});

export function sendErrorKey(code) {
  return Object.hasOwn(SEND_ERROR_KEYS, code) ? SEND_ERROR_KEYS[code] : SEND_ERROR_KEYS.INTERNAL;
}

/**
 * A refused send as what Compose shows: a catalog key, with `vars` when the engine named the
 * account's attachment limit (`TOO_LARGE` with `data.limitBytes`; a Microsoft account's is about
 * 2 MB, others 25 MB).
 */
export function sendError(err) {
  const limit = err?.data?.limitBytes;
  if (err?.code === 'TOO_LARGE' && Number.isFinite(limit) && limit > 0) {
    const mb = limit / (1024 * 1024);
    const size = mb >= 10 ? String(Math.floor(mb)) : String(Math.floor(mb * 10) / 10);
    return { key: 'mobile.compose.error.TOO_LARGE_LIMIT', vars: { size } };
  }
  return { key: sendErrorKey(err?.code) };
}

/**
 * A comma-separated list (`a@x, "Doe, John" <j@x>`) as its entries, raw and trimmed. A comma
 * inside quotes or angle brackets belongs to the entry.
 */
export const splitList = (text) => splitRecipientList(String(text ?? ''));

/**
 * What the user typed, as entries: commas, semicolons and white space all separate (a typed
 * entry is a bare address). Quoted or angled text keeps its spaces.
 */
export function splitTyped(text) {
  return splitList(text).flatMap((entry) => (/[<"]/.test(entry) ? [entry] : entry.split(/\s+/).filter(Boolean)));
}

/** The address of an entry: the part in angle brackets, else the entry itself. */
export function addressOf(entry) {
  const m = /<([^<>]*)>\s*$/.exec(entry);
  return (m ? m[1] : entry).trim();
}

/** The display name of an entry (`"Doe, John" <j@x>` -> `Doe, John`), or ''. */
export function nameOf(entry) {
  const m = /^(.*?)<[^<>]*>\s*$/.exec(entry);
  return m ? m[1].trim().replace(/^"(.*)"$/, '$1').trim() : '';
}

const ADDRESS = /^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+\.[^\s@<>,;"()[\]\\.]{2,}$/;

/** Whether an entry has an address that reads (`x@y.zz`). The engine checks it again on send. */
export function isValidEntry(entry) {
  return ADDRESS.test(addressOf(entry)) && !/\.\./.test(addressOf(entry));
}

/** Entries back to the list the engine takes. */
export function joinList(entries) {
  return entries.join(', ');
}

/** The message fields a draft save or a send carries (without the account or draft id). */
export function fieldsOf({ to, cc, bcc, subject, text, inReplyTo, references, attachments }) {
  return {
    to: joinList(to),
    cc: joinList(cc),
    bcc: joinList(bcc),
    subject,
    text,
    inReplyTo: inReplyTo || '',
    references: references || '',
    attachments: attachments.map((a) => ({ handle: a.handle })),
  };
}

/** Nothing a draft would keep. */
export function isEmpty({ to, cc, bcc, subject, text, attachments }) {
  return !to.length && !cc.length && !bcc.length && !subject.trim() && !text.trim() && !attachments.length;
}

/** The body a reply or forward starts with: room to write, then the quote. */
export function initialText(quoteText) {
  return quoteText ? `\n\n${quoteText}` : '';
}
