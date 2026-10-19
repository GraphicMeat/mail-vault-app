// ── Recipient fields as chips ───────────────────────────────────────────────
//
// To / Cc / Bcc keep their value as the comma-joined string every consumer
// already reads (drafts, send, the dirty check). The chips are a view over it:
// everything before the last top-level separator is a committed address, the
// text after it is the draft being typed. These helpers move between the two.

const SEPARATORS = new Set([',', ';', '\n', '\r']);
const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+$/;
const ADDRESS_WITH_DOT = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;.]+$/;

/// Cuts `text` at every separator that is not inside a quoted display name or
/// angle brackets. `open` is what follows the last separator (the draft).
function scan(text) {
  const segments = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;
  const raw = text || '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && inQuotes) {
      current += ch + (raw[i + 1] || '');
      i++;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === '<' && !inQuotes) inAngle = true;
    else if (ch === '>' && !inQuotes) inAngle = false;
    if (SEPARATORS.has(ch) && !inQuotes && !inAngle) {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  return { segments, open: current };
}

const decode = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

/// One pasted token as the address it stands for: a `mailto:` link loses its
/// scheme and `?subject=…` part, a bare `<a@b.de>` its brackets.
function clean(token) {
  let t = token.trim().replace(/^mailto:/i, '');
  t = t.replace(/\?[a-z-]+=.*$/i, '');
  if (t.includes('%')) t = decode(t);
  t = t.trim();
  const bare = /^<([^<>]+)>$/.exec(t);
  return bare ? bare[1].trim() : t;
}

/// Whitespace separates addresses only between bare ones: "John Doe" and
/// `John <j@d.com>` stay whole.
function splitOnWhitespace(segment) {
  const t = segment.trim();
  if (!/\s/.test(t) || /["<>]/.test(t)) return [t];
  const pieces = t.split(/\s+/);
  return pieces.every(p => p.includes('@')) ? pieces : [t];
}

/// The bare lowercase address of a token, '' when it holds none.
export function recipientAddress(token) {
  const angle = /<([^<>]*)>\s*$/.exec(token || '');
  const candidate = (angle ? angle[1] : token || '').trim();
  return ADDRESS.test(candidate) ? candidate.toLowerCase() : '';
}

export function isValidRecipient(token) {
  const angle = /<([^<>]*)>\s*$/.exec(token || '');
  return ADDRESS_WITH_DOT.test((angle ? angle[1] : token || '').trim());
}

const identity = (token) => recipientAddress(token) || token.toLowerCase();

/// Everything a paste or a typed separator commits: split, cleaned, deduped.
export function parseRecipientText(text) {
  // A mailto: link's ?cc=a,b&subject=… would split on its own commas.
  const { segments, open } = scan((text || '').replace(/(mailto:[^?\s]*)\?\S*/gi, '$1'));
  const seen = new Set();
  const out = [];
  for (const segment of [...segments, open]) {
    for (const piece of splitOnWhitespace(segment)) {
      const token = clean(piece);
      if (!token || seen.has(identity(token))) continue;
      seen.add(identity(token));
      out.push(token);
    }
  }
  return out;
}

/// `{ chips, draft }` of a field value: committed addresses, then the text
/// being typed (leading space dropped, trailing kept so "John " can go on).
export function splitRecipientField(value) {
  const { segments, open } = scan(value);
  return { chips: segments.map(s => s.trim()).filter(Boolean), draft: open.trimStart() };
}

/// Chips back into a field value: each one followed by a comma.
export const joinRecipients = (list) => (list.length ? `${list.join(', ')}, ` : '');

/// Commits `text` onto `value`: the whole value counts as committed, repeats
/// (by address, any case or display name) are skipped.
export function addRecipients(value, text) {
  const list = scan(value).segments.map(s => s.trim()).filter(Boolean);
  const open = scan(value).open.trim();
  if (open) list.push(open);
  const seen = new Set(list.map(identity));
  for (const token of parseRecipientText(text)) {
    if (seen.has(identity(token))) continue;
    seen.add(identity(token));
    list.push(token);
  }
  return joinRecipients(list);
}

/// Drops chip `index`. By default the whole value is chips; `keepDraft` keeps
/// the text after the last separator as the draft instead.
export function removeRecipient(value, index, options) {
  return removeRecipients(value, [index], options);
}

/// A pasted mailto: link can carry Cc, Bcc and further To addresses in its
/// ?query: those come back under their own header.
export function parseRecipientPaste(text) {
  const extra = { to: [], cc: [], bcc: [] };
  for (const m of (text || '').matchAll(/mailto:[^?\s]*\?(\S*)/gi)) {
    for (const pair of m[1].split('&')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = decode(pair.slice(0, eq)).toLowerCase();
      if (key in extra) extra[key].push(decode(pair.slice(eq + 1)));
    }
  }
  return {
    to: parseRecipientText([text || '', ...extra.to].join('\n')),
    cc: parseRecipientText(extra.cc.join('\n')),
    bcc: parseRecipientText(extra.bcc.join('\n')),
  };
}

/// What a chip shows: the display name when there is one, else the address.
/// `address` is for the tooltip ('' when the token holds none).
export function recipientDisplay(token) {
  const m = /^([\s\S]*?)<([^<>]*)>\s*$/.exec(token || '');
  if (!m) return { label: token, address: recipientAddress(token) ? token.trim() : '' };
  const address = m[2].trim();
  let name = m[1].trim();
  if (name.length > 1 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  return { label: name || address || token, address };
}

const chipList = (value, keepDraft) => {
  const { chips, draft } = splitRecipientField(value);
  return { list: keepDraft ? chips : [...chips, draft.trim()].filter(Boolean), draft };
};

/// Swaps chip `index` for what the user typed in its place: cleaned, split,
/// repeats of other chips dropped; an empty edit removes the chip.
export function replaceRecipient(value, index, text, { keepDraft = false } = {}) {
  const { list, draft } = chipList(value, keepDraft);
  const others = new Set(list.filter((_, i) => i !== index).map(identity));
  list.splice(index, 1, ...parseRecipientText(text).filter(token => !others.has(identity(token))));
  return joinRecipients(list) + (keepDraft ? draft : '');
}

export function removeRecipients(value, indices, { keepDraft = false } = {}) {
  const { list, draft } = chipList(value, keepDraft);
  for (const index of [...indices].sort((a, b) => b - a)) list.splice(index, 1);
  return joinRecipients(list) + (keepDraft ? draft : '');
}

/// Removes the chip holding `token`'s address (any case, any display name).
export function removeRecipientToken(value, token) {
  const id = identity(token);
  const { chips, draft } = splitRecipientField(value);
  const index = chips.findIndex(chip => identity(chip) === id);
  if (index >= 0) return removeRecipients(value, [index], { keepDraft: true });
  return draft.trim() && identity(draft.trim()) === id ? joinRecipients(chips) : value;
}

/// The entries of a field value that are not addresses.
export function invalidRecipients(value) {
  const { segments, open } = scan(value);
  return [...segments, open].map(s => s.trim()).filter(Boolean).filter(token => !isValidRecipient(token));
}

/// Contacts whose address is already one of the field's chips.
export function withoutRecipients(contacts, tokens) {
  const taken = new Set((tokens || []).map(recipientAddress).filter(Boolean));
  return taken.size ? contacts.filter(c => !taken.has((c.address || '').toLowerCase())) : contacts;
}
