// ── changeServer workflow — re-point account to new server with new password ──

import * as db from '../db';
import * as api from '../api';
import { t } from '../../i18n/index.js';
import { isJmapAccount, jmapSessionHost } from '../providerKind.js';
import { describeConnectionError } from '../../utils/connectionError';


// ── changeServer workflow ──
// Atomic "re-point account to new server with new password" operation. Unlike
// updateAccount (which tests the connection using the account's stored — old,
// possibly gone — password), this verifies IMAP and SMTP with the NEW password
// first and persists nothing unless both legs succeed. Password/IMAP accounts
// only — OAuth accounts don't have a server password to re-verify.
export async function changeServer(accountId, { imapHost, imapPort, imapSecurity, smtpHost, smtpPort, password, jmapSessionUrl, jmapUsername }) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const existing = get().accounts.find(a => a.id === accountId);
  if (!existing) throw new Error(t('errors.accountNotFound'));

  if (existing.authType === 'oauth2') {
    throw new Error(t('errors.changeServerOauth'));
  }

  if (isJmapAccount(existing)) {
    return changeJmapServer(useMailStore, existing, { jmapSessionUrl, jmapUsername, password });
  }

  const candidate = {
    ...existing,
    imapHost, imapPort, smtpHost, smtpPort, password,
    imapSecurity: imapSecurity || 'ssl',
    id: accountId,
    updatedAt: new Date().toISOString(),
  };

  // Guard against colliding with a DIFFERENT existing account (same email+server).
  const candidateKey = db.accountLogicalKey(candidate);
  const collision = get().accounts.find(a => a.id !== accountId && db.accountLogicalKey(a) === candidateKey);
  if (collision) throw new Error(t('errors.duplicateAccount'));

  console.log('[mailStore] changeServer — verifying IMAP with new password...');
  try {
    await api.testConnection(candidate);
  } catch (error) {
    const msg = typeof error === 'string' ? error : error?.message || 'IMAP connection failed';
    throw new Error(t('errors.imapPrefixed', { msg }));
  }

  console.log('[mailStore] changeServer — verifying SMTP...');
  try {
    await api.smtpTestConnection(candidate);
  } catch (error) {
    const msg = typeof error === 'string' ? error : error?.message || 'SMTP connection failed';
    throw new Error(t('errors.smtpPrefixed', { msg }));
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

// A JMAP account keeps speaking JMAP: a new session URL and secret, proven by
// one `imap_test_connection` (the daemon answers it over JMAP) and no SMTP
// leg, since JMAP sends through EmailSubmission. `imapHost` follows the
// session host, the account's key. Editing it as IMAP would corrupt it.
async function changeJmapServer(useMailStore, existing, { jmapSessionUrl, jmapUsername, password }) {
  const get = () => useMailStore.getState();
  const accountId = existing.id;
  const url = String(jmapSessionUrl ?? existing.jmapSessionUrl ?? '').trim();
  const host = jmapSessionHost(url);
  if (!host) throw new Error(t('account.jmapSessionUrlInvalid'));

  const candidate = {
    ...existing,
    jmapSessionUrl: url,
    imapHost: host,
    password,
    id: accountId,
    updatedAt: new Date().toISOString(),
  };
  // A Basic login other than the address; empty means the address again.
  if (jmapUsername !== undefined) {
    const login = String(jmapUsername || '').trim();
    if (login && login.toLowerCase() !== String(existing.email || '').toLowerCase()) candidate.jmapUsername = login;
    else delete candidate.jmapUsername;
  }

  const candidateKey = db.accountLogicalKey(candidate);
  const collision = get().accounts.find(a => a.id !== accountId && db.accountLogicalKey(a) === candidateKey);
  if (collision) throw new Error(t('errors.duplicateAccount'));

  console.log('[mailStore] changeServer: verifying JMAP with the new secret...');
  try {
    await api.testConnection(candidate);
  } catch (error) {
    throw new Error(describeConnectionError(error).message);
  }

  await api.storePassword(accountId, password);
  await db.saveAccount(candidate);

  useMailStore.setState(state => ({
    accounts: state.accounts.map(a => (a.id === accountId ? candidate : a)),
  }));

  const hostChanged = (existing.jmapSessionUrl || '') !== url;
  if (hostChanged && get().activeAccountId === accountId) {
    try {
      await get().activateAccount(accountId, get().activeMailbox || 'INBOX');
    } catch (e) {
      console.warn('[mailStore] changeServer: re-activation after a session change failed (non-fatal):', e?.message || e);
    }
  }

  return { ok: true, hostChanged };
}
