// ── updateAccount workflow — re-point an existing account to a new server ──

import * as db from '../db';
import * as api from '../api';
import { isGraphAccount } from '../graphConfig';
import { ensureFreshToken } from '../authUtils';


// ── updateAccount workflow ──
// Patches an existing account IN PLACE (same id → same Maildir/creds/settings).
// Primary use: re-point a working account to a new IMAP/SMTP server after a
// provider/host change. Tests the connection against the new server before
// persisting. db.saveAccount stamps previousImapHost/hostChangedAt when the
// host actually changes, which drives the "restore local mail to new server"
// offer downstream.
export async function updateAccount(accountId, patch) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const existing = get().accounts.find(a => a.id === accountId);
  if (!existing) throw new Error('Account not found');

  const updated = { ...existing, ...patch, id: accountId, updatedAt: new Date().toISOString() };

  // Guard against colliding with a DIFFERENT existing account (same email+server).
  const updatedKey = db.accountLogicalKey(updated);
  const collision = get().accounts.find(a => a.id !== accountId && db.accountLogicalKey(a) === updatedKey);
  if (collision) throw new Error('This email on this server is already added');

  console.log('[mailStore] updateAccount — testing connection to new server...');
  try {
    if (isGraphAccount(updated)) {
      const freshAccount = await ensureFreshToken(updated);
      await api.graphListFolders(freshAccount.oauth2AccessToken);
    } else {
      await api.testConnection(updated);
    }
    console.log('[mailStore] updateAccount — connection test successful');
  } catch (error) {
    console.error('[mailStore] updateAccount — connection test failed:', error);
    throw typeof error === 'string' ? new Error(error) : error;
  }

  try {
    await db.saveAccount(updated);
  } catch (error) {
    console.error('[mailStore] updateAccount — failed to save account:', error);
    throw error;
  }

  useMailStore.setState(state => ({
    accounts: state.accounts.map(a => (a.id === accountId ? updated : a)),
  }));
  console.log('[mailStore] updateAccount — account updated in store');

  // If the IMAP host actually changed, reconnect the active account to the new
  // server. Activation's post-sync step runs checkRestoreNeeded, which offers to
  // restore local Maildir mail when the new server is near-empty.
  const hostChanged = !isGraphAccount(updated) && (existing.imapHost || '') !== (updated.imapHost || '');
  if (hostChanged && get().activeAccountId === accountId) {
    try {
      await get().activateAccount(accountId, get().activeMailbox || 'INBOX');
    } catch (e) {
      console.warn('[mailStore] updateAccount — re-activation after host change failed (non-fatal):', e?.message || e);
    }
  }

  return updated;
}
