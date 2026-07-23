// ── refreshAccounts workflow — refresh the current view or every account ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { hasValidCredentials, ensureFreshToken } from '../authUtils';
import { isGraphAccount, APP_TO_GRAPH_FOLDER_MAP, normalizeGraphFolderName } from '../graphConfig';
import { invalidateRestoreDescriptors as _invalidateRestore, getAccountCacheMailboxes as _getAccountMailboxes } from '../cacheManager';
import { _resolveMailboxPath } from '../../stores/slices/unifiedHelpers';


// ── refreshCurrentView workflow ──

export async function refreshCurrentView() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();
  const { unifiedInbox, unifiedFolder, activeAccountId, activeMailbox } = get();

  if (unifiedInbox || activeMailbox === 'UNIFIED') {
    const targetFolder = unifiedFolder || 'INBOX';
    await get().refreshAllAccounts({ mailbox: targetFolder });

    const state = get();
    if (state.unifiedInbox && (state.unifiedFolder || 'INBOX') === targetFolder) {
      await state.loadUnifiedInbox(null, targetFolder);
    }
    return;
  }

  if (activeAccountId && activeMailbox) {
    await get().activateAccount(activeAccountId, activeMailbox);
  }
}


// ── refreshAllAccounts workflow ──

export async function refreshAllAccounts(options = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { accounts, activeAccountId, unifiedInbox, unifiedFolder } = get();
  if (accounts.length === 0) return { newEmails: 0, totalUnread: 0 };
  const targetMailbox = options.mailbox || (unifiedInbox ? (unifiedFolder || 'INBOX') : 'INBOX');
  const refreshingUnifiedView = unifiedInbox || targetMailbox === 'UNIFIED';

  for (const account of accounts) {
    _invalidateRestore(account.id);
  }

  console.log('[mailStore] Refreshing all accounts...');

  let totalUnread = 0;
  const updatedUnreadPerAccount = { ...useSettingsStore.getState().unreadPerAccount };
  let previousEmailCount = get().emails.length;
  const perAccountResults = [];

  for (let account of accounts) {
    if (useSettingsStore.getState().isAccountHidden(account.id)) {
      console.log(`[mailStore] Skipping hidden account ${account.email}`);
      continue;
    }
    if (!hasValidCredentials(account)) {
      console.warn(`[mailStore] Skipping account ${account.email} - no credentials`);
      continue;
    }
    account = await ensureFreshToken(account);

    try {
      if (account.id === activeAccountId && !refreshingUnifiedView) {
        const beforeCount = get().emails.length;
        const beforeUids = new Set(get().emails.map(e => e.uid));
        await get().loadEmails();
        const currentEmails = get().emails;
        const accountUnread = currentEmails.filter(e => !e.flags?.includes('\\Seen')).length;
        totalUnread += accountUnread;
        updatedUnreadPerAccount[account.id] = accountUnread;
        const afterEmails = get().emails;
        const newForAccount = afterEmails.filter(e => !beforeUids.has(e.uid));
        if (newForAccount.length > 0) {
          const newest = newForAccount[0];
          perAccountResults.push({
            accountId: account.id,
            accountEmail: account.email,
            folder: get().activeMailbox || 'INBOX',
            newCount: newForAccount.length,
            newestSender: newest.from || newest.sender || '',
            newestSubject: newest.subject || '',
          });
        }
      } else if (isGraphAccount(account)) {
        try {
          const token = account.oauth2AccessToken;
          const folders = await api.graphListFolders(token);
          const targetGraphName = APP_TO_GRAPH_FOLDER_MAP[targetMailbox] || targetMailbox;
          const targetFolder = folders.find(f => (
            f.displayName === targetGraphName ||
            normalizeGraphFolderName(f.displayName) === targetMailbox
          ));
          if (targetFolder) {
            const normalizedMailbox = normalizeGraphFolderName(targetFolder.displayName);
            const cached = await db.getEmailHeaders(account.id, normalizedMailbox).catch(() => null);
            const cachedUids = new Set(cached?.emails?.map(e => e.uid) || []);

            const { headers } = await api.graphListMessages(token, targetFolder.id, 200, 0);
            if (headers.length > 0) {
              await db.saveEmailHeaders(account.id, normalizedMailbox, headers, targetFolder.totalItemCount);
              console.log(`[mailStore] Graph: cached ${headers.length} ${normalizedMailbox} headers for ${account.email}`);
            }
            if (normalizedMailbox === 'INBOX') {
              const graphUnread = headers.filter(e => !e.flags?.includes('\\Seen')).length;
              totalUnread += graphUnread;
              updatedUnreadPerAccount[account.id] = graphUnread;
            }

            const newHeaders = headers.filter(e => !cachedUids.has(e.uid));
            if (newHeaders.length > 0 && cachedUids.size > 0) {
              const newest = newHeaders[0];
              perAccountResults.push({
                accountId: account.id,
                accountEmail: account.email,
                folder: normalizedMailbox,
                newCount: newHeaders.length,
                newestSender: newest.from || newest.sender || '',
                newestSubject: newest.subject || '',
              });
            }
          }
        } catch (e) {
          console.warn(`[mailStore] Could not load Graph headers for ${account.email}:`, e);
        }
      } else {
        try {
          let mailboxes = _getAccountMailboxes(account.id);
          if (!mailboxes?.length) mailboxes = await db.getCachedMailboxes(account.id);
          const resolvedMailbox = _resolveMailboxPath(mailboxes || [], targetMailbox);

          const cached = await db.getEmailHeaders(account.id, resolvedMailbox).catch(() => null);
          const cachedUids = new Set(cached?.emails?.map(e => e.uid) || []);

          const allEmails = [];
          let page = 1;
          let hasMore = true;
          let total = 0;

          while (hasMore) {
            const result = await api.fetchEmails(account, resolvedMailbox, page);
            allEmails.push(...result.emails);
            total = result.total;
            hasMore = result.hasMore;
            page++;
            if (hasMore) await new Promise(r => setTimeout(r, 1000));
          }

          if (allEmails.length > 0) {
            await db.saveEmailHeaders(account.id, resolvedMailbox, allEmails, total);
            console.log(`[mailStore] Cached ${allEmails.length} ${resolvedMailbox} headers for ${account.email}`);
          }

          if (resolvedMailbox === 'INBOX') {
            const imapUnread = allEmails.filter(e => !e.flags?.includes('\\Seen')).length;
            totalUnread += imapUnread;
            updatedUnreadPerAccount[account.id] = imapUnread;
          }

          const newHeaders = allEmails.filter(e => !cachedUids.has(e.uid));
          if (newHeaders.length > 0 && cachedUids.size > 0) {
            const newest = newHeaders[0];
            perAccountResults.push({
              accountId: account.id,
              accountEmail: account.email,
              folder: resolvedMailbox,
              newCount: newHeaders.length,
              newestSender: newest.from || newest.sender || '',
              newestSubject: newest.subject || '',
            });
          }
        } catch (e) {
          console.warn(`[mailStore] Could not load headers for ${account.email}:`, e);
        }
      }
    } catch (error) {
      console.error(`[mailStore] Failed to refresh account ${account.email}:`, error);
    }
  }

  useMailStore.setState({ totalUnreadCount: totalUnread });
  useSettingsStore.getState().setUnreadPerAccount(updatedUnreadPerAccount);

  const newEmailCount = get().emails.length;
  const newEmails = Math.max(0, newEmailCount - previousEmailCount);

  console.log(`[mailStore] All accounts refreshed. Total unread: ${totalUnread}, New emails: ${newEmails}`);

  // Auto-classify all accounts in background if premium (one by one, single thread)
  const { hasPremiumAccess } = await import('../../stores/settingsStore.js');
  if (hasPremiumAccess(useSettingsStore.getState().billingProfile)) {
    import('../classificationService.js').then(({ run }) => {
      (async () => {
        for (const account of accounts) {
          if (useSettingsStore.getState().isAccountHidden(account.id)) continue;
          try {
            await run(account.id);
          } catch (e) {
            console.warn(`[mailStore] Background classification failed for ${account.email}:`, e);
          }
        }
      })();
    }).catch(() => {});
  }

  return { newEmails, totalUnread, perAccountResults };
}
