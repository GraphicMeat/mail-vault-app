import { useSettingsStore, selectOwnAddresses } from './settingsStore';
import { useMailStore } from './mailStore';

// Every address that is the user, across all accounts: login, default From, aliases.
export function myAddresses() {
  const { accounts = [] } = useMailStore.getState();
  const settings = useSettingsStore.getState();
  const out = new Set();
  for (const account of accounts) {
    for (const a of selectOwnAddresses(settings, account)) out.add(a);
  }
  return [...out];
}
