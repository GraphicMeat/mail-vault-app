// Native account authority; this adapter owns successful view effects only.
import * as db from '../db';
import { isGraphAccount } from '../graphConfig';
import { t } from '../../i18n/index.js';
export async function updateAccount(accountId, patch) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();
  const existing = get().accounts.find(a => a.id === accountId);
  if (!existing) throw new Error(t('errors.accountNotFound'));
  const reply = await db.updateAccountNative(accountId, patch, { expected: db.accountExpectedContext(existing, 'all') });
  const account = reply.account;
  useMailStore.setState(state => ({ accounts: state.accounts.map(a => a.id === accountId ? account : a) }));
  if (reply.hostChanged && !isGraphAccount(account) && get().activeAccountId === accountId) {
    try { await get().activateAccount(accountId, get().activeMailbox || 'INBOX'); }
    catch (error) { console.warn('[mailStore] Re-activation after host change failed:', error?.message || error); }
  }
  return account;
}
