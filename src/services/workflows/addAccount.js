// Native account authority; this adapter owns successful view effects only.
import * as db from '../db';
export async function addAccount(accountData) {
  const { useMailStore } = await import('../../stores/mailStore');
  const reply = await db.addAccountNative(accountData);
  const account = reply.account;
  useMailStore.setState(state => ({ accounts: [...state.accounts, account] }));
  import('../aliases').then(m => m.scheduleAliasRefresh(account)).catch(() => {});
  if (useMailStore.getState().accounts.length === 1) {
    Promise.resolve().then(() => useMailStore.getState().activateAccount(account.id, 'INBOX')).catch(error => {
      console.error('[mailStore] First-account activation failed:', error);
    });
  }
  return { ...account, connectionCheck: reply.connectionCheck };
}
