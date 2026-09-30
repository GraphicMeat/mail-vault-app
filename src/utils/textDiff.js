/// Word-level diff for the unsaved-changes prompt: what a phrase was and what
/// it became, the way `git diff --word-diff` reads it.

// A word (letters and digits, any script) stays whole; every space and every
// punctuation mark is a token of its own, so "63" -> "63, asd" adds ", asd"
// and does not rewrite "63".
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
const tokens = text => text.match(TOKEN) ?? [];

// LCS table cells. Past this the middle is shown as one removal and one
// addition: still true, only less fine-grained.
const MAX_CELLS = 250_000;

function pushPart(parts, type, text) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last?.type === type) last.text += text;
  else parts.push({ type, text });
}

export function diffText(before, after) {
  const a = tokens(before ?? '');
  const b = tokens(after ?? '');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const parts = [];
  pushPart(parts, 'same', a.slice(0, head).join(''));
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    pushPart(parts, 'del', midA.join(''));
    pushPart(parts, 'add', midB.join(''));
  } else {
    // lcs[i][j]: longest common run of midA[i..] and midB[j..]
    const lcs = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) { pushPart(parts, 'same', midA[i]); i++; j++; }
      else if (j < midB.length && (i === midA.length || lcs[i][j + 1] >= lcs[i + 1][j])) pushPart(parts, 'add', midB[j++]);
      else pushPart(parts, 'del', midA[i++]);
    }
  }
  pushPart(parts, 'same', a.slice(a.length - tail).join(''));
  return normalize(parts);
}

// A change is read removal first, then addition, wherever both sit together.
function normalize(parts) {
  const out = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (part.type === 'del' && prev?.type === 'add') {
      const before = out[out.length - 2];
      if (before?.type === 'del') { before.text += part.text; continue; }
      out.splice(out.length - 1, 0, part);
      continue;
    }
    out.push(part);
  }
  return out;
}

// The last `n` characters of `text`, starting on a word: a cut through the
// middle of one reads as a different word. A single word longer than `n` is cut.
function tailOf(text, n) {
  const cut = text.slice(-n);
  if (/\s/.test(text[text.length - n - 1]) || /^\s/.test(cut)) return cut;
  const space = cut.search(/\s/);
  return space === -1 ? cut : cut.slice(space + 1);
}

// The first `n` characters of `text`, ending on a word.
function headOf(text, n) {
  const cut = text.slice(0, n);
  if (/\s/.test(text[n]) || /\s$/.test(cut)) return cut;
  const space = cut.search(/\s\S*$/);
  return space === -1 ? cut : cut.slice(0, space);
}

/// Shrinks the shared text around each change to about `context` characters,
/// cut between words, with "…" where text was cut, so an edit at the end of a
/// long phrase is still on screen.
export function clipDiff(parts, context = 30) {
  return parts.map((part, index) => {
    if (part.type !== 'same') return part;
    const first = index === 0;
    const last = index === parts.length - 1;
    const { text } = part;
    if (first && last) return part;
    if (first) return text.length > context ? { ...part, text: `…${tailOf(text, context)}` } : part;
    if (last) return text.length > context ? { ...part, text: `${headOf(text, context)}…` } : part;
    return text.length > context * 2 ? { ...part, text: `${headOf(text, context)}…${tailOf(text, context)}` } : part;
  });
}
