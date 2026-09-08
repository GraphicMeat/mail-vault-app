// ── refreshAccounts workflow — refresh the current view or every account ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { hasValidCredentials, ensureFreshToken } from '../authUtils';
import { isGraphAccount, APP_TO_GRAPH_FOLDER_MAP, normalizeGraphFolderName } from '../graphConfig';
import { invalidateRestoreDescriptors as _invalidateRestore, getAccountCacheMailboxes as _getAccountMailboxes, listGraphMessages } from '../cacheManager';
import { invalidate as _invalidateProbe } from '../syncProbe';
import { forceMailboxRefetch } from './helpers/mailboxRefetch';
import { invalidateFolderStatus } from './folderStatus';
import { _resolveMailboxPath } from '../../stores/slices/unifiedHelpers';


// ── refreshCurrentView workflow ──

export async function refreshCurrentView() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();
  const { unifiedInbox, unifiedFolder, activeAccountId, activeMailbox, mailboxScope } = get();

  if (unifiedInbox || activeMailbox === 'UNIFIED') {
    const targetFolder = unifiedFolder || 'INBOX';
    await get().refreshAllAccounts({ mailbox: targetFolder });

    const state = get();
    if (state.unifiedInbox && (state.unifiedFolder || 'INBOX') === targetFolder) {
      await state.loadUnifiedInbox(null, targetFolder);
    }
    return;
  }

  // The third kind of view: a branch listing. activateAccount would clear its
  // scope — that is what makes an ordinary folder open ordinary — so Refresh
  // collapsed the branch to its root folder. Same rule as loadEmails().
  // No probe to invalidate here: loadSubtree fetches every folder of the
  // branch outright, it has no "checked moments ago" short-circuit.
  if (mailboxScope && activeMailbox === mailboxScope.root) {
    await get().loadSubtree(activeAccountId, mailboxScope.root);
    return;
  }

  if (activeAccountId && activeMailbox) {
    // An explicit refresh must reach the server. Without this the probe's
    // short TTL would answer "checked moments ago" and the button would look
    // broken. The probe itself still runs — if nothing changed there is
    // genuinely nothing to show, and it costs one round trip instead of a sync.
    _invalidateProbe(activeAccountId, activeMailbox);
    // Same rule for the folder list: Refresh must show a folder created
    // elsewhere now, not when the 10-minute cache runs out.
    forceMailboxRefetch(activeAccountId);
    // …and the closed folders' unread counts: activateAccount's own sweep is
    // throttled to one a minute; dropping its timestamp lets that one sweep run
    // instead of adding a second forced one.
    invalidateFolderStatus(activeAccountId);
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
    _invalidateProbe(account.id);
  }

  console.log('[mailStore] Refreshing all accounts...');

  // Only the accounts this run counted, merged into the store after the loop.
  // Seeding it from the store instead would carry a value read BEFORE
  // loadEmails() ran below, and writing that back at the end would undo the
  // recount loadEmails just made for the account on screen.
  const countedUnread = {};
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
        const beforeUids = new Set(get().emails.map(e => e.uid));
        // No badge write here. This branch reloads whatever folder is OPEN, and
        // it counted that folder — so a refresh landing while the Bin was on
        // screen put the Bin's unread on the account's badge, and a branch
        // listing put the whole subtree's. loadEmails' own derivation owns the
        // badge now, and it only writes when the open folder really is this
        // account's inbox (see updateSortedEmails).
        await get().loadEmails();
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

            const { headers } = await listGraphMessages(account.id, normalizedMailbox, token, targetFolder.id);
            if (headers.length > 0) {
              await db.saveEmailHeaders(account.id, normalizedMailbox, headers, targetFolder.totalItemCount);
              console.log(`[mailStore] Graph: cached ${headers.length} ${normalizedMailbox} headers for ${account.email}`);
            }
            if (normalizedMailbox === 'INBOX') {
              const graphUnread = headers.filter(e => !e.flags?.includes('\\Seen')).length;
              countedUnread[account.id] = graphUnread;
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
            countedUnread[account.id] = imapUnread;
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

  // Read the store LAST: the account on screen had its badge recounted by the
  // loadEmails() above, and that is the fresher number for it.
  const settings = useSettingsStore.getState();
  const unreadPerAccount = { ...settings.unreadPerAccount, ...countedUnread };
  settings.setUnreadPerAccount(unreadPerAccount);
  // Summed from the map rather than accumulated in the loop, so the accounts
  // this run skipped (already fresh, no credentials, the active one) still
  // count towards the dock badge instead of silently dropping out of it.
  const totalUnread = Object.entries(unreadPerAccount)
    .filter(([id]) => !settings.isAccountHidden(id))
    .reduce((n, [, count]) => n + (count || 0), 0);
  useMailStore.setState({ totalUnreadCount: totalUnread });

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
