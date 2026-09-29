// ── addAccount workflow — tests connection and persists a new account ──

import * as db from '../db';
import * as api from '../api';
import { isGraphAccount } from '../graphConfig';
import { ensureFreshToken } from '../authUtils';
import { t } from '../../i18n/index.js';


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
    throw new Error(t('errors.duplicateAccount'));
  }

  const account = {
    id: crypto.randomUUID(),
    ...accountData,
    imapSecurity: accountData.imapSecurity || 'ssl',
    createdAt: new Date().toISOString()
  };
  console.log('[mailStore] Created account object with id:', account.id);

  console.log('[mailStore] Testing connection...');
  try {
    if (isGraphAccount(account)) {
      const freshAccount = await ensureFreshToken(account);
      // A connectivity probe: the listing is discarded, and a new account has
      // no directories, so no folder-key adoption pass belongs here.
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
  // Its aliases (Gmail's send-as list, the addresses it has sent from), in
  // the background a little later: a slow lookup never holds up the add.
  import('../aliasDiscovery').then(m => m.scheduleAliasRefresh(account)).catch(() => {});

  if (get().accounts.length === 1) {
    // Fire-and-forget: activation (mailbox listing, first sync) can take far
    // longer than saving the account, and the caller (the add-account modal)
    // only needs the save to have landed before it reports success. Awaiting
    // it here held the modal's spinner up for the whole first sync.
    get().activateAccount(account.id, 'INBOX').catch(error => {
      console.error('[mailStore] First-account activation failed:', error);
    });
  }

  return account;
}
