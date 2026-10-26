/**
 * The unit a click on a social image redacts or reveals: a run of characters
 * between spaces, its edge punctuation trimmed, lowercased. One rule for the
 * hit map, the marks findPii applies and the header's party masking, so a
 * click and the render it causes always agree on what "the same word" is.
 */
const LEAD = /^[^\p{L}\p{N}]*/u;
const TRAIL = /[^\p{L}\p{N}]*$/u;

export const wordKey = (text) => String(text ?? '').replace(LEAD, '').replace(TRAIL, '').toLowerCase();

/**
 * Every word of `text` that holds a letter or digit: `{ text, key, start, end }`.
 * `text` is the whole run as written; `start`/`end` bound the word itself, edge
 * punctuation left out ("<ana@x.co>," is the address alone).
 */
export function wordTokens(text) {
  const s = String(text ?? '');
  const out = [];
  for (const m of s.matchAll(/\S+/gu)) {
    const run = m[0];
    const key = wordKey(run);
    if (!key) continue;
    const start = m.index + run.match(LEAD)[0].length;
    out.push({ text: run, key, start, end: m.index + run.length - run.match(TRAIL)[0].length });
  }
  return out;
}
