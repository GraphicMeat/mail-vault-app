/// `inline` and ```fenced``` code in a plain-text message, as runs
/// `{ text, code }`: `code` is null for plain text, 'inline' for a span and
/// 'block' for a fenced block. The ticks and the fence lines are dropped, and so
/// is the line break after a fence, so a block sits on its own without a blank
/// line around it. The reader only ever shows what the sender wrote, never markup.

const OPEN_FENCE = /^ {0,3}```[^`]*$/;        // three ticks, then an optional language
const CLOSE_FENCE = /^ {0,3}```\s*$/;
// A span: ticks that are not part of a word ("it`s"), on one line, around
// something. The lead character is matched (no lookbehind: older WebKit lacks
// it) and given back as plain text.
const SPAN = /(^|[^\w`])`([^`\n]+)`(?![\w`])/g;

function spans(text, out) {
  let last = 0;
  for (const m of text.matchAll(SPAN)) {
    const start = m.index + m[1].length;
    if (start > last) out.push({ text: text.slice(last, start), code: null });
    out.push({ text: m[2], code: 'inline' });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), code: null });
}

export function codeRuns(text) {
  if (typeof text !== 'string' || !text) return [];
  if (!text.includes('`')) return [{ text, code: null }];
  const lines = text.split('\n');
  const out = [];
  let pending = '';
  for (let i = 0; i < lines.length; i++) {
    const close = OPEN_FENCE.test(lines[i]) ? lines.findIndex((line, j) => j > i && CLOSE_FENCE.test(line)) : -1;
    if (close !== -1) {
      if (pending) spans(pending, out);
      pending = '';
      out.push({ text: lines.slice(i + 1, close).join('\n'), code: 'block' });
      i = close;
    } else {
      pending += i < lines.length - 1 ? `${lines[i]}\n` : lines[i];
    }
  }
  if (pending) spans(pending, out);
  return out.length ? out : [{ text, code: null }];
}
