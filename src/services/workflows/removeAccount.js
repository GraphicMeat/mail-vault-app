// ── removeAccount workflow — native deletion followed by renderer presentation cleanup ──

import * as db from '../db';
import { useSettingsStore } from '../../stores/settingsStore';
import { forgetAccount } from '../../stores/unreadCounts';
import { dismissAccountFollowUps } from '../../stores/followUpStore';
import { unwatchAccount } from '../syncService';
import { invalidateRestoreDescriptors as _invalidateRestore, clearGraphIdMap as _clearGraphIdMap } from '../cacheManager';


// ── removeAccount workflow ──

export async function removeAccount(accountId) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const removal = await db.deleteAccount(accountId);
  if (!removal || removal.outcome !== 'complete' || removal.accountId !== accountId
    || Object.keys(removal).length !== 2) {
    const error = new Error('errors.accountRemovalIncomplete');
    error.outcome = removal?.outcome || 'unknown';
    error.result = removal;
    throw error;
  }

  // Native removal owns session retirement. Presentation cleanup starts only
  // after its final complete result.
  unwatchAccount(accountId);
  _invalidateRestore(accountId);
  _clearGraphIdMap(accountId);

  const newAccounts = get().accounts.filter(a => a.id !== accountId);
  await forgetAccount(accountId);
  // Its follow-up reminders end with it (snooze rows have no such rule: a
  // removed account's snoozes are left to fail at their wake).
  dismissAccountFollowUps(accountId);

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
