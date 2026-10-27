// ── changeServer workflow — re-point account to new server with new password ──

import * as db from '../db';
import { t } from '../../i18n/index.js';
import { isJmapAccount, jmapSessionHost } from '../providerKind.js';
import { describeConnectionError } from '../../utils/connectionError';


// ── changeServer workflow ──
// The native full server-and-password update probes before saving. OAuth
// accounts do not have a server password to re-verify in this form.
function probeError(error, candidate, jmap = false) {
  if (!Object.hasOwn(error ?? {}, 'errorCode')) return error;
  const msg = describeConnectionError(error).message;
  if (jmap) return new Error(msg);
  const smtp = error.host === candidate.smtpHost && Number(error.port) === Number(candidate.smtpPort);
  const imap = error.host === candidate.imapHost && Number(error.port) === Number(candidate.imapPort);
  if (smtp && !imap) return new Error(t('errors.smtpPrefixed', { msg }));
  if (imap && !smtp) return new Error(t('errors.imapPrefixed', { msg }));
  return new Error(msg);
}

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

  let saved;
  try {
    saved = await db.updateAccountNative(accountId, {
      imapHost, imapPort, imapSecurity: candidate.imapSecurity,
      smtpHost, smtpPort, password,
    }, { expected: db.accountExpectedContext(existing) });
  } catch (error) {
    throw probeError(error, candidate);
  }

  useMailStore.setState(state => ({
    accounts: state.accounts.map(a => (a.id === accountId ? { ...a, ...saved.account, password } : a)),
  }));

  const hostChanged = saved.hostChanged;
  if (hostChanged && get().activeAccountId === accountId) {
    try {
      await get().activateAccount(accountId, get().activeMailbox || 'INBOX');
    } catch (e) {
      console.warn('[mailStore] changeServer — re-activation after host change failed (non-fatal):', e?.message || e);
    }
  }

  return { ok: true, hostChanged };
}

// JMAP updates stay on the native JMAP probe and EmailSubmission path.
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

  const fields = { jmapSessionUrl: url, imapHost: host, password, updatedAt: candidate.updatedAt };
  const unset = [];
  if (jmapUsername !== undefined) {
    if (candidate.jmapUsername !== undefined) fields.jmapUsername = candidate.jmapUsername;
    else unset.push('jmapUsername');
  }
  let saved;
  try {
    saved = await db.updateAccountNative(accountId, fields, { unset, expected: db.accountExpectedContext(existing) });
  } catch (error) {
    throw probeError(error, candidate, true);
  }

  useMailStore.setState(state => ({
    accounts: state.accounts.map(a => { if (a.id !== accountId) return a; const next = { ...a, ...saved.account, password }; for (const k of unset) delete next[k]; return next; }),
  }));

  const hostChanged = saved.hostChanged || (existing.jmapSessionUrl || '') !== saved.account.jmapSessionUrl;
  if (hostChanged && get().activeAccountId === accountId) {
    try {
      await get().activateAccount(accountId, get().activeMailbox || 'INBOX');
    } catch (e) {
      console.warn('[mailStore] changeServer: re-activation after a session change failed (non-fatal):', e?.message || e);
    }
  }

  return { ok: true, hostChanged };
}
