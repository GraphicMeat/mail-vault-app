export function normalizeGroupName(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 40).trim() || null;
}

export function resolveGroupName(raw, existingNames) {
  const name = normalizeGroupName(raw);
  if (!name) return null;
  return existingNames.find(existing => existing.toLocaleLowerCase() === name.toLocaleLowerCase()) || name;
}

export function groupNames(accountGroups) {
  const names = new Map();
  for (const value of Object.values(accountGroups)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const key = value.toLocaleLowerCase();
    if (names.has(key)) names.get(key).count++;
    else names.set(key, { name: value, count: 1 });
  }
  return [...names.values()];
}

export function matchGroups(groups, draft) {
  const name = normalizeGroupName(draft);
  const query = name?.toLocaleLowerCase();
  return {
    matches: query ? groups.filter(group => group.name.toLocaleLowerCase().includes(query)) : groups,
    canCreate: !!name && !groups.some(group => group.name.toLocaleLowerCase() === query),
  };
}

export { groupAccounts } from '../utils/groupAccounts';

export function accountsInScope(accounts, { hiddenAccounts = {}, accountGroups = {}, group = null } = {}) {
  return (accounts || []).filter(account => !hiddenAccounts?.[account.id]
    && (group === null || accountGroups?.[account.id] === group));
}

export function groupUnread(accounts, group, { unreadPerAccount = {}, ...scope } = {}) {
  return accountsInScope(accounts, { ...scope, group })
    .reduce((sum, account) => sum + (unreadPerAccount?.[account.id] || 0), 0);
}
