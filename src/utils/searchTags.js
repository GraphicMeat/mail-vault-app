import { SEARCH_OPERATORS } from './searchQuery';

/// The search box shows its query as tags; the store, the recent-search list
/// and the daemon still hold one string. A tag is the exact text it
/// contributes to that string, so the string is the tags joined by spaces and
/// `parseSearchQuery` reads the joined tags the way it read the original.
///
/// Free text is never quoted here: the local lane ignores quotes, but the
/// server lane sends them inside `TEXT "..."`, where they would be searched
/// for as characters. Only an operator's value is quoted, the one way the
/// operator parser takes it (`from:"Ann Lee"`), and a value never carries a
/// quote of its own, since the parser has no escape for one.

const OPERATOR_TAG = /^(from|to|in|has|is|before|after|tag|field):(.*)$/is;

/// The query's words, a quoted run (`tag:"Needs reply"`, `-"a b"`) kept in
/// the word it sits in. An unclosed quote runs to the end. Duplicates and
/// valueless operators stay: this is a reading, not an edit.
export function tokenizeQuery(query) {
  const tokens = [];
  let current = '';
  let quoted = false;
  for (const char of typeof query === 'string' ? query : '') {
    if (char === '"') quoted = !quoted;
    if (!quoted && /\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export function serializeTags(tags) {
  return tags.join(' ');
}

/// `{ key, value }`: the operator a tag carries (`from`, `-` for an
/// exclusion, null for free text) and its value without quotes. A `field:`
/// value reads `Name=value`.
export function parseTag(tag) {
  const operator = OPERATOR_TAG.exec(tag);
  if (operator) return { key: operator[1].toLowerCase(), value: operator[2].replace(/"/g, '') };
  if (tag.length > 1 && tag.startsWith('-')) return { key: '-', value: tag.slice(1).replace(/"/g, '') };
  return { key: null, value: tag };
}

const quote = value => (/\s/.test(value) ? `"${value}"` : value);

/// The tag for an operator and a value, '' when there is no value to search
/// for. Free text (`key` null) goes out as typed.
export function formatTag(key, value) {
  const bare = String(value ?? '').replace(/"/g, '').trim();
  if (!bare) return '';
  if (!key) return bare;
  if (key === '-') return `-${quote(bare)}`;
  if (key === 'field') {
    const split = bare.indexOf('=');
    const name = (split < 0 ? bare : bare.slice(0, split)).trim();
    const fieldValue = split < 0 ? '' : bare.slice(split + 1).trim();
    if (!name) return '';
    return `field:${quote(name)}${fieldValue ? `=${quote(fieldValue)}` : ''}`;
  }
  return `${key}:${quote(bare)}`;
}

/// What typed text becomes when it is committed: its words, quotes kept only
/// where the person typed them.
export function commitText(text) {
  return tokenizeQuery(text);
}

const same = tag => tag.toLocaleLowerCase();
// The words that join others (`a || b`, `x && y`) repeat by meaning.
const joiner = tag => tag === '||' || tag === '&&';

/// `tags` plus each of `added` not already there (case ignored; `||` and
/// `&&` always go in).
export function addTags(tags, added) {
  const seen = new Set(tags.map(same));
  const out = [...tags];
  for (const tag of added) {
    if (!tag || (seen.has(same(tag)) && !joiner(tag))) continue;
    seen.add(same(tag));
    out.push(tag);
  }
  return out;
}

/// Tag `index` replaced by `next` (none removes it). A replacement another
/// tag already says is dropped rather than doubled.
export function replaceTag(tags, index, next) {
  const others = tags.filter((_, i) => i !== index);
  const seen = new Set(others.map(same));
  const fresh = [];
  for (const tag of next) {
    if (!tag || (seen.has(same(tag)) && !joiner(tag))) continue;
    seen.add(same(tag));
    fresh.push(tag);
  }
  return [...others.slice(0, index), ...fresh, ...others.slice(index)];
}

export function removeTag(tags, index) {
  return tags.filter((_, i) => i !== index);
}

/// A `/` typed at the start of a word opens the operator list:
/// `{ before, filter }`, the text ahead of it and what follows it so far.
export function slashQuery(draft) {
  const match = /(^|\s)\/(\S*)$/.exec(draft || '');
  if (!match) return null;
  return { before: draft.slice(0, match.index).trim(), filter: match[2] };
}

export function operatorMenu(filter) {
  const needle = (filter || '').toLowerCase();
  if (!needle) return SEARCH_OPERATORS;
  return SEARCH_OPERATORS.filter(op => op.syntax.toLowerCase().startsWith(needle) || op.id.toLowerCase().startsWith(needle));
}

/// What picking an operator inserts: `has:attachment` and `is:unread` are
/// whole already (`key` null); the rest wait for a value under `key`.
export function pickOperator(op) {
  if (op.syntax === '-word') return { tag: '-', key: '-' };
  if (!op.syntax.endsWith(':')) return { tag: op.syntax, key: null };
  return { tag: op.syntax, key: op.syntax.slice(0, -1) };
}
