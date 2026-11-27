// Accounts in sections the way the sidebar lays them out: ungrouped first,
// then each named group in first-seen order. Pure, so the settings views and
// the account picker can use it without reaching a service.
export function groupAccounts(orderedAccounts, groupOf) {
  const ungrouped = { name: null, accounts: [] };
  const named = new Map();
  for (const account of orderedAccounts) {
    const name = groupOf[account.id];
    if (!name) {
      ungrouped.accounts.push(account);
    } else {
      if (!named.has(name)) named.set(name, { name, accounts: [] });
      named.get(name).accounts.push(account);
    }
  }
  return [...(ungrouped.accounts.length || !named.size ? [ungrouped] : []), ...named.values()];
}

const flatIds = sections => sections.flatMap(section => section.accounts.map(account => account.id));

// The account order with group `name` swapped with its neighbour `delta` (-1 up, +1 down). Groups
// take their place from the account order, so this is how a group moves. Ungrouped stays first;
// null when the group cannot move.
export function moveGroup(orderedAccounts, groupOf, name, delta) {
  const sections = groupAccounts(orderedAccounts, groupOf);
  const from = sections.findIndex(section => section.name !== null && section.name === name);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= sections.length || sections[to].name === null) return null;
  [sections[from], sections[to]] = [sections[to], sections[from]];
  return flatIds(sections);
}

// The account order with group `name` dropped before group `beforeName` (null: last). Ungrouped
// stays first; null when the group is unknown or the drop changes nothing.
export function placeGroup(orderedAccounts, groupOf, name, beforeName) {
  const sections = groupAccounts(orderedAccounts, groupOf);
  const names = sections.map(section => section.name);
  const from = sections.findIndex(section => section.name !== null && section.name === name);
  if (from < 0) return null;
  const [moved] = sections.splice(from, 1);
  const to = beforeName === null ? sections.length : sections.findIndex(section => section.name === beforeName);
  if (to < 0) return null;
  sections.splice(to, 0, moved);
  return sections.every((section, index) => section.name === names[index]) ? null : flatIds(sections);
}

// The account order with section `name` (null: ungrouped) in the order `ids`.
export function reorderWithinGroup(orderedAccounts, groupOf, name, ids) {
  return groupAccounts(orderedAccounts, groupOf).flatMap(section => section.name === name
    ? ids : section.accounts.map(account => account.id));
}
