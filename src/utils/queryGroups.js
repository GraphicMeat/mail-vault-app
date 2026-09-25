/// A view's search words as OR-groups of AND-words, saved in the notation the
/// daemon reads (`search_index::query::boolean_groups`):
/// `jasinskio && 14a-37 || mindaugo 30`. Every word in a group must appear;
/// any one group is enough. The editor always holds at least one group.
/// ponytail: one level only, an OR of ANDs. `a && (b || c)` is written out as
/// `a && b || a && c`; parse a tree if that ever gets common.

const OPERATOR = /&&|\|\|/;
const clean = word => word.replace(/[()]/g, ' ').trim().replace(/\s+/g, ' ');
const words = text => [...new Set(text.split(/&&|,/).map(clean).filter(Boolean))];
const tidy = groups => {
  const kept = groups.filter(group => group.length);
  return kept.length ? kept : [[]];
};

export function parseGroups(query) {
  const text = (query || '').trim();
  // Saved before groups existed: no operator, and the spaces were the ANDs.
  if (!OPERATOR.test(text)) return [[...new Set(text.split(/\s+/).filter(Boolean))]];
  return tidy(text.split('||').map(words));
}

export const serializeGroups = groups => groups.filter(group => group.length)
  .map(group => group.join(' && ')).join(' || ');

/// Typed text joins the last group; each `||` in it starts a new one, so
/// `a && b || c` typed into an empty editor is two groups.
export function addTyped(groups, text) {
  const [first, ...rest] = text.split('||').map(words);
  const next = groups.map(group => [...group]);
  const last = next[next.length - 1];
  for (const word of first) if (!last.includes(word)) last.push(word);
  return [...next, ...rest];
}

/// The OR adds an empty group to type into, never a second one.
export const addGroup = groups => groups[groups.length - 1]?.length === 0 ? groups : [...groups, []];

export function removeGroup(groups, g) {
  return tidy(groups.filter((_, index) => index !== g));
}

export function removeWord(groups, g, i) {
  const next = groups.map(group => [...group]);
  next[g].splice(i, 1);
  return next.length > 1 && !next[g].length ? tidy(next) : next;
}

/// A drag ends: `item` is `{ kind: 'word', g, i }` or `{ kind: 'or' }`;
/// `target` is a word (`{ g, i }`), a group (`{ g }`) or `{ g: 'new' }`.
/// The OR dropped on a word splits its group there; a word dropped on the OR
/// becomes a group of its own.
export function dropItem(groups, item, target) {
  const next = groups.map(group => [...group]);
  if (item.kind === 'or') {
    if (target.g === 'new' || !(target.i > 0)) return addGroup(next);
    next.splice(target.g, 1, next[target.g].slice(0, target.i), next[target.g].slice(target.i));
    return next;
  }
  const word = next[item.g][item.i];
  if (target.g === item.g && (target.i === undefined || target.i === item.i)) return groups;
  next[item.g][item.i] = null;
  if (target.g === 'new') next.push([word]);
  else if (!next[target.g].includes(word)) next[target.g].splice(target.i ?? next[target.g].length, 0, word);
  return tidy(next.map(group => group.filter(entry => entry !== null)));
}
