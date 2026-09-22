// ── refreshAccounts workflow — refresh the current view or every account ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { hasValidCredentials, ensureFreshToken } from '../authUtils';
import { isGraphAccount, storageKeyOf } from '../graphConfig';
import { adoptGraphFolderKeysFromListing } from './adoptGraphFolderKeys';
import { invalidateRestoreDescriptors as _invalidateRestore, getAccountCacheMailboxes as _getAccountMailboxes, listGraphMessages } from '../cacheManager';
import { invalidate as _invalidateProbe } from '../syncProbe';
import { forceMailboxRefetch } from './helpers/mailboxRefetch';
import { invalidateFolderStatus } from './folderStatus';
import { _resolveMailboxPath } from '../../stores/slices/unifiedHelpers';


// ── who counts as "new" ──────────────────────────────────────────────────
//
// A set difference only names arrivals when the set it subtracts already held
// the whole folder. Neither of the two sets the app had at hand qualifies: the
// open list renders 500 rows from cache and drains the rest behind it
// (loadEmails), and the disk cache is capped at one 500-header page by a cold
// daemon sync and wiped outright by a UIDVALIDITY change. Diffing a full
// server listing against either announced the whole mailbox as new mail —
// "1134 new emails" is a 1634-message INBOX minus the 500 rows that happened
// to be loaded.
//
// So the baseline is the disk cache, and it only speaks when it is provably
// complete: as many cached headers as the server says the folder holds. While
// a backfill is still running nothing is announced, which is right — none of
// those messages arrived.
//
// Counted from the cache's meta and uid listing, never its rows: this runs for
// every account on every scheduled refresh, and reading whole mailboxes of
// header rows into the webview to collect their uids was tens of MB a tick.
// An incomplete cache needs no listing — callers only read `uids` when complete.
async function arrivalBaseline(accountId, mailbox) {
  const incomplete = { uids: new Set(), complete: false };
  const meta = await db.getEmailHeadersMeta(accountId, mailbox).catch(() => null);
  const total = meta?.totalEmails ?? 0;
  if (!(total > 0) || (meta.totalCached ?? 0) < total) return incomplete;
  const listing = await db.listCachedUids(accountId, mailbox).catch(() => null);
  if (!listing) return incomplete;
  const uids = new Set(listing.uids);
  return { uids, complete: uids.size >= total };
}

// `from` is an object ({name, address}), and interpolating it into the banner
// body is where every notification's "[object Object]: <subject>" came from.
function senderLabel(email) {
  const from = email?.from;
  if (typeof from === 'string') return from;
  return from?.name || from?.address || email?.sender || '';
}

// The address alone, for the notification policy (allowlist/domain match) —
// a display name is not something anyone types into an allowlist.
function senderAddress(email) {
  const from = email?.from;
  if (typeof from === 'string') return from.includes('@') ? from : '';
  return from?.address || '';
}


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
        // Against the cache, not against the rows on screen: the open list is
        // still filling while this runs, and every row it had yet to drain
        // used to read as an arrival.
        const openMailbox = get().activeMailbox || 'INBOX';
        const baseline = await arrivalBaseline(account.id, openMailbox);
        // No badge write here. This branch reloads whatever folder is OPEN, and
        // it counted that folder — so a refresh landing while the Bin was on
        // screen put the Bin's unread on the account's badge, and a branch
        // listing put the whole subtree's. loadEmails' own derivation owns the
        // badge now, and it only writes when the open folder really is this
        // account's inbox (see updateSortedEmails).
        await get().loadEmails();
        const afterEmails = get().emails;
        const newForAccount = afterEmails.filter(e => !baseline.uids.has(e.uid));
        if (newForAccount.length > 0 && baseline.complete) {
          const newest = newForAccount[0];
          perAccountResults.push({
            accountId: account.id,
            accountEmail: account.email,
            folder: openMailbox,
            newCount: newForAccount.length,
            newestSender: senderLabel(newest),
            newestSubject: newest.subject || '',
            newestUid: newest.uid,
            newestFromAddress: senderAddress(newest),
          });
        }
      } else if (isGraphAccount(account)) {
        try {
          const token = account.oauth2AccessToken;
          const folders = await api.graphListFolders(token);
          await adoptGraphFolderKeysFromListing(account, folders);
          const targetFolder = folders.find(f => storageKeyOf(f) === targetMailbox);
          if (targetFolder) {
            const normalizedMailbox = storageKeyOf(targetFolder);
            const baseline = await arrivalBaseline(account.id, normalizedMailbox);

            const { headers } = await listGraphMessages(account.id, normalizedMailbox, token, targetFolder.id);
            if (headers.length > 0) {
              await db.saveEmailHeaders(account.id, normalizedMailbox, headers, targetFolder.totalItemCount);
              console.log(`[mailStore] Graph: cached ${headers.length} ${normalizedMailbox} headers for ${account.email}`);
            }
            if (normalizedMailbox === 'INBOX') {
              const graphUnread = headers.filter(e => !e.flags?.includes('\\Seen')).length;
              countedUnread[account.id] = graphUnread;
            }

            const newHeaders = headers.filter(e => !baseline.uids.has(e.uid));
            if (newHeaders.length > 0 && baseline.complete) {
              const newest = newHeaders[0];
              perAccountResults.push({
                accountId: account.id,
                accountEmail: account.email,
                folder: normalizedMailbox,
                newCount: newHeaders.length,
                newestSender: senderLabel(newest),
                newestSubject: newest.subject || '',
                newestUid: newest.uid,
                newestFromAddress: senderAddress(newest),
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

          const baseline = await arrivalBaseline(account.id, resolvedMailbox);

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

          const newHeaders = allEmails.filter(e => !baseline.uids.has(e.uid));
          if (newHeaders.length > 0 && baseline.complete) {
            const newest = newHeaders[0];
            perAccountResults.push({
              accountId: account.id,
              accountEmail: account.email,
              folder: resolvedMailbox,
              newCount: newHeaders.length,
              newestSender: senderLabel(newest),
              newestSubject: newest.subject || '',
              newestUid: newest.uid,
              newestFromAddress: senderAddress(newest),
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
