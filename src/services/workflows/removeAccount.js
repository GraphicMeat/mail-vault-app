// ── removeAccount workflow — disconnects, deletes account, and re-activates next ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { isGraphAccount } from '../graphConfig';
import { invalidateRestoreDescriptors as _invalidateRestore, clearGraphIdMap as _clearGraphIdMap } from '../cacheManager';


// ── removeAccount workflow ──

export async function removeAccount(accountId) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const account = get().accounts.find(a => a.id === accountId);
  if (account && !isGraphAccount(account)) {
    try {
      await api.disconnect(account);
    } catch (e) {
      // Ignore disconnect errors
    }
  }

  await db.deleteAccount(accountId);
  _invalidateRestore(accountId);
  _clearGraphIdMap(accountId);

  const newAccounts = get().accounts.filter(a => a.id !== accountId);
  const { [accountId]: _removed, ...remainingUnread } = useSettingsStore.getState().unreadPerAccount;
  useSettingsStore.getState().setUnreadPerAccount(remainingUnread);

  useMailStore.setState({ accounts: newAccounts });

  const isLastAccount = newAccounts.length === 0;
  let billingLogoutWarning = null;
  if (isLastAccount) {
    const settings = useSettingsStore.getState();
    const { billingProfile, billingEmail } = settings;
    if (billingProfile?.customerId && billingEmail) {
      try {
        const { unregisterBillingClient, getClientInfo } = await import('../billingApi');
        const clientInfo = await getClientInfo();
        await unregisterBillingClient({
          customerId: billingProfile.customerId,
          email: billingEmail,
          clientId: clientInfo.clientId,
        });
        console.log('[removeAccount] Billing client unregistered successfully');
      } catch (e) {
        console.warn('[removeAccount] Failed to unregister billing client:', e.message);
        billingLogoutWarning = 'Could not release the Premium device seat. This device may still count toward your device limit until the subscription syncs.';
      }
    }
    settings.clearBillingProfile();
  }

  if (get().activeAccountId === accountId) {
    const { hiddenAccounts } = useSettingsStore.getState();
    const nextVisible = newAccounts.find(a => !hiddenAccounts[a.id]);
    if (nextVisible) {
      const lastMailbox = useSettingsStore.getState().getLastMailbox(nextVisible.id);
      await get().activateAccount(nextVisible.id, lastMailbox || 'INBOX');
    } else {
      useMailStore.setState({
        activeAccountId: null,
        mailboxes: [],
        mailboxesFetchedAt: null,
        emails: [],
        localEmails: [],
        savedEmailIds: new Set(),
        archivedEmailIds: new Set(),
        selectedEmailId: null,
        selectedEmail: null,
        selectedEmailSource: null,
        selectedThread: null
      });
    }
  }

  return { billingLogoutWarning };
}
