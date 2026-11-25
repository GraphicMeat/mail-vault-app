import { getAccountColor, getAccountInitial } from '../../utils/accountAvatar';
import { groupAccounts } from '../../utils/groupAccounts';

/**
 * The rows an EmailSelector shows, laid out as the sidebar lays out accounts:
 * the caller's order (the sidebar's), ungrouped accounts first, then each
 * account group under its name. Each account row may carry aliases, picked
 * on their own and drawn indented under it.
 *
 * Values are opaque to the selector: an account id, an address, or Compose's
 * "<accountId> <address>" key. The caller says which with `valueFor`.
 */
export function accountSections(accounts, {
  accountGroups = {},
  displayNames = {},
  accountColors = {},
  valueFor = a => a.id,
  addressOf = a => a.email,
  nameOf = () => '',
  aliasesOf = () => [],
  lockedOf = () => false,
} = {}) {
  return groupAccounts(accounts || [], accountGroups || {}).map(section => ({
    name: section.name,
    items: section.accounts.map(account => {
      const address = addressOf(account);
      // The account's own name counts only when it is neither its login nor the row's address.
      const own = realName(realName(account.name, account.email), address);
      const name = realName(nameOf(account), address) || realName(displayNames?.[account.id], address) || own;
      return {
        value: valueFor(account),
        account,
        address,
        name,
        color: getAccountColor(accountColors || {}, account),
        initial: getAccountInitial(account, displayNames?.[account.id]),
        locked: !!lockedOf(account),
        aliases: (aliasesOf(account) || []).map(alias => ({ ...alias, name: realName(alias.name, alias.address) })),
      };
    }),
  })).filter(section => section.items.length);
}

// A name that only repeats its address adds nothing and would show it twice.
const realName = (name, address) => (name && name.trim().toLocaleLowerCase() !== String(address || '').trim().toLocaleLowerCase() ? name : '');

const has = (text, q) => !!text && text.toLocaleLowerCase().includes(q);

/**
 * Narrow the sections to a search. A group whose name matches keeps all its
 * accounts; an account whose name or address matches keeps all its aliases;
 * an alias match keeps its account, with only the matching aliases.
 */
export function filterSections(sections, query) {
  const q = String(query || '').trim().toLocaleLowerCase();
  if (!q) return sections;
  const out = [];
  for (const section of sections) {
    if (has(section.name, q)) { out.push(section); continue; }
    const items = [];
    for (const item of section.items) {
      if (has(item.name, q) || has(item.address, q)) { items.push(item); continue; }
      const aliases = item.aliases.filter(alias => has(alias.name, q) || has(alias.address, q));
      if (aliases.length) items.push({ ...item, aliases });
    }
    if (items.length) out.push({ ...section, items });
  }
  return out;
}

/** Every row a person can land on, in order: leading rows, then each account and its aliases. */
export function selectableRows(leading, sections) {
  const rows = (leading || []).map(row => ({ ...row, kind: 'leading' }));
  for (const section of sections) {
    for (const item of section.items) {
      rows.push({ kind: 'account', value: item.value, address: item.address, name: item.name, item });
      for (const alias of item.aliases) {
        rows.push({ kind: 'alias', value: alias.value, address: alias.address, name: alias.name || '', item });
      }
    }
  }
  return rows;
}

/** The row holding `value`; failing an exact match, one equal but for case (a stored address in other case). */
export function findRow(leading, sections, value) {
  const rows = selectableRows(leading, sections);
  const lower = String(value ?? '').toLocaleLowerCase();
  return rows.find(row => row.value === value) || rows.find(row => String(row.value).toLocaleLowerCase() === lower) || null;
}
