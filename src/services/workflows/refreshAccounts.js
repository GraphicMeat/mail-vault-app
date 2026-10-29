// ── refreshAccounts workflow — refresh the current view or every account ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { mergeRecounts, rawUnreadProjection, unreadPresentation } from '../../stores/unreadCounts';
import { accountExpectedContext } from '../db/accounts';
import { hasValidCredentials } from '../authUtils';
import { isGraphAccount, storageKeyOf } from '../graphConfig';
import { adoptGraphFolderKeysFromListing } from './adoptGraphFolderKeys';
import { invalidateRestoreDescriptors as _invalidateRestore, getAccountCacheMailboxes as _getAccountMailboxes, listGraphMessages } from '../cacheManager';
import { invalidate as _invalidateProbe } from '../syncProbe';
import { forceMailboxRefetch } from './helpers/mailboxRefetch';
import { invalidateFolderStatus } from './folderStatus';
import { loadLocalFolders } from './folderOps';
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
//
// Complete is a COUNT, and a count does not prove the rows are comparable: a
// writer that recorded its own row count as the folder total makes a partial
// cache read complete, a lost row leaves a hole, and a UIDVALIDITY change
// re-issues the whole uid space. So `arrivals` below also asks what the
// daemon asks (sync_engine `uid >= cached_uid_next`): a delivery is numbered
// above everything the cache held.
async function arrivalBaseline(accountId, mailbox) {
  const incomplete = { uids: new Set(), high: 0, complete: false };
  const meta = await db.getEmailHeadersMeta(accountId, mailbox).catch(() => null);
  const total = meta?.totalEmails ?? 0;
  if (!(total > 0) || (meta.totalCached ?? 0) < total) return incomplete;
  const listing = await db.listCachedUids(accountId, mailbox).catch(() => null);
  if (!listing) return incomplete;
  const uids = new Set(listing.uids);
  let high = 0;
  for (const uid of uids) if (uid > high) high = uid;
  return { uids, high, complete: uids.size >= total };
}

// The rows of `rows` that are deliveries since `baseline`, in `rows` order.
function arrivals(baseline, rows) {
  if (!baseline.complete) return [];
  return rows.filter(e => e.uid > baseline.high && !baseline.uids.has(e.uid));
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
    const probeInvalidation = _invalidateProbe(activeAccountId, activeMailbox);
    // Same rule for the folder list: Refresh must show a folder created
    // elsewhere now, not when the 10-minute cache runs out.
    forceMailboxRefetch(activeAccountId);
    // …and the closed folders' unread counts: activateAccount's own sweep is
    // throttled to one a minute; dropping its timestamp lets that one sweep run
    // instead of adding a second forced one.
    await Promise.all([probeInvalidation, invalidateFolderStatus(activeAccountId)]);
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

  const expectedSource = new Map(accounts.map(account =>
    [account.id, JSON.stringify(accountExpectedContext(account, 'all'))]));
  const invalidSource = new Set();
  const checkSources = state => {
    for (const [id, original] of expectedSource) {
      const current = state.accounts.find(account => account.id === id);
      if (!current || JSON.stringify(accountExpectedContext(current, 'all')) !== original) invalidSource.add(id);
    }
  };
  const unsubscribeSources = useMailStore.subscribe?.(checkSources) || (() => {});
  try {

  const probeInvalidations = new Map();
  for (const account of accounts) {
    _invalidateRestore(account.id);
    probeInvalidations.set(account.id, _invalidateProbe(account.id));
    // Also picks up a folder an import made elsewhere, and an added account.
    loadLocalFolders(account.id);
  }

  console.log('[mailStore] Refreshing all accounts...');

  // Only the accounts this run counted, merged into the store after the loop.
  // Seeding it from the store instead would carry a value read BEFORE
  // loadEmails() ran below, and writing that back at the end would undo the
  // recount loadEmails just made for the account on screen.
  const countedUnread = [];
  let previousEmailCount = get().emails.length;
  const perAccountResults = [];
  // `accountId`: Retry on one account's connection notice refreshes it alone.
  const failed = new Set();

  for (let account of accounts) {
    if (options.accountId && account.id !== options.accountId) continue;
    if (useSettingsStore.getState().isAccountHidden(account.id)) {
      console.log(`[mailStore] Skipping hidden account ${account.email}`);
      continue;
    }
    if (!hasValidCredentials(account)) {
      console.warn(`[mailStore] Skipping account ${account.email} - no credentials`);
      failed.add(account.id);
      continue;
    }
    try {
      await probeInvalidations.get(account.id);
      if (account.id === activeAccountId && !refreshingUnifiedView) {
        // Against the cache, not against the rows on screen: the open list is
        // still filling while this runs, and every row it had yet to drain
        // used to read as an arrival.
        const opened = get();
        const openMailbox = opened.activeMailbox || 'INBOX';
        const openScope = opened.mailboxScope;
        const baseline = await arrivalBaseline(account.id, openMailbox);
        // No badge write here. This branch reloads whatever folder is OPEN, and
        // it counted that folder — so a refresh landing while the Bin was on
        // screen put the Bin's unread on the account's badge, and a branch
        // listing put the whole subtree's. loadEmails' own derivation owns the
        // badge now, and it only writes when the open folder really is this
        // account's inbox (see updateSortedEmails).
        await get().loadEmails();
        const now = get();
        // The rows are one folder's only while that folder is still what is
        // open: a branch listing holds every folder under its root, and a
        // folder or account the user moved to during the await is not the one
        // the baseline describes.
        const stillThere = now.activeAccountId === account.id
          && (now.activeMailbox || 'INBOX') === openMailbox
          && !openScope && !now.mailboxScope;
        const newForAccount = stillThere ? arrivals(baseline, now.emails) : [];
        if (newForAccount.length > 0) {
          const newest = newForAccount[0];
          perAccountResults.push({
            accountId: account.id,
            accountEmail: account.email,
            folder: openMailbox,
            newCount: newForAccount.length,
            uids: newForAccount.map(e => e.uid),
            newestSender: senderLabel(newest),
            newestSubject: newest.subject || '',
            newestUid: newest.uid,
            newestFromAddress: senderAddress(newest),
            newestSnippet: newest.snippet || '',
          });
        }
      } else if (isGraphAccount(account)) {
        try {
          const folders = await api.graphListFolders(account);
          await adoptGraphFolderKeysFromListing(account, folders);
          const targetFolder = folders.find(f => storageKeyOf(f) === targetMailbox);
          if (targetFolder) {
            const normalizedMailbox = storageKeyOf(targetFolder);
            const baseline = await arrivalBaseline(account.id, normalizedMailbox);

            const { headers } = await listGraphMessages(account.id, normalizedMailbox, account, targetFolder.id);
            if (headers.length > 0) {
              await db.saveEmailHeaders(account.id, normalizedMailbox, headers, targetFolder.totalItemCount);
              console.log(`[mailStore] Graph: cached ${headers.length} ${normalizedMailbox} headers for ${account.email}`);
            }
            if (normalizedMailbox === 'INBOX') {
              countedUnread.push({ accountId: account.id,
                cache: { emails: headers, totalEmails: targetFolder.totalItemCount },
                projection: rawUnreadProjection() });
            }

            const newHeaders = arrivals(baseline, headers);
            if (newHeaders.length > 0) {
              const newest = newHeaders[0];
              perAccountResults.push({
                accountId: account.id,
                accountEmail: account.email,
                folder: normalizedMailbox,
                newCount: newHeaders.length,
                uids: newHeaders.map(e => e.uid),
                newestSender: senderLabel(newest),
                newestSubject: newest.subject || '',
                newestUid: newest.uid,
                newestFromAddress: senderAddress(newest),
                newestSnippet: newest.snippet || '',
              });
            }
          }
        } catch (e) {
          console.warn(`[mailStore] Could not load Graph headers for ${account.email}:`, e);
          failed.add(account.id);
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

          // Only a complete listing is a count (unreadCounts).
          if (resolvedMailbox === 'INBOX') {
            countedUnread.push({ accountId: account.id,
              cache: { emails: allEmails, totalEmails: total },
              projection: rawUnreadProjection() });
          }

          const newHeaders = arrivals(baseline, allEmails);
          if (newHeaders.length > 0) {
            const newest = newHeaders[0];
            perAccountResults.push({
              accountId: account.id,
              accountEmail: account.email,
              folder: resolvedMailbox,
              newCount: newHeaders.length,
              uids: newHeaders.map(e => e.uid),
              newestSender: senderLabel(newest),
              newestSubject: newest.subject || '',
              newestUid: newest.uid,
              newestFromAddress: senderAddress(newest),
              newestSnippet: newest.snippet || '',
            });
          }
        } catch (e) {
          console.warn(`[mailStore] Could not load headers for ${account.email}:`, e);
          failed.add(account.id);
        }
      }
    } catch (error) {
      console.error(`[mailStore] Failed to refresh account ${account.email}:`, error);
      failed.add(account.id);
    }
  }

  // A retried account that reached its server is connected again: nothing in
  // All Inboxes clears the status otherwise. A failure leaves `error` as it is.
  if (options.accountId && options.accountId === get().activeAccountId && !failed.has(options.accountId)) {
    useMailStore.setState({ connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
  }

  // All Inboxes is built from each account's cache, which the loop above only
  // wrote: repaint it, or the new mail waits for a manual Refresh. Re-read the
  // store, the user may have left the view while this ran.
  const after = get();
  if (after.unifiedInbox || after.activeMailbox === 'UNIFIED') {
    await after.loadUnifiedInbox?.(null, after.unifiedFolder || 'INBOX');
  }

  // Merged LAST: the account on screen had its badge recounted by the
  // loadEmails() above, and that is the fresher number for it. The dock badge's
  // total is derived from the counts (unreadCounts), so the accounts this run
  // skipped (already fresh, no credentials, the active one) still count.
  checkSources(get());
  await mergeRecounts(countedUnread.filter(item => !invalidSource.has(item.accountId)));
  const totalUnread = (await unreadPresentation())?.total ?? 0;

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
  } finally {
    unsubscribeSources();
  }
}
