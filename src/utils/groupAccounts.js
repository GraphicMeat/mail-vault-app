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
