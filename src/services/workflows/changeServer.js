// ── changeServer workflow — re-point account to new server with new password ──

import * as db from '../db';
import * as api from '../api';


// ── changeServer workflow ──
// Atomic "re-point account to new server with new password" operation. Unlike
// updateAccount (which tests the connection using the account's stored — old,
// possibly gone — password), this verifies IMAP and SMTP with the NEW password
// first and persists nothing unless both legs succeed. Password/IMAP accounts
// only — OAuth accounts don't have a server password to re-verify.
export async function changeServer(accountId, { imapHost, imapPort, smtpHost, smtpPort, password }) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const existing = get().accounts.find(a => a.id === accountId);
  if (!existing) throw new Error('Account not found');

  if (existing.authType === 'oauth2') {
    throw new Error('Change server is not available for OAuth accounts');
  }

  const candidate = {
    ...existing,
    imapHost, imapPort, smtpHost, smtpPort, password,
    id: accountId,
    updatedAt: new Date().toISOString(),
  };

  // Guard against colliding with a DIFFERENT existing account (same email+server).
  const candidateKey = db.accountLogicalKey(candidate);
  const collision = get().accounts.find(a => a.id !== accountId && db.accountLogicalKey(a) === candidateKey);
  if (collision) throw new Error('This email on this server is already added');

  console.log('[mailStore] changeServer — verifying IMAP with new password...');
  try {
    await api.testConnection(candidate);
  } catch (error) {
    const msg = typeof error === 'string' ? error : error?.message || 'IMAP connection failed';
    throw new Error(`IMAP: ${msg}`);
  }

  console.log('[mailStore] changeServer — verifying SMTP...');
  try {
    await api.smtpTestConnection(candidate);
  } catch (error) {
    const msg = typeof error === 'string' ? error : error?.message || 'SMTP connection failed';
    throw new Error(`SMTP: ${msg}`);
  }

  // Both legs verified — persist. store_password writes the OS keychain entry
  // directly (mirrors AccountSettings' handleUpdatePassword); db.saveAccount
  // persists the full account blob + accounts.json metadata, and stamps
  // previousImapHost/hostChangedAt when the host actually changed.
  console.log('[mailStore] changeServer — persisting new server + password...');
  await api.storePassword(accountId, password);
  await db.saveAccount(candidate);

  useMailStore.setState(state => ({
    accounts: state.accounts.map(a => (a.id === accountId ? candidate : a)),
  }));
  console.log('[mailStore] changeServer — account updated in store');

  const hostChanged = (existing.imapHost || '') !== (imapHost || '');
  if (hostChanged && get().activeAccountId === accountId) {
    try {
      await get().activateAccount(accountId, get().activeMailbox || 'INBOX');
    } catch (e) {
      console.warn('[mailStore] changeServer — re-activation after host change failed (non-fatal):', e?.message || e);
    }
  }

  return { ok: true, hostChanged };
}
