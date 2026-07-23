// ── addAccount workflow — tests connection and persists a new account ──

import * as db from '../db';
import * as api from '../api';
import { isGraphAccount } from '../graphConfig';
import { ensureFreshToken } from '../authUtils';


// ── addAccount workflow ──

export async function addAccount(accountData) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  // Identity is email + server (imapHost / oauth2Provider), not email alone —
  // the same address on a different server is a distinct account (e.g. after a
  // provider/host change). Matches db.accountLogicalKey used in dedup.
  const newKey = db.accountLogicalKey(accountData);
  const existingAccount = get().accounts.find(a => db.accountLogicalKey(a) === newKey);
  if (existingAccount) {
    throw new Error('This email on this server is already added');
  }

  const account = {
    id: crypto.randomUUID(),
    ...accountData,
    createdAt: new Date().toISOString()
  };
  console.log('[mailStore] Created account object with id:', account.id);

  console.log('[mailStore] Testing connection...');
  try {
    if (isGraphAccount(account)) {
      const freshAccount = await ensureFreshToken(account);
      await api.graphListFolders(freshAccount.oauth2AccessToken);
    } else {
      await api.testConnection(account);
    }
    console.log('[mailStore] Connection test successful');
  } catch (error) {
    console.error('[mailStore] Connection test failed:', error);
    throw typeof error === 'string' ? new Error(error) : error;
  }

  console.log('[mailStore] Saving account to database...');
  try {
    await db.saveAccount(account);
    console.log('[mailStore] Account saved successfully');
  } catch (error) {
    console.error('[mailStore] Failed to save account:', error);
    throw error;
  }

  useMailStore.setState(state => ({
    accounts: [...state.accounts, account]
  }));
  console.log('[mailStore] Account added to store');

  if (get().accounts.length === 1) {
    await get().activateAccount(account.id, 'INBOX');
  }

  return account;
}
