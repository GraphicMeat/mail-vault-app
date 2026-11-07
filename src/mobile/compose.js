// Pure helpers of the compose screen: recipient lists as chips, the fields a draft or a send
// carries, and the send error codes each to its translated message.

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
 * A comma-separated list (`a@x, "Doe, John" <j@x>`) as its entries, raw and trimmed. A comma
 * inside quotes or angle brackets belongs to the entry.
 */
export function splitList(text) {
  const out = [];
  let cur = '';
  let quoted = false;
  let angled = false;
  for (const ch of String(text ?? '')) {
    if (ch === '"' && !angled) quoted = !quoted;
    else if (ch === '<' && !quoted) angled = true;
    else if (ch === '>' && !quoted) angled = false;
    if ((ch === ',' || ch === ';') && !quoted && !angled) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

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
