export function normalizeGroupName(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 40).trim() || null;
}

export function resolveGroupName(raw, existingNames) {
  const name = normalizeGroupName(raw);
  if (!name) return null;
  return existingNames.find(existing => existing.toLocaleLowerCase() === name.toLocaleLowerCase()) || name;
}

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

export function accountsInScope(accounts, { hiddenAccounts = {}, accountGroups = {}, group = null } = {}) {
  return (accounts || []).filter(account => !hiddenAccounts?.[account.id]
    && (group === null || accountGroups?.[account.id] === group));
}

export function groupUnread(accounts, group, { unreadPerAccount = {}, ...scope } = {}) {
  return accountsInScope(accounts, { ...scope, group })
    .reduce((sum, account) => sum + (unreadPerAccount?.[account.id] || 0), 0);
}
