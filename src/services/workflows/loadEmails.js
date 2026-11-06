import { refreshDraftProjection, projectDraftRows, projectDraftUids, projectDraftKeyedUids } from '../draftProjection';
// ── loadEmails workflow — email list loading, Graph API path, sent headers ──

import * as db from '../db';
import * as api from '../api';
import { useConnectivityStore } from '../../stores/connectivityStore';
import { hasValidCredentials, resolveServerAccount } from '../authUtils';
import { oauthErrorState } from '../oauthErrors';
import { isGraphAccount, graphFoldersToMailboxes, graphMessageToEmail } from '../graphConfig';
import { pickGraphCursor, graphCursorAfter, graphPageArgs } from '../graphCursor';
import { syncNow, waitForSync, getSyncStatus, toSyncAccount } from '../syncService';
import { adoptGraphFolderKeysFromListing } from './adoptGraphFolderKeys';
import { saveRestoreDescriptor as _saveRestore, listGraphMessages as _listGraphMessages, getGraphMessageId, restoreGraphIdMap as _restoreGraphIdMap, getAccountCacheMailboxes } from '../cacheManager';
import { _buildRestoreDescriptor, rebaseFlags, vaultKey, vaultKeys, vaultUids } from '../../stores/slices/unifiedHelpers';
import { paintMovedFlags } from '../../stores/messageRows';
import { serverUids } from '../../stores/slices/serverUids';
import { serverVerifiedPatch, refuseEmptyOnce, clearEmptyRefusals, EMPTY_REVERIFY_MS } from '../../stores/slices/syncSlice';
import { createPerfTrace } from '../../utils/perfTrace';
import { useSettingsStore } from '../../stores/settingsStore';
import { waitForSentMailboxPath, sentMailboxPathFor, mergesSentIntoThreads } from '../../utils/sentFolder';
import { takeForcedMailboxRefetch } from './helpers/mailboxRefetch';
import { isLocalMailbox } from './mailboxTree';
import { _drainCache } from './loadMoreEmails';
import {
  _resetNetworkRetry, _scheduleNetworkRetry,
  getLoadAbortController, setLoadAbortController,
  getLoadMoreTimer, setLoadMoreTimer,
  getLoadEmailsGeneration, bumpLoadEmailsGeneration,
  getLoadEmailsRetried, setLoadEmailsRetried,
  bumpFlagChangeCounter, invalidateChatAndThreadCaches, setArchivedGroup,
} from '../../stores/slices/messageListSlice';
import { t } from '../../i18n/index.js';


/**
 * Turn a "nothing changed" verdict into proof of the mailbox's uid set.
 *
 * A delta check that finds the server unchanged since the cache was written
 * says nothing about whether the STORE's uid set is the whole mailbox — and
 * that set is exactly what the row icons read ("server unknown" until
 * proven). The daemon path already refuses to short-circuit on an unchanged
 * verdict while completeness is unproven (activateAccount.js); the IMAP
 * branches used to return early with no proof at all, so a mailbox that
 * opened from a cleared store, or whose daemon wait timed out, stayed
 * "server unknown" for the rest of the visit. One UID SEARCH, only when
 * unproven, is the whole cost.
 *
 * Never claims on an empty listing against a non-empty mailbox (a desynced
 * reply), and never writes over a view that moved on during the round trip.
 */
export async function proveServerUidsIfUnproven(account, mailbox, serverTotal) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();
  const { activeAccountId, activeMailbox, serverUids: current } = get();
  if (current.complete || activeMailbox !== mailbox) return;

  let uids;
  try {
    uids = await api.searchAllUids(account, mailbox);
  } catch (e) {
    console.warn('[serverUids] Could not prove %s/%s, leaving it unproven:', activeAccountId, mailbox, e?.message || e);
    return;
  }
  if (uids.length === 0 && serverTotal > 0) {
    console.warn('[serverUids] UID SEARCH returned 0 but EXISTS=%d — not claiming completeness', serverTotal);
    return;
  }
  const now = get();
  if (now.activeAccountId !== activeAccountId || now.activeMailbox !== mailbox) return;
  useMailStore.setState({ serverUids: serverUids(new Set(uids), { complete: true }) });
  now.updateSortedEmails();
}


// ── Suspicious empty result detection helper ──

let _emptyVerifyTimer = null;

function isSuspiciousEmptyEmailResult(serverTotal, cachedHeaders, savedEmailIds) {
  if (serverTotal > 0) return false;
  const cachedTotal = cachedHeaders?.totalEmails || cachedHeaders?.lastKnownGoodTotalEmails || 0;
  const savedCount = savedEmailIds?.size || 0;
  return cachedTotal > 0 || savedCount > 0;
}


// ── a vault-only folder's list ──

/**
 * List a vault-only folder (MBOX import mode 3) from the vault: its mail is
 * archived vault rows and nothing else, which the list derivation shows from
 * `localEmails` the way it shows any vault row. No server holds the folder,
 * so this is the whole load, and a reload is this again (a vault rescan).
 *
 * Unknown is not empty: a vault that cannot be read keeps the rows on screen.
 * `isCurrent` lets the caller's own abort stop a paint as well.
 */
export async function loadLocalFolder(accountId, mailbox, { isCurrent = () => true } = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();
  const generation = bumpLoadEmailsGeneration();
  const draftFrame = await refreshDraftProjection();
  const here = () => getLoadEmailsGeneration() === generation && isCurrent() && get().activeAccountId === accountId && get().activeMailbox === mailbox;
  const settle = { loading: false, loadingMore: false, restoring: false, hasMoreEmails: false };

  if (!here()) return;
  const vault = await db.getVaultUidSets(accountId, mailbox, draftFrame);
  if (!here()) return;
  if (!vault) {
    console.warn('[loadLocalFolder] vault unreadable for %s/%s, keeping the rows shown', accountId, mailbox);
    useMailStore.setState(settle);
    return;
  }
  setArchivedGroup(accountId, mailbox, vault.archived);
  useMailStore.setState({ savedEmailIds: vaultKeys(accountId, mailbox, vault.saved), archivedEmailIds: vaultKeys(accountId, mailbox, vault.archived) });
  // Painted per batch: a large import is read in pages.
  const paint = (rows) => {
    if (!here()) return;
    const archived = projectDraftUids(vault.archived, accountId, mailbox, draftFrame);
    setArchivedGroup(accountId, mailbox, archived);
    useMailStore.setState({ localEmails: projectDraftRows(rows, accountId, mailbox, draftFrame), totalEmails: archived.size,
      savedEmailIds: vaultKeys(accountId, mailbox, projectDraftUids(vault.saved, accountId, mailbox, draftFrame)),
      archivedEmailIds: vaultKeys(accountId, mailbox, archived), ...settle });
    get().updateSortedEmails();
  };
  paint(await db.getArchivedEmails(accountId, mailbox, vault.archived, paint, draftFrame) || []);
}


// ── loadEmails workflow ──

// `rereadFlags`: the daemon synced a flag change (read or starred on another
// device) into the cache and the mailbox's modseq with it, so no exit below
// sees a difference. The store's rows take their flags from the cache.
export async function loadEmails({ rereadFlags = false } = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { activeAccountId, accounts, activeMailbox, mailboxScope } = get();
  let account = accounts.find(a => a.id === activeAccountId);
  if (!account) return;

  // A vault-only folder is not on any server: before the credential check and
  // the Graph branch (which relists a server's folders when it cannot find
  // this one), a reload of it is a vault rescan.
  if (isLocalMailbox(get().localFolders, activeAccountId, activeMailbox)) {
    await loadLocalFolder(activeAccountId, activeMailbox);
    return;
  }

  // A branch listing is not a folder this workflow can reload: it is
  // single-mailbox by construction (SELECT, CONDSTORE, uid pagination) and has
  // never read `mailboxScope`. Every reload ends up here — a move, a delete,
  // refreshAllAccounts — so the list silently became the branch ROOT alone
  // while the heading still said "across N folders" and the other folders'
  // mail had simply gone (bson73, discussion #1). activateAccount clears the
  // scope BEFORE it loads, so an ordinary folder open never reaches this.
  if (mailboxScope && activeMailbox === mailboxScope.root) {
    await get().loadSubtree(activeAccountId, mailboxScope.root);
    return;
  }

  // Early bail if credentials are missing
  if (!hasValidCredentials(account)) {
    useMailStore.setState({
      loading: false,
      loadingMore: false,
      connectionStatus: 'error',
      connectionError: t('svc.loadEmails.passwordFoundPleaseReEnter'),
      connectionErrorType: 'passwordMissing',
    });
    return;
  }

  const loadTrace = createPerfTrace('loadEmails', { accountId: activeAccountId, mailbox: activeMailbox });

  _resetNetworkRetry();

  // Abort any previous progressive loading
  const prevController = getLoadAbortController();
  if (prevController) prevController.abort();
  const newController = new AbortController();
  setLoadAbortController(newController);
  const loadSignal = newController.signal;

  // Bump generation
  const generation = bumpLoadEmailsGeneration();
  const draftFrame = await refreshDraftProjection();

  const isStale = () => get().activeAccountId !== activeAccountId || get().activeMailbox !== activeMailbox || getLoadEmailsGeneration() !== generation;

  // Safety: clear stuck loading state after 20s
  const loadingGuard = setTimeout(() => {
    if (get().activeAccountId === activeAccountId && get().loading) {
      console.warn('[loadEmails] Loading timeout — clearing stuck loading state after 20s');
      const hasEmails = get().emails.length > 0;
      useMailStore.setState({
        loading: false,
        loadingMore: false,
        ...(!hasEmails ? {
          connectionStatus: 'error',
          connectionError: t('svc.activateAccount.loadingTimedOutTapRefresh'),
          connectionErrorType: 'timeout'
        } : {})
      });
      loadTrace.mark('loading-guard-fired');
    }
  }, 20000);

  try {
    loadTrace.mark('token-ready', { email: account.email });

    // ── Graph API path ──
    if (isGraphAccount(account)) {
      return await _loadEmailsViaGraph(account, activeAccountId, activeMailbox, generation, draftFrame);
    }

    const invoke = window.__TAURI__?.core?.invoke;

    // CONDSTORE fast-path
    const storeHasIds = get().savedEmailIds.size > 0;
    const cacheIsFresh = storeHasIds && get().emails.length > 0;

    let savedEmailIds, archivedEmailIds, cachedHeaders;
    if (cacheIsFresh && storeHasIds) {
      savedEmailIds = get().savedEmailIds;
      archivedEmailIds = get().archivedEmailIds;
      cachedHeaders = await db.getEmailHeadersMeta(activeAccountId, activeMailbox);
    } else {
      let vault;
      [vault, cachedHeaders] = await Promise.all([
        db.getVaultUidSets(activeAccountId, activeMailbox, draftFrame),
        db.getEmailHeadersMeta(activeAccountId, activeMailbox),
      ]);
      // I-5: `null` means "could not read" — keep the store's current values
      // rather than adopting "nothing is archived" (this disarms the
      // empty-server guard and re-downloads the whole mailbox further down).
      savedEmailIds = vaultKeys(activeAccountId, activeMailbox, vault?.saved) ?? get().savedEmailIds;
      archivedEmailIds = vaultKeys(activeAccountId, activeMailbox, vault?.archived) ?? get().archivedEmailIds;
      setArchivedGroup(activeAccountId, activeMailbox, vault?.archived ?? null);
    }
    if (isStale()) return;
    loadTrace.mark('cache-meta-ready', {
      cacheIsFresh: !!cacheIsFresh,
      cachedTotal: cachedHeaders?.totalCached || 0,
      savedCount: savedEmailIds?.size || 0,
      archivedCount: archivedEmailIds?.size || 0,
    });
    savedEmailIds = projectDraftKeyedUids(savedEmailIds, activeAccountId, activeMailbox, draftFrame);
    archivedEmailIds = projectDraftKeyedUids(archivedEmailIds, activeAccountId, activeMailbox, draftFrame);
    useMailStore.setState({ savedEmailIds, archivedEmailIds });

    // Fire-and-forget: load archived email headers from disk in background
    if (archivedEmailIds.size > 0 && (get().localEmails || []).length === 0) {
      const archivedAccount = activeAccountId;
      (async () => {
        try {
          let localEmails = await db.readLocalEmailIndex(activeAccountId, activeMailbox, draftFrame);
          if (!localEmails) {
            localEmails = await db.getArchivedEmails(activeAccountId, activeMailbox, vaultUids(archivedEmailIds, activeAccountId, activeMailbox), undefined, draftFrame);
          }
          if (isStale() || get().activeAccountId !== archivedAccount || loadSignal.aborted) return;
          useMailStore.setState({ localEmails: projectDraftRows(localEmails, activeAccountId, activeMailbox, draftFrame) });
          get().updateSortedEmails();
        } catch (e) {
          console.warn('[loadEmails] archived emails failed:', e);
        }
      })();
    }

    // Use existing emails from store
    const existingStoreEmails = get().emails;
    const hasExistingEmails = existingStoreEmails.length > 0;
    console.log('[loadEmails] Decision point: hasExistingEmails=%s (%d), cachedHeaders.totalCached=%s, loading=%s',
      hasExistingEmails, existingStoreEmails.length, cachedHeaders?.totalCached ?? 'null', get().loading);

    if (hasExistingEmails) {
      useMailStore.setState({
        loading: false,
        loadingMore: true,
        error: null,
        totalEmails: cachedHeaders?.totalEmails ?? existingStoreEmails.length,
        hasMoreEmails: existingStoreEmails.length < (cachedHeaders?.totalEmails ?? existingStoreEmails.length)
      });
      get().updateSortedEmails();
      loadTrace.mark('existing-emails-reused', {
        existingCount: existingStoreEmails.length,
        totalEmails: cachedHeaders?.totalEmails ?? existingStoreEmails.length,
      });

      // The daemon writes a new message's sidecar BEFORE it announces the
      // change, so by the time a repaint runs the row is already on disk — and
      // every reconcile exit below (condstore-noop, flag-only, delta-noop)
      // compares the daemon's own post-sync uidNext/modseq against the server,
      // finds them identical because the daemon made them so, and returns
      // without ever reading a cache ROW. The one call that does,
      // getEmailHeadersPartial, sits in the branch below that only an EMPTY
      // store reaches — which is why switching accounts was the only way to
      // see new mail. Draining here is branch-independent: whichever exit
      // fires, the row is already in the store.
      const drained = await _drainCache(
        activeAccountId, activeMailbox, new Set(existingStoreEmails.map(e => e.uid))
      );
      if (isStale()) return;
      if (rereadFlags) {
        const cached = await db.getEmailHeadersByUids(
          activeAccountId, activeMailbox, existingStoreEmails.map(e => e.uid)
        ).catch(() => []);
        if (isStale()) return;
        // The cache is right about every row it holds, whichever container the
        // message is in: the list, the reader, the open thread, the body cache,
        // a search hit. The list's own row being current says nothing about the
        // reader's (a flag-only reconcile above commits `emails` alone). Only
        // what differs is painted: the list can hold five figures of rows and
        // the echo of the user's own STORE differs in none of them.
        if (paintMovedFlags(cached, get().emails)) {
          bumpFlagChangeCounter();
          invalidateChatAndThreadCaches();
          get().updateSortedEmails();
        }
      }
      if (drained) {
        // Dedupe against the LIVE store — activateAccount or a flag write may
        // have committed rows while the cache read was in flight.
        const current = get();
        const loadedUids = new Set(current.emails.map(e => e.uid));
        const fresh = drained.emails.filter(e => !loadedUids.has(e.uid));
        const widenedServerUids = new Set(current.serverUids.uids);
        for (const e of drained.emails) widenedServerUids.add(e.uid);
        useMailStore.setState({
          emails: [...current.emails, ...fresh],
          totalEmails: drained.total,
          hasMoreEmails: drained.hasMore,
          cachedCount: drained.cached,
          // Widening, never replacing: a complete set stays complete, an
          // incomplete one stays incomplete.
          serverUids: serverUids(widenedServerUids, { complete: current.serverUids.complete }),
        });
        get().updateSortedEmails();
        loadTrace.mark('cache-drained', { drained: fresh.length, totalEmails: drained.total });
      }
    } else if (cachedHeaders && cachedHeaders.totalCached > 0) {
      console.log('[loadEmails] Store empty, loading 200 from cache (total cached: %d)', cachedHeaders.totalCached);
      const partialHeaders = await db.getEmailHeadersPartial(activeAccountId, activeMailbox, 500);
      if (isStale()) return;

      if (partialHeaders && partialHeaders.emails.length > 0) {
        useMailStore.setState({
          emails: projectDraftRows(partialHeaders.emails, activeAccountId, activeMailbox, draftFrame),
          loadedRanges: [{ start: 0, end: partialHeaders.emails.length }],
          totalEmails: cachedHeaders.totalEmails,
          loading: false,
          loadingMore: true,
          error: null,
          currentPage: Math.ceil(partialHeaders.emails.length / 200) || 1,
          hasMoreEmails: partialHeaders.emails.length < cachedHeaders.totalEmails
        });
        get().updateSortedEmails();
        loadTrace.mark('partial-cache-rendered', {
          emailCount: partialHeaders.emails.length,
          totalEmails: cachedHeaders.totalEmails,
        });
      }
    } else {
      console.log('[loadEmails] No cached headers, starting fresh');
      useMailStore.setState({
        loading: true,
        error: null,
        currentPage: 1,
        hasMoreEmails: true,
        totalEmails: 0,
        loadedRanges: [],
        emails: []
      });
      get().updateSortedEmails();
      loadTrace.mark('fresh-empty-state-rendered');
    }

    // The degraded exits below (credentials, offline, a failed load) keep what
    // is shown and never write `emails`: a snapshot taken here and put back
    // after these awaits would revert a flag written meanwhile.

    // Resolve credentialed account
    const resolved = await resolveServerAccount(activeAccountId, account);
    if (!resolved.ok) {
      console.error('[loadEmails] Credentials missing for account:', account.email);
      if (!isStale()) useMailStore.setState({
        connectionStatus: 'error',
        connectionError: t('svc.loadEmails.passwordFoundPleaseReEnter'),
        connectionErrorType: 'passwordMissing',
        loading: false,
        loadingMore: false
      });
      loadTrace.end('missing-credentials');
      return;
    }
    account = resolved.account;

    // Check network connectivity
    if (invoke) {
      try {
        const isOnline = await useConnectivityStore.getState().probe();
        if (isStale()) return;
        console.log('[loadEmails] Network connectivity result:', isOnline);
        if (isOnline === false) {
          console.error('[loadEmails] No network connectivity detected!');
          if (!isStale()) useMailStore.setState({
            connectionStatus: 'error',
            connectionError: t('svc.loadEmails.noInternetConnectionShowingCached'),
            connectionErrorType: 'offline',
            loading: false,
            loadingMore: false
          });
          loadTrace.end('offline');
          return;
        }
      } catch (e) {
        console.warn('[loadEmails] Could not check network connectivity:', e);
        if (isStale()) return;
        console.error('[loadEmails] Connectivity check failed, assuming offline');
        useMailStore.setState({
          connectionStatus: 'error',
          connectionError: t('svc.loadEmails.couldCheckInternetConnectionShowing'),
          connectionErrorType: 'offline',
          loading: false,
          loadingMore: false
        });
        loadTrace.end('connectivity-check-failed');
        return;
      }
    } else {
      if (!navigator.onLine) {
        console.error('[loadEmails] Browser reports offline');
        useMailStore.setState({
          connectionStatus: 'error',
          connectionError: t('svc.loadEmails.noInternetConnectionShowingCached'),
          connectionErrorType: 'offline',
          loading: false,
          loadingMore: false
        });
        loadTrace.end('browser-offline');
        return;
      }
    }

    // ── Delta-sync: check mailbox status before fetching ──
    const existingEmails = get().emails;
    const cachedUidValidity = cachedHeaders?.uidValidity;
    const cachedUidNext = cachedHeaders?.uidNext;
    const cachedHighestModseq = cachedHeaders?.highestModseq;
    const hasCachedSync = cachedUidValidity != null && cachedUidNext != null && existingEmails.length > 0;
    // Re-armed the moment the server reports ANY mail, so a mailbox that
    // empties later still gets its one free re-verify. This has to happen
    // where serverTotal is first known, not at the guard below: the
    // CONDSTORE-noop, flag-only and delta-noop fast paths all return before
    // the guard, and those are the branches a healthy mailbox takes.
    const emptyKey = `${activeAccountId}:${activeMailbox}`;

    let mergedEmails;
    // UIDs the delta-sync found gone server-side — the only thing allowed to
    // delete sidecars, since the store is a window onto a larger cache.
    let prunedUids = [];
    let serverTotal;
    let newUidValidity;
    let newUidNext;
    let newHighestModseq;
    let _loadMoreTimer;
    // Set explicitly (both true and false) only by the two page-1-fetch
    // branches below, which know whether their own listing is the whole
    // mailbox. Left undefined everywhere else so the common setState at the
    // bottom carries the store's current claim forward — the UID-search
    // delta-sync branch proves it directly via searchAllUids.
    let provedComplete;
    // The listing below replaces the uid space (UIDVALIDITY changed): a uid
    // written to before is not the message that holds it now.
    let uidSpaceReplaced = false;

    if (hasCachedSync) {
      const status = await api.checkMailboxStatus(account, activeMailbox);
      loadTrace.mark('mailbox-status-ready', {
        exists: status.exists,
        uidNext: status.uidNext,
        highestModseq: status.highestModseq ?? null,
      });
      newUidValidity = status.uidValidity;
      newUidNext = status.uidNext;
      newHighestModseq = status.highestModseq ?? null;
      serverTotal = status.exists;
      if (serverTotal > 0) clearEmptyRefusals(emptyKey);

      if (newUidValidity !== cachedUidValidity) {
        console.log('[loadEmails] UIDVALIDITY changed (%d -> %d), full reload', cachedUidValidity, newUidValidity);
        await db.clearMailboxCache(activeAccountId, activeMailbox);
        uidSpaceReplaced = true;
        const serverResult = await api.fetchEmails(account, activeMailbox, 1);
        serverTotal = serverResult.total;
        mergedEmails = serverResult.emails.map((email, idx) => ({
          ...email,
          displayIndex: idx,
          isLocal: savedEmailIds.has(vaultKey(activeAccountId, activeMailbox, email.uid)),
          source: 'server'
        }));
        // This single page IS the whole mailbox exactly when it already
        // reaches serverTotal — proven by data this fetch already returned,
        // no extra round trip. UIDVALIDITY changing means any earlier proof
        // is void regardless of which way this comes out, so state it
        // explicitly rather than leaving the old value in place.
        provedComplete = mergedEmails.length >= serverTotal;
      } else if (
        newHighestModseq != null && cachedHighestModseq != null &&
        newHighestModseq === cachedHighestModseq &&
        newUidNext === cachedUidNext &&
        status.exists >= existingEmails.length * 0.5
      ) {
        setLoadEmailsRetried(false);
        useMailStore.setState({
          connectionStatus: 'connected',
          connectionError: null,
          connectionErrorType: null,
          loadingMore: false
        });
        get().updateSortedEmails();
        useMailStore.setState({ loading: false, loadingMore: false });
        await proveServerUidsIfUnproven(account, activeMailbox, serverTotal);
        if (isStale()) return;
        loadTrace.end('condstore-noop', {
          existingCount: existingEmails.length,
          serverTotal,
        });
        if (existingEmails.length < serverTotal) {
          console.log('[loadEmails] CONDSTORE: store partial (%d/%d), loading remaining from cache...', existingEmails.length, serverTotal);
          useMailStore.setState({ hasMoreEmails: true, totalEmails: serverTotal });
          _loadMoreTimer = getLoadMoreTimer();
          if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
          setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, 200));
        }
        return;
      } else if (
        newHighestModseq != null && cachedHighestModseq != null &&
        newHighestModseq !== cachedHighestModseq &&
        newUidNext === cachedUidNext &&
        // Expunges (delete/move-to-Trash) bump modseq WITHOUT changing UIDNEXT,
        // and CONDSTORE CHANGEDSINCE cannot report them — flag-only sync is only
        // safe when the server message count still matches the last-synced total.
        // Otherwise fall through to the UID-search delta sync so deleted emails
        // get pruned instead of resurrecting from the header cache.
        status.exists === (cachedHeaders?.totalEmails ?? existingEmails.length)
      ) {
        console.log('[loadEmails] CONDSTORE: flag-only sync (modseq %s -> %s)', cachedHighestModseq, newHighestModseq);
        try {
          const changes = await api.fetchChangedFlags(account, activeMailbox, cachedHighestModseq);
          if (isStale()) return;

          if (changes.length > 0) {
            const changeMap = new Map(changes.map(c => [c.uid, c.flags]));
            mergedEmails = existingEmails.map((email, idx) => {
              const newFlags = changeMap.get(email.uid);
              return {
                ...email,
                displayIndex: idx,
                flags: newFlags || email.flags
              };
            });
            serverTotal = status.exists;
            console.log('[loadEmails] CONDSTORE: updated flags for %d emails', changes.length);
          } else {
            useMailStore.setState({
              connectionStatus: 'connected',
              connectionError: null,
              connectionErrorType: null,
              loadingMore: false
            });
            get().updateSortedEmails();
            useMailStore.setState({ loading: false, loadingMore: false });
            await proveServerUidsIfUnproven(account, activeMailbox, serverTotal);
            if (isStale()) return;
            loadTrace.end('condstore-flags-only', {
              changedFlags: changes.length,
              serverTotal,
            });
            if (existingEmails.length < serverTotal) {
              console.log('[loadEmails] CONDSTORE flag-sync: store partial (%d/%d), scheduling loadMoreEmails', existingEmails.length, serverTotal);
              useMailStore.setState({ hasMoreEmails: true, totalEmails: serverTotal });
              _loadMoreTimer = getLoadMoreTimer();
              if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
              setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, 200));
            }
            return;
          }
        } catch (e) {
          console.warn('[loadEmails] CONDSTORE flag sync failed, falling back to UID search:', e);
          mergedEmails = null;
        }
      } else if (newUidNext === cachedUidNext && serverTotal === (cachedHeaders?.totalCached ?? existingEmails.length)) {
        useMailStore.setState({
          connectionStatus: 'connected',
          connectionError: null,
          connectionErrorType: null,
          loadingMore: false,
          totalEmails: serverTotal
        });
        get().updateSortedEmails();
        useMailStore.setState({ loading: false, loadingMore: false });
        await proveServerUidsIfUnproven(account, activeMailbox, serverTotal);
        if (isStale()) return;
        loadTrace.end('delta-noop', {
          existingCount: existingEmails.length,
          serverTotal,
        });
        if (existingEmails.length < serverTotal) {
          console.log('[loadEmails] Delta-sync: store partial (%d/%d), scheduling loadMoreEmails', existingEmails.length, serverTotal);
          useMailStore.setState({ hasMoreEmails: true });
          _loadMoreTimer = getLoadMoreTimer();
          if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
          setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, 200));
        }
        return;
      }

      // UID search delta-sync
      if (mergedEmails == null && newUidValidity === cachedUidValidity) {
        const serverUidList = await api.searchAllUids(account, activeMailbox);
        // Sanity guard: an empty search result while the server reports a
        // non-empty mailbox is a flaky/desynced response — pruning on it would
        // blank the whole list. Keep current state and let the next sync retry.
        if (serverUidList.length === 0 && status.exists > 0) {
          console.warn('[loadEmails] UID SEARCH returned 0 but EXISTS=%d — ignoring suspicious empty result', status.exists);
          useMailStore.setState({ loading: false, loadingMore: false });
          return;
        }
        const foundUids = new Set(serverUidList);
        useMailStore.setState({ serverUids: serverUids(foundUids, { complete: true }) });
        const storeUidSet = new Set(existingEmails.map(e => e.uid));

        const newUids = cachedUidNext
          ? serverUidList.filter(uid => uid >= cachedUidNext)
          : serverUidList.filter(uid => !storeUidSet.has(uid));
        const deletedUids = existingEmails.filter(e => !foundUids.has(e.uid)).map(e => e.uid);
        prunedUids = deletedUids;

        let updatedEmails = existingEmails;
        if (deletedUids.length > 0) {
          const deletedSet = new Set(deletedUids);
          updatedEmails = updatedEmails.filter(e => !deletedSet.has(e.uid));
        }

        if (newUids.length > 0) {
          const sortedNewUids = [...newUids].sort((a, b) => b - a);
          const { emails: newHeaders } = await api.fetchHeadersByUids(account, activeMailbox, sortedNewUids);
          const newEmailsWithMeta = newHeaders.map(email => ({
            ...email,
            isLocal: savedEmailIds.has(vaultKey(activeAccountId, activeMailbox, email.uid)),
            source: 'server'
          }));
          updatedEmails = [...newEmailsWithMeta, ...updatedEmails];
        }

        mergedEmails = updatedEmails.map((email, idx) => ({
          ...email,
          displayIndex: idx
        }));
        serverTotal = status.exists;
      }
    } else {
      // No cached sync metadata — fall back to page-1 fetch
      console.log('[loadEmails] Fresh fetch: %s mailbox=%s authType=%s', account.email, activeMailbox, account.authType);
      const serverResult = await api.fetchEmails(account, activeMailbox, 1);
      serverTotal = serverResult.total;
      if (serverTotal > 0) clearEmptyRefusals(emptyKey);
      console.log('[loadEmails] Fresh fetch result: %d emails, total=%d', serverResult.emails?.length || 0, serverTotal);
      newUidValidity = null;
      newUidNext = null;
      newHighestModseq = null;

      try {
        const status = await api.checkMailboxStatus(account, activeMailbox);
        newUidValidity = status.uidValidity;
        newUidNext = status.uidNext;
        newHighestModseq = status.highestModseq ?? null;
      } catch (e) {
        console.warn('[loadEmails] Could not get mailbox status for caching:', e);
      }

      const existingUids = new Set(existingEmails.map(e => e.uid));
      const newEmails = serverResult.emails.filter(e => !existingUids.has(e.uid));

      const serverUids = new Set(serverResult.emails.map(e => e.uid));
      let cleanedExisting = existingEmails;
      if (existingEmails.length > 0 && serverResult.total < existingEmails.length) {
        const page1Size = serverResult.emails.length;
        const overlapSlice = existingEmails.slice(0, page1Size);
        const staleUids = overlapSlice.filter(e => !serverUids.has(e.uid)).map(e => e.uid);
        if (staleUids.length > 0) {
          console.log(`[loadEmails] Removing ${staleUids.length} stale UIDs no longer on server`);
          const staleSet = new Set(staleUids);
          cleanedExisting = existingEmails.filter(e => !staleSet.has(e.uid));
        }
      }

      if (cleanedExisting.length > 0 && newEmails.length < serverResult.emails.length) {
        const newEmailsWithIndex = newEmails.map((email, idx) => ({
          ...email,
          displayIndex: idx,
          isLocal: savedEmailIds.has(vaultKey(activeAccountId, activeMailbox, email.uid)),
          source: 'server'
        }));
        const shiftedExisting = cleanedExisting.map((email, idx) => ({
          ...email,
          displayIndex: newEmails.length + idx,
          isLocal: savedEmailIds.has(vaultKey(activeAccountId, activeMailbox, email.uid))
        }));
        mergedEmails = [...newEmailsWithIndex, ...shiftedExisting];
      } else {
        mergedEmails = serverResult.emails.map((email, idx) => ({
          ...email,
          displayIndex: idx,
          isLocal: savedEmailIds.has(vaultKey(activeAccountId, activeMailbox, email.uid)),
          source: 'server'
        }));
        // Same proof as the UIDVALIDITY-changed branch above: mergedEmails
        // here is exactly this fetch's own page, nothing merged in from
        // cleanedExisting, so reaching serverTotal really does mean the
        // whole mailbox fit on one page. The `if` branch just above mixes
        // in cleanedExisting rows past the checked overlap window — not
        // provable the same way, so it leaves completeness untouched.
        provedComplete = mergedEmails.length >= serverTotal;
      }
    }

    // ── Suspicious empty guard ──
    // Refuse the first "this mailbox is empty" that contradicts local
    // evidence, re-ask, then believe the answer. The guard used to refuse it
    // for ever and park a banner: it returned BEFORE the cache write, so
    // `cachedHeaders.totalEmails` kept the stale count (and caches.js
    // deliberately preserves `lastKnownGoodTotalEmails` across empty saves),
    // and vault copies count as evidence too - so a folder that genuinely
    // emptied, everything archived into the vault or drained by a filter,
    // re-tripped the same guard on every sync tick, folder switch and app
    // start. "Showing cached data while verifying" promised a verification
    // nothing ever ran.
    //
    // What makes believing it safe is a layer down: `imap/mod.rs::selected()`
    // rejects the dead-socket SELECT shape (no UIDVALIDITY, no FLAGS) as
    // `connection lost`, and every producer of `serverTotal` here - page
    // fetch and CONDSTORE status alike - is behind it. A lost connection now
    // throws into the catch below and takes the retry path; an EXISTS 0 that
    // reaches this line came off a live socket that answered properly.
    if (isSuspiciousEmptyEmailResult(serverTotal, cachedHeaders, savedEmailIds) && (!mergedEmails || mergedEmails.length === 0)) {
      if (refuseEmptyOnce(emptyKey)) {
        console.warn(
          '[loadEmails] Server returned 0 emails for %s/%s but prior cache had %d, Maildir has %d - re-verifying once',
          account.email, activeMailbox,
          cachedHeaders?.totalEmails || cachedHeaders?.lastKnownGoodTotalEmails || 0,
          savedEmailIds?.size || 0
        );
        useMailStore.setState(serverVerifiedPatch());
        if (_emptyVerifyTimer) clearTimeout(_emptyVerifyTimer);
        _emptyVerifyTimer = setTimeout(() => {
          _emptyVerifyTimer = null;
          const now = get();
          if (now.activeAccountId === activeAccountId && now.activeMailbox === activeMailbox) now.loadEmails();
        }, EMPTY_REVERIFY_MS);
        loadTrace.end('suspicious-empty-reverifying', {
          serverTotal,
          cachedTotal: cachedHeaders?.totalEmails || 0,
          savedCount: savedEmailIds?.size || 0,
        });
        return;
      }
      console.warn(
        '[loadEmails] Server says %s/%s is empty on a second look - accepting it',
        account.email, activeMailbox
      );
      mergedEmails = [];
    }

    const currentPage = Math.ceil(mergedEmails.length / 200) || 1;
    const hasMoreEmails = mergedEmails.length < serverTotal;

    if (isStale()) {
      console.log('[loadEmails] Account changed during fetch, discarding results for', activeAccountId);
      return;
    }

    // Everything above awaited the network on a snapshot of the list: a flag
    // the user wrote meanwhile (opening a message marks it read) is in the
    // store but not in mergedEmails, and committing it would revert the row
    // and, through the sidecar write below, the disk. Read the live rows here,
    // in the commit's own tick.
    if (!uidSpaceReplaced) mergedEmails = rebaseFlags(existingEmails, get().emails, mergedEmails, get());

    const existingServerUidSet = get().serverUids.uids;
    const mergedServerUidSet = existingServerUidSet.size > 0
      ? new Set([...existingServerUidSet, ...mergedEmails.map(e => e.uid)])
      : new Set(mergedEmails.map(e => e.uid));

    setLoadEmailsRetried(false);
    useMailStore.setState({
      emails: projectDraftRows(mergedEmails, activeAccountId, activeMailbox, draftFrame),
      loadedRanges: [{ start: 0, end: mergedEmails.length }],
      connectionStatus: 'connected',
      connectionError: null,
      connectionErrorType: null,
      currentPage,
      hasMoreEmails,
      totalEmails: serverTotal,
      loadingMore: false,
      serverUids: serverUids(mergedServerUidSet, {
        complete: provedComplete !== undefined ? provedComplete : get().serverUids.complete,
      }),
    });

    get().updateSortedEmails();
    loadTrace.end('server-headers-merged', {
      mergedCount: mergedEmails.length,
      serverTotal,
      hasMoreEmails,
    });

    // Descriptor saved on switch-away, not after every load
    db.saveEmailHeaders(activeAccountId, activeMailbox, mergedEmails, serverTotal, {
      uidValidity: newUidValidity,
      uidNext: newUidNext,
      highestModseq: newHighestModseq ?? null,
      serverUids: get().serverUids.uids,
      removedUids: prunedUids,
    }).catch(e => console.warn('[loadEmails] Failed to cache headers:', e));

    if (hasMoreEmails) {
      _loadMoreTimer = getLoadMoreTimer();
      if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
      setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, 200));
    }
  } catch (error) {
    console.error('[loadEmails] Failed to load emails:', error);

    let errorType = 'serverError';
    let errorMessage = error.message;
    const oauthState = oauthErrorState(error);

    if (oauthState) {
      ({ errorType, errorMessage } = oauthState);
    } else if (error.message?.includes('authenticated but not connected') || error.message?.includes('Command Error. 12')) {
      errorType = 'outlookOAuth';
      errorMessage = 'Microsoft IMAP connection failed. This is a known Microsoft server issue affecting personal Outlook.com accounts with OAuth2. See FAQ for details.';
    } else if (error.message?.includes('XOAUTH2 auth failed')) {
      errorType = 'oauthExpired';
      const { oauthSignInFailedMessage } = await import('../graphConfig');
      errorMessage = oauthSignInFailedMessage(get().accounts.find(a => a.id === get().activeAccountId));
    } else if (error.message?.includes('password') || error.message?.includes('authentication') || error.message?.includes('No password') || error.message?.includes('Login failed') || error.message?.includes('auth failed')) {
      errorType = 'passwordMissing';
      errorMessage = 'Authentication failed. Please check your password in Settings.';
    } else if (error.message?.includes('network') || error.message?.includes('timeout') || error.message?.includes('ENOTFOUND') || error.message?.includes('ECONNREFUSED') || error.message?.includes('Server unreachable')) {
      errorType = 'offline';
      errorMessage = error.message;
    }

    if (!isStale()) {
      useMailStore.setState({
        connectionStatus: 'error',
        connectionError: errorMessage,
        connectionErrorType: errorType,
        connectionErrorCode: null,
      });
      get().updateSortedEmails();

      const noRetry = errorType === 'passwordMissing' || errorType === 'oauthExpired' || errorType === 'outlookOAuth';
      if (!noRetry) {
        _scheduleNetworkRetry({ getState: get });
      }
    }
    loadTrace.end('error', { message: error.message });
  } finally {
    clearTimeout(loadingGuard);
    if (!isStale()) useMailStore.setState({ loading: false, loadingMore: false, loadingProgress: null });
  }
}


// ── Graph tail revalidation ──

// A reload lists the newest page and keeps the older rows already paged in. Those
// were not listed, so nothing says a message in them was deleted elsewhere, read
// elsewhere or came back from another client. This walks the stretch between the
// page and the oldest kept row, in the background, and applies what it finds.
// Once per folder per few minutes: it is a listing of everything the user paged
// through, and Microsoft throttles by the request.
const _graphRevalidations = new Map();
const REVALIDATE_EVERY_MS = 5 * 60 * 1000;
const REVALIDATE_RETRY_MS = 60 * 1000;
const REVALIDATE_PAUSE_MS = 100;
/** The running revalidation of a folder (resolved when none runs). */
export const _graphRevalidationFor = (key) => _graphRevalidations.get(key)?.running ?? Promise.resolve();
export const _resetGraphRevalidation = () => _graphRevalidations.clear();

function _revalidateGraphTail({ account, accountId, mailbox, folderId, from, floorMoment, pageUids, pageOldestMs }) {
  const key = `${accountId}:${mailbox}`;
  const entry = _graphRevalidations.get(key) || {};
  // A walk that failed (a 429 most likely) waits a minute, not five, but it waits.
  if (entry.running || (entry.at && Date.now() - entry.at < (entry.ok ? REVALIDATE_EVERY_MS : REVALIDATE_RETRY_MS))) return;
  _graphRevalidations.set(key, entry);
  entry.running = (async () => {
    try {
      const { useMailStore } = await import('../../stores/mailStore');
      const get = () => useMailStore.getState();
      const base = get().emails;
      const listed = new Map();
      let cursor = from;
      let reachedEnd = false;
      // Every moment a page ended on, and the page edge this walk started at:
      // Graph orders same-second mail arbitrarily, so a row tied with one of
      // them may merely have been left off a page. It is never taken for gone.
      const edges = new Set([from.before]);
      for (;;) {
        const page = await _listGraphMessages(accountId, mailbox, account, folderId, graphPageArgs(cursor, key, 200));
        const rows = page.headers || [];
        for (const r of rows) listed.set(r.uid, r);
        cursor = graphCursorAfter(key, rows, cursor);
        edges.add(cursor.before);
        if (!rows.length || !page.nextLink) { reachedEnd = true; break; }
        // Past the oldest kept row: everything newer than it is listed.
        if (floorMoment && cursor.before && cursor.before <= floorMoment) break;
        await new Promise(resolve => setTimeout(resolve, REVALIDATE_PAUSE_MS));
      }
      const lowMs = reachedEnd || !floorMoment ? -Infinity : Date.parse(floorMoment);

      // Read and committed in one tick: nothing here awaits between them.
      const cur = get();
      const stillThere = cur.activeAccountId === accountId && cur.activeMailbox === mailbox;
      const present = (uid) => listed.has(uid) || pageUids.has(uid);
      const goneUids = new Set((stillThere ? cur.emails : base)
        // Strictly inside the stretch: Graph orders same-second mail arbitrarily, so a
        // row tied with either edge may simply have been left off a page.
        .filter(e => e.source !== 'local' && !present(e.uid) && !edges.has(e.date)
          && _headerDateMs(e) > lowMs && _headerDateMs(e) < pageOldestMs)
        .map(e => e.uid));
      const incoming = rebaseFlags(base, cur.emails, [...listed.values()], cur);
      if (stillThere) {
        const held = new Map(cur.emails.map(e => [e.uid, e]));
        // Not a message the user deleted while the walk ran: its tombstone says so.
        const deleted = cur.deleteTombstones;
        const fresh = incoming.filter(r => !deleted?.has(`${accountId}|${mailbox}|${r.uid}`)).map(r => ({
          ...r, source: 'server',
          isLocal: held.get(r.uid)?.isLocal ?? cur.savedEmailIds.has(vaultKey(accountId, mailbox, r.uid)),
        }));
        const byUid = new Map(fresh.map(r => [r.uid, r]));
        const kept = cur.emails.filter(e => !goneUids.has(e.uid)).map(e => byUid.get(e.uid) ?? e);
        const added = fresh.filter(r => !held.has(r.uid));
        const uids = new Set(cur.serverUids.uids);
        for (const r of fresh) uids.add(r.uid);
        for (const uid of goneUids) uids.delete(uid);
        useMailStore.setState({
          emails: [...kept, ...added],
          serverUids: serverUids(uids, { complete: cur.serverUids.complete }),
        });
        get().updateSortedEmails();
      }
      await db.saveEmailHeaders(accountId, mailbox, incoming, null, { removedUids: [...goneUids] });
      entry.ok = true;
    } catch (e) {
      entry.ok = false;
      console.warn('[loadEmailsViaGraph] Could not re-check the older rows:', e);
    } finally {
      entry.at = Date.now();
      entry.running = null;
    }
  })();
}

// ── _loadEmailsViaGraph workflow ──

/** A header's received time in ms, or NaN when it carries no parseable date. */
function _headerDateMs(email) {
  return Date.parse(email?.internalDate || email?.date || '');
}

export async function _loadEmailsViaGraph(account, activeAccountId, activeMailbox, generation, draftFrame) {
  draftFrame ||= await refreshDraftProjection();
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const isStale = () => get().activeAccountId !== activeAccountId || get().activeMailbox !== activeMailbox || getLoadEmailsGeneration() !== generation;

  await _restoreGraphIdMap(activeAccountId, activeMailbox);
  if (isStale()) return;

  const vault = await db.getVaultUidSets(activeAccountId, activeMailbox, draftFrame);
  if (isStale()) return;
  // I-5: keep the store's current values on a failed read instead of
  // adopting "nothing is in the vault".
  const savedEmailIds = vaultKeys(activeAccountId, activeMailbox, vault?.saved) ?? get().savedEmailIds;
  const archivedEmailIds = vaultKeys(activeAccountId, activeMailbox, vault?.archived) ?? get().archivedEmailIds;
  setArchivedGroup(activeAccountId, activeMailbox, vault?.archived ?? null);
  useMailStore.setState({ savedEmailIds, archivedEmailIds });

  if (archivedEmailIds.size > 0 && (get().localEmails || []).length === 0) {
    const archivedAccount = activeAccountId;
    db.getArchivedEmails(activeAccountId, activeMailbox, vaultUids(archivedEmailIds, activeAccountId, activeMailbox), (batchEmails) => {
      if (isStale() || get().activeAccountId !== archivedAccount) return;
      useMailStore.setState({ localEmails: projectDraftRows(batchEmails, activeAccountId, activeMailbox, draftFrame) });
      get().updateSortedEmails();
    }, draftFrame).catch(e => console.warn('[loadEmailsViaGraph] getArchivedEmails failed:', e));
  }

  useMailStore.setState({ loading: get().emails.length === 0, loadingMore: true, error: null });

  // Snapshot before the fetch — diffed against the listing below to find
  // messages deleted server-side.
  const priorEmails = get().emails;

  try {
    const cachedMailboxEntry = await db.getCachedMailboxEntry(activeAccountId).catch(() => null);
    let mailboxes = cachedMailboxEntry?.mailboxes || get().mailboxes || [];
    const cachedTarget = mailboxes.find(m => m.path === activeMailbox && m._graphFolderId);

    const shouldUseFreshMailboxCacheLocal = (entry) => {
      const isMailboxCacheFresh = (fetchedAt) => !!fetchedAt && (Date.now() - fetchedAt) < 10 * 60 * 1000;
      const isMailboxTreeComplete = (mboxes = []) => {
        let count = 0;
        const visit = (nodes) => { for (const n of nodes || []) { count += 1; if (n.children?.length) visit(n.children); } };
        visit(mboxes);
        if (count === 0) return false;
        if (count > 1) return true;
        return !!mboxes[0] && mboxes[0].path !== 'INBOX';
      };
      return isMailboxCacheFresh(entry?.fetchedAt) && isMailboxTreeComplete(entry?.mailboxes);
    };

    // A list cached before folders carried a count cannot say how long this
    // folder is, however young: the total below would be the page's length.
    const shouldRefreshMailboxes = takeForcedMailboxRefetch(activeAccountId) || !shouldUseFreshMailboxCacheLocal(cachedMailboxEntry) || cachedTarget?._graphTotal == null;

    if (shouldRefreshMailboxes) {
      const graphFolders = await api.graphListFolders(account);
      await adoptGraphFolderKeysFromListing(account, graphFolders);
      if (isStale()) return;
      mailboxes = graphFoldersToMailboxes(graphFolders);
      useMailStore.setState({ mailboxes, mailboxesFetchedAt: Date.now() });
      db.saveMailboxes(activeAccountId, mailboxes);
    } else if (mailboxes.length > 0) {
      useMailStore.setState({ mailboxes, mailboxesFetchedAt: cachedMailboxEntry?.fetchedAt ?? null });
    }

    const targetFolder = mailboxes.find(m => m.path === activeMailbox);
    if (!targetFolder || !targetFolder._graphFolderId) {
      console.warn('[loadEmailsViaGraph] No matching folder for', activeMailbox);
      useMailStore.setState({ loading: false, loadingMore: false, connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
      return;
    }

    const result = await _listGraphMessages(
      activeAccountId, activeMailbox, account, targetFolder._graphFolderId
    );
    if (isStale()) return;

    const headers = result.headers || [];

    let mergedEmails = headers.map((email, idx) => ({
      ...email,
      displayIndex: idx,
      isLocal: savedEmailIds.has(vaultKey(activeAccountId, activeMailbox, email.uid)),
      source: 'server',
    }));
    // The listing was fetched over a snapshot (priorEmails): keep a flag the
    // user wrote while it was on the wire.
    mergedEmails = rebaseFlags(priorEmails, get().emails, mergedEmails, get());

    const hasMoreEmails = !!result.nextLink;
    const key = `${activeAccountId}:${activeMailbox}`;
    const heldCursor = get()._graphCursor;
    const pageCursor = graphCursorAfter(key, headers, null);
    const picked = pickGraphCursor(heldCursor, key, headers);

    const graphUids = new Set(mergedEmails.map(e => e.uid));
    const pageDates = mergedEmails.map(_headerDateMs).filter(Number.isFinite);
    const pageOldestMs = pageDates.length ? Math.min(...pageDates) : Infinity;

    // A reload lists the newest page. The older rows already paged in stay:
    // dropping them cut a long list back to one page, and the scroll position
    // with it. Only when the held cursor vouches for them and nothing can sit
    // between them and this page: the folder is longer than a page, the held
    // cursor reaches further back than the page does, and the page meets the
    // rows held (one of its messages is already listed). A page that does not
    // meet them (mail arrived while the app was away, or came back from another
    // folder) leaves a stretch no cursor covers, so the held rows go and paging
    // lists it. Rows tied with the page's oldest moment stay: `<=`. NaN fails
    // the comparison, so a row with no date is not kept on a guess.
    const heldServer = get().emails.filter(e => e.source !== 'local');
    const meetsHeld = heldServer.some(e => graphUids.has(e.uid));
    const vouched = hasMoreEmails && picked === heldCursor && meetsHeld;
    const cursor = vouched ? heldCursor : pageCursor;
    const kept = vouched
      ? heldServer.filter(e => !graphUids.has(e.uid) && _headerDateMs(e) <= pageOldestMs)
      : [];
    const listed = kept.length ? [...mergedEmails, ...kept] : mergedEmails;
    // The uid set says what the SERVER listed: the page, and kept rows it
    // already vouched for (not the rows a cache paint added).
    const confirmed = get().serverUids.uids;
    const confirmedUids = kept.length
      ? [...graphUids, ...kept.map(e => e.uid).filter(uid => confirmed.has(uid))]
      : [...graphUids];

    // One page is not the folder: with a next page behind it the total is the
    // folder's own count, or load-more has nothing to count toward.
    const serverTotal = hasMoreEmails ? Math.max(listed.length, targetFolder._graphTotal || 0) : mergedEmails.length;

    useMailStore.setState({
      emails: projectDraftRows(listed, activeAccountId, activeMailbox, draftFrame),
      loadedRanges: [{ start: 0, end: listed.length }],
      connectionStatus: 'connected',
      connectionError: null,
      connectionErrorType: null,
      currentPage: 1,
      _graphCursor: cursor,
      hasMoreEmails,
      totalEmails: serverTotal,
      loading: false,
      loadingMore: false,
      serverUids: serverUids(confirmedUids, { complete: !hasMoreEmails }),
    });

    get().updateSortedEmails();

    // Graph has no UIDVALIDITY/UID SEARCH, so the only expunge signal is a
    // message vanishing from this listing. Name the gone UIDs explicitly —
    // nothing else prunes Graph sidecars, and a leftover one resurrects.
    // Only the window this page covers is authoritative; outside it, unknown.
    //
    // That window is a range of DATES, not of uids. Graph uids are allocated
    // first-seen over a `receivedDateTime desc` listing, so the seed counted
    // uid 1 down into the past and later arrivals took the highest numbers of
    // all — uid 1 is on page 1 of every mailbox, which made the old
    // `uid >= lowestGraphUid` test true for every prior row and let a
    // 200-message page delete the rest of a warm cache as server-expunged.
    // NaN fails every comparison, so a row we can't date is never inside the
    // window and never deleted on a guess.
    const removedUids = priorEmails
      .filter(e => !graphUids.has(e.uid) && _headerDateMs(e) > pageOldestMs)
      .map(e => e.uid);

    // Descriptor saved on switch-away, not after every load
    db.saveEmailHeaders(activeAccountId, activeMailbox, mergedEmails, serverTotal, { removedUids })
      .catch(e => console.warn('[loadEmailsViaGraph] Failed to cache headers:', e));

    // The older rows this reload kept were not listed: check them against the
    // server in the background (gone elsewhere, flags changed, restored mail).
    if (kept.length) {
      _revalidateGraphTail({
        account, accountId: activeAccountId, mailbox: activeMailbox, folderId: targetFolder._graphFolderId,
        from: pageCursor, floorMoment: heldCursor.before, pageUids: graphUids, pageOldestMs,
      });
    }

  } catch (error) {
    console.error('[loadEmailsViaGraph] Failed:', error);

    let errorType = 'serverError';
    let errorMessage = error.message;
    const oauthState = oauthErrorState(error);

    if (oauthState) {
      ({ errorType, errorMessage } = oauthState);
    } else if (error.message?.includes('network') || error.message?.includes('timeout')) {
      errorType = 'offline';
    } else if (error.message?.includes('401') || error.message?.includes('Unauthorized')) {
      errorType = 'passwordMissing';
      errorMessage = 'Authentication failed. Your token may have expired. Please re-authenticate in Settings.';
    }

    if (!isStale()) {
      useMailStore.setState({
        connectionStatus: 'error',
        connectionError: errorMessage,
        connectionErrorType: errorType,
        connectionErrorCode: null,
      });
      get().updateSortedEmails();
    }
  } finally {
    if (!isStale()) useMailStore.setState({ loading: false, loadingMore: false });
  }
}


// ── loadSentHeaders workflow ──

// Merge fresh server headers with any optimistic sent entries that have not
// yet been reconciled by the server copy (IMAP APPEND runs in the background,
// so the server may not return the newly-sent message immediately).
//
// Every row is stamped with where it lives. The list merges Sent into INBOX,
// and in All inboxes it holds every account's Sent at once, so a row whose
// folder had to be guessed from the active account was read at the wrong path.
// Other accounts' rows stay only where the list spans accounts: in one
// account's view `sentEmails` is that account's alone, as it always was.
function _mergeOptimisticSent(fresh, existing, accountId, accountEmail, sentPath, keepOthers) {
  const freshMessageIds = new Set(
    fresh.map(e => e.messageId).filter(Boolean)
  );
  const others = keepOthers ? (existing || []).filter(e => e._accountId !== accountId) : [];
  const pendingOptimistic = (existing || []).filter(
    e => e._optimistic && e._accountId === accountId && !freshMessageIds.has(e.messageId)
  );
  return [
    ...others,
    ...pendingOptimistic,
    ...fresh.map(e => ({
      ...e, _accountId: accountId, _accountEmail: accountEmail, _mailbox: sentPath, _fromSentFolder: true,
    })),
  ];
}

/** Run `body` as the account's background Sent fill, unless one runs or it is not due. */
function _fillSent(accountId, key, body) {
  if (_sentFills.has(accountId)) return;
  const last = _sentFillAt.get(key);
  if (last && (last.ok || Date.now() - last.at < SENT_FILL_RETRY_MS)) return;
  const run = (async () => {
    let ok = false;
    try {
      await body();
      ok = true;
    } catch (e) {
      console.warn('[loadSentHeaders:fill_fail]', { accountId, error: e.message });
    }
    _sentFillAt.set(key, { at: Date.now(), ok });
  })().finally(() => _sentFills.delete(accountId));
  _sentFills.set(accountId, run);
}

// Cache-only reads already running, per account. All inboxes asks every account
// on every load and refresh; asks that arrive while a read is running share it,
// and it reads once more when it is done, since the cache may have been written
// under it (the pipeline publishes right after saving fresh headers).
const _sentCacheReads = new Map();

/**
 * Put an account's Sent headers in `sentEmails`, where the INBOX list threads
 * them in.
 *
 * The active account, always. Any other account only while All inboxes shows
 * INBOX: that list holds every visible account's conversations, and a reply
 * you sent from any of them belongs in its thread.
 *
 * `cacheOnly` reads what the pipelines already saved and never touches the
 * server. All inboxes uses it on every (re)load: it runs on each refresh tick,
 * and a server listing per account per tick is exactly the traffic that gets
 * an account throttled.
 */
export function loadSentHeaders(accountId, { cacheOnly = false } = {}) {
  if (!cacheOnly) return _loadSentHeaders(accountId, false);
  const running = _sentCacheReads.get(accountId);
  if (running) {
    running.again = true;
    return running.promise;
  }
  const entry = { again: false, promise: null };
  entry.promise = (async () => {
    do {
      entry.again = false;
      await _loadSentHeaders(accountId, true);
    } while (entry.again);
  })().finally(() => _sentCacheReads.delete(accountId));
  _sentCacheReads.set(accountId, entry);
  return entry.promise;
}

// Per account: how many times a full read has merged. A cache-only read that
// began before one of those merges holds an older snapshot of the cache, and
// merging it last would put back rows the full read had just replaced (the
// staged reply blinking out).
const _sentFullMerges = new Map();

// The background fill of each account's Sent mirror, one at a time. A second
// load while one runs shares it instead of filling twice; a folder is filled
// once per session (a failed fill is tried again after a few minutes), because
// the server's count and the cache's never agree to the row (unparseable rows,
// mail deleted elsewhere) and a gate on them would fill on every load.
const _sentFills = new Map();
const _sentFillAt = new Map();
// The newest rows the mirror always holds, and the size of one slice of a cache read.
const SENT_PAGE = 200;
const SENT_FILL_RETRY_MS = 5 * 60 * 1000;
export const _sentTimings = { pollMs: 1000 };
// The cache each account's mirror last merged (`path|rows|lastSynced`): a
// cache-only read of an unchanged cache is not read again.
const _sentCacheSeen = new Map();
// How far back each account's mirror reaches: the oldest moment it was asked to
// cover (Infinity: only the newest 200), and whether it holds the whole cache.
// The mirror is a window onto the folder: the folder can be tens of thousands of
// rows and the daemon owns all of them; the app keeps what the list can show.
const _sentReach = new Map();
/** The running fill of an account's Sent mirror (resolved when none runs). */
export const _sentFillFor = (accountId) => _sentFills.get(accountId) ?? Promise.resolve();
// Bumped when a fill adds its rows: a load that began before then holds an older
// read of the cache and must not put it over them.
const _sentFillGen = new Map();
export const _resetSentFills = () => { _sentFills.clear(); _sentFillAt.clear(); _sentCacheSeen.clear(); _sentFillGen.clear(); _sentReach.clear(); };

/**
 * How far back the list can use `accountId`'s Sent mail: the moment of the last
 * dated row of that account in the loaded list (the list is newest first, so
 * its tail is its oldest; one stray old row up the list, a message moved back
 * to the INBOX, does not set it). Infinity when nothing is loaded, or when the
 * list on screen does not thread Sent in.
 */
function _sentNeedMs(state, accountId) {
  if (!mergesSentIntoThreads(state)) return Infinity;
  const rows = state.emails || [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const e = rows[i];
    if ((e._accountId || e._srcAccountId || state.activeAccountId) !== accountId) continue;
    const ms = _headerDateMs(e);
    if (ms === ms) return ms; // not NaN
  }
  return Infinity;
}

/**
 * The cached Sent rows back to `reachMs`, never fewer than the newest 200: one
 * daemon read BY DATE, whatever order the folder is kept in (an IMAP cache is
 * by uid, and a message moved in long after it was sent holds the top uid).
 * Null when the read failed: the caller leaves the mirror as it is.
 */
async function _readSentWindow(accountId, sentPath, reachMs) {
  const since = Number.isFinite(reachMs) ? reachMs : (reachMs > 0 ? Number.MAX_SAFE_INTEGER : -1);
  const read = await db.getEmailHeadersWindow(accountId, sentPath, since, SENT_PAGE);
  if (!read) return null;
  return { rows: read.emails, whole: read.emails.length >= read.totalCached, totalCached: read.totalCached };
}

/**
 * The INBOX list reached further back: the Sent mirror follows it. It adds the
 * rows the list now reaches and reads nothing when the mirror already covers it.
 */
export async function extendSentWindows() {
  const { useMailStore } = await import('../../stores/mailStore');
  const state = useMailStore.getState();
  if (!mergesSentIntoThreads(state)) return;
  const hidden = useSettingsStore.getState()?.hiddenAccounts || {};
  const live = new Set((state.accounts || []).filter(a => !hidden[a.id]).map(a => a.id));
  const ids = state.activeMailbox === 'UNIFIED' ? [..._sentReach.keys()].filter(id => live.has(id)) : [state.activeAccountId];
  await Promise.all(ids.filter((id) => {
    const reach = _sentReach.get(id);
    return reach && _sentNeedMs(state, id) < reach.reachMs;
  }).map((id) => loadSentHeaders(id, { cacheOnly: true })));
}

// What a row shows, for "did this read change anything".
const _sentRowSig = (e) => `${e.uid}|${e.messageId}|${(e.flags || []).join(',')}|${e._mailbox}|${e._optimistic ? 1 : 0}`;

async function _loadSentHeaders(accountId, cacheOnly) {
  // Read before the first await, so it names the cache this read will see.
  const startMerges = _sentFullMerges.get(accountId) || 0;
  const startFillGen = _sentFillGen.get(accountId) || 0;
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();
  const isActive = () => get().activeAccountId === accountId;
  const spansAccounts = () => get().activeMailbox === 'UNIFIED';
  // Every write below re-asks this: the view can move during any await.
  const wanted = () => isActive() || (spansAccounts() && mergesSentIntoThreads(get()));
  if (!wanted()) return;

  let sentPath;
  let folderList = null;
  if (isActive()) {
    // On a cold profile this runs while `mailboxes` is still the INBOX
    // placeholder. Bailing here left Sent unmerged for the whole session, so
    // wait for the real folder list instead of reading the path once. A
    // cache-only read does not wait: it runs again on the next load.
    sentPath = get().getSentMailboxPath();
    if (!sentPath && !cacheOnly) {
      sentPath = await waitForSentMailboxPath(useMailStore);
      if (!wanted()) return;
    }
  } else {
    // Another account's own folder list: the one cached in memory, else the
    // one saved on disk. Never the active account's.
    sentPath = get().getSentMailboxPath(accountId);
    if (!sentPath) {
      folderList = await db.getCachedMailboxes(accountId).catch(() => null);
      if (!wanted()) return;
      sentPath = sentMailboxPathFor(get(), accountId, folderList);
    }
    folderList = folderList || getAccountCacheMailboxes(accountId) || [];
  }
  console.log('[loadSentHeaders:start]', { accountId, sentPath, cacheOnly });
  if (!sentPath) {
    console.warn('[loadSentHeaders:no_sent_path] accountId=%s — no Sent folder resolved', accountId);
    // This account's rows go; another account's stay where the list spans them.
    if (!cacheOnly) {
      useMailStore.setState(s => ({
        sentEmails: spansAccounts() ? (s.sentEmails || []).filter(e => e._accountId !== accountId) : [],
      }));
    }
    return;
  }

  // True when the mirror now reflects the read (applied, or nothing to change);
  // false when a newer write won and the read was dropped.
  const merge = (read) => {
    if (cacheOnly && (_sentFullMerges.get(accountId) || 0) !== startMerges) return false;
    // A fill added its rows since this load read the cache: its rows are newer.
    if ((_sentFillGen.get(accountId) || 0) !== startFillGen) return false;
    if (!cacheOnly) _sentFullMerges.set(accountId, (_sentFullMerges.get(accountId) || 0) + 1);
    // A message moved or deleted since the cache was read stays out.
    const tombstones = get().deleteTombstones;
    const fresh = tombstones?.size ? read.filter(e => !tombstones.has(`${accountId}|${sentPath}|${e.uid}`)) : read;
    const accountEmail = (get().accounts || []).find(a => a.id === accountId)?.email;
    const current = get().sentEmails || [];
    const next = _mergeOptimisticSent(fresh, current, accountId, accountEmail, sentPath, spansAccounts());
    // All Inboxes re-reads every account on each load; an unchanged read must
    // not rebuild the rows and every thread built from them.
    const mine = (rows) => rows.filter(e => e._accountId === accountId).map(_sentRowSig).join('\n');
    if (next.length === current.length && mine(next) === mine(current)) return true;
    useMailStore.setState({ sentEmails: next });
    invalidateChatAndThreadCaches();
    return true;
  };

  // The window: the cache from the newest row back to the oldest loaded INBOX row
  // (never fewer than 200), not the whole folder.
  const cacheMeta = await db.getEmailHeadersMeta(accountId, sentPath).catch(() => null);
  const cachedCount = cacheMeta?.totalCached || 0;
  // The rows and the server's count, not the sync stamp: the daemon stamps every
  // sync, empty ones too, and a flag-only write moves neither.
  const cacheSig = `${sentPath}|${cachedCount}|${cacheMeta?.totalEmails ?? ''}`;
  const mine = () => (get().sentEmails || []).filter(e => e._accountId === accountId);
  const reach = mine().length > 0 ? _sentReach.get(accountId) : null;
  const need = _sentNeedMs(get(), accountId);
  // A cache the mirror already merged is not read again: this runs on every
  // refresh tick and every account switch. A cache-only load has nothing else to
  // do; a full load still asks the server for page one and ADDS what it brings.
  // A staged reply is the exception: it waits to be replaced by its server copy.
  const mirrorCurrent = !!reach && _sentCacheSeen.get(accountId) === cacheSig;
  const staged = mine().some(e => e._optimistic);
  // `whole` holds only for the cache it was read from: a fill that grows it
  // makes it a window again.
  const covered = !!reach && (reach.reachMs <= need || (reach.whole && mirrorCurrent));
  const alreadyMerged = mirrorCurrent && !staged && covered;
  if (alreadyMerged && reach.reachMs > need) _sentReach.set(accountId, { ...reach, reachMs: need });
  if (cacheOnly && alreadyMerged) return;
  // Rows join a mirror that is current; they replace one only when the cache
  // moved. Either way a read never reaches back less far than the mirror does.
  const adding = mirrorCurrent && !staged;
  // A mirror that is current only gains rows; one the cache moved past is
  // rebuilt to exactly what the list reaches now, so a deep window the list has
  // left is let go.
  const readReach = adding ? Math.min(need, reach.reachMs) : need;
  const cached = alreadyMerged ? null : await _readSentWindow(accountId, sentPath, readReach);
  // A failed read says nothing about the folder: the mirror stays as it is.
  if (!alreadyMerged && !cached) return;
  if (!wanted()) return;
  // Every row known so far, by uid: a server page adds to it, never replaces it.
  const held = new Map((cached?.rows || []).map(e => [e.uid, e]));
  const heldRows = () => [...held.values()];
  const hold = (rows) => { for (const e of rows) held.set(e.uid, e); };

  // The end of a background fill: rows ADDED to the mirror as it is now (a reply
  // sent or a message deleted or moved while the fill ran is not undone: a
  // tombstoned row is not brought back, and a server copy takes the place of its
  // staged reply), and the rows `gone` taken out. One rebuild of the threads.
  const addSent = (rows, gone = [], { fill = false } = {}) => {
    if (!wanted()) return false;
    const accountEmail = (get().accounts || []).find(a => a.id === accountId)?.email;
    const current = get().sentEmails || [];
    const have = new Set(current.filter(e => e._accountId === accountId).map(e => e.uid));
    const tombstones = get().deleteTombstones;
    const added = rows
      .filter(e => !have.has(e.uid) && !tombstones?.has(`${accountId}|${sentPath}|${e.uid}`))
      .map(e => ({ ...e, _accountId: accountId, _accountEmail: accountEmail, _mailbox: sentPath, _fromSentFolder: true }));
    const arrived = new Set(added.map(e => e.messageId).filter(Boolean));
    const drop = new Set(gone);
    const kept = current.filter(e => e._accountId !== accountId
      || !((e._optimistic && e.messageId && arrived.has(e.messageId)) || (!e._optimistic && drop.has(e.uid))));
    if (!added.length && kept.length === current.length) return true;
    // Only a fill's end outranks a load that began before it.
    if (fill) _sentFillGen.set(accountId, (_sentFillGen.get(accountId) || 0) + 1);
    useMailStore.setState({ sentEmails: [...kept, ...added] });
    invalidateChatAndThreadCaches();
    return true;
  };
  // Page one of the server: replaces the mirror's rows from a cold read, adds to
  // them when the mirror is current.
  const publishPage = (rows) => (adding ? addSent(rows) : merge(heldRows()));

  console.log('[loadSentHeaders:cache]', {
    accountId,
    sentPath,
    cachedCount: cached?.rows?.length || 0,
    firstCachedMessageIds: (cached?.rows || []).slice(0, 3).map(e => e.messageId),
  });
  // What the mirror holds is only recorded as read when the read landed.
  const landed = !cached?.rows?.length || (adding ? addSent(cached.rows) : merge(cached.rows));
  if (landed) {
    _sentCacheSeen.set(accountId, cacheSig);
    if (cached) _sentReach.set(accountId, { reachMs: readReach, whole: cached.whole });
  }
  if (cacheOnly) return;

  const { accounts, connectionStatus } = get();
  const account = accounts.find(a => a.id === accountId);
  if (!account || connectionStatus !== 'connected') {
    console.warn('[loadSentHeaders:skip_server_fetch]', { accountId, hasAccount: !!account, connectionStatus });
    return;
  }

  // The rest of the folder: the daemon syncs it, fills the cache with every row
  // the provider has and prunes the ones it no longer lists (sync.now, complete),
  // for IMAP, JMAP and Graph alike. The mirror reads its window again when that
  // is done, and only ever ADDS: it takes out just the rows the daemon pruned.
  const fillFromDaemon = () => _fillSent(accountId, `${accountId}:${sentPath}`, async () => {
    const { ticket } = await syncNow(toSyncAccount(account, accountId), sentPath, { complete: true });
    await waitForSync(ticket);
    // The ticket resolves before the daemon marks the backfill as running, so one
    // "not backfilling" read proves nothing: two in a row, a poll apart, do. The
    // flag is the account's, any folder's backfill holds it.
    let idle = 0;
    for (let polls = 0; polls < 300 && idle < 2; polls += 1) {
      await new Promise(resolve => setTimeout(resolve, _sentTimings.pollMs));
      if (!get().accounts.some(a => a.id === accountId)) return; // removed meanwhile
      idle = (await getSyncStatus(accountId))?.backfilling ? 0 : idle + 1;
    }
    const meta = await db.getEmailHeadersMeta(accountId, sentPath).catch(() => null);
    const now = _sentReach.get(accountId);
    // The rows the mirror held before the read: only those can be pruned, never
    // one that arrived (a reply sent) while the read was on the wire.
    const heldBefore = new Set(mine().filter(e => !e._optimistic).map(e => e.uid));
    const rereadReach = Math.min(_sentNeedMs(get(), accountId), now?.reachMs ?? Infinity);
    const reread = await _readSentWindow(accountId, sentPath, rereadReach);
    if (!reread) throw new Error('the Sent cache could not be read');
    const readUids = new Set(reread.rows.map(e => e.uid));
    let oldestRead = Infinity;
    for (const e of reread.rows) {
      const ms = _headerDateMs(e);
      if (ms < oldestRead) oldestRead = ms;
    }
    // A row of the window the cache no longer holds was pruned; one at or older
    // than the oldest row read may simply not be in the slice.
    const floor = reread.whole ? -Infinity : oldestRead;
    const gone = mine()
      .filter(e => heldBefore.has(e.uid) && !readUids.has(e.uid) && (reread.whole || _headerDateMs(e) > floor))
      .map(e => e.uid);
    if (addSent(reread.rows, gone, { fill: true })) {
      _sentCacheSeen.set(accountId, `${sentPath}|${meta?.totalCached || 0}|${meta?.totalEmails ?? ''}`);
      _sentReach.set(accountId, { reachMs: rereadReach, whole: reread.whole });
    }
    // Still backfilling after the wait: what is there is shown, and the fill
    // counts as failed, so it is tried again later.
    if (idle < 2) throw new Error('the Sent backfill is still running');
  });

  try {
    if (isGraphAccount(account)) {
      const sentFolder = (isActive() ? get().mailboxes : folderList).find(m => m.path === sentPath);
      if (sentFolder?._graphFolderId) {
        console.log('[loadSentHeaders:graph_fetch_start]', { accountId, folderId: sentFolder._graphFolderId });
        const result = await _listGraphMessages(
          accountId, sentPath, account, sentFolder._graphFolderId
        );
        if (!wanted()) return;
        const sentHeaders = result.headers || [];
        console.log('[loadSentHeaders:graph_fetch_ok]', {
          accountId,
          count: sentHeaders.length,
          firstMessageIds: sentHeaders.slice(0, 5).map(e => e.messageId),
          firstSubjects: sentHeaders.slice(0, 5).map(e => e.subject),
        });
        if (sentHeaders.length > 0) {
          // Only claim a total when this listing is the whole folder. With a
          // nextLink it's one page, and writing its length as totalEmails
          // capped the Sent list at 200 and made the delta gate see a phantom
          // count mismatch on every sync. null = leave the cached total alone.
          await db.saveEmailHeaders(accountId, sentPath, sentHeaders, result.nextLink ? null : sentHeaders.length);
          if (!wanted()) return;
          hold(sentHeaders);
          publishPage(sentHeaders);
          if (!result.nextLink) {
            // One page is the whole folder: a cached row it does not list is gone.
            if (!adding) {
              const listed = new Set(sentHeaders.map(e => e.uid));
              const gone = heldRows().filter(e => !listed.has(e.uid)).map(e => e.uid);
              if (gone.length) {
                await db.saveEmailHeaders(accountId, sentPath, [], null, { removedUids: gone });
                if (wanted()) addSent([], gone);
              }
            }
          } else if (!sentFolder._graphTotal || cachedCount !== sentFolder._graphTotal) {
            fillFromDaemon();
          }
        }
      } else {
        console.warn('[loadSentHeaders:graph_no_folder_id]', { accountId, sentPath });
      }
    } else {
      console.log('[loadSentHeaders:imap_fetch_start]', { accountId, sentPath });
      const result = await api.fetchEmails(account, sentPath, 1, SENT_PAGE);
      if (!wanted()) return;
      console.log('[loadSentHeaders:imap_fetch_ok]', {
        accountId,
        sentPath,
        count: result?.emails?.length || 0,
        total: result?.total,
        firstUids: (result?.emails || []).slice(0, 5).map(e => e.uid),
        firstMessageIds: (result?.emails || []).slice(0, 5).map(e => e.messageId),
        firstSubjects: (result?.emails || []).slice(0, 5).map(e => e.subject),
      });
      if (result?.emails?.length > 0) {
        await db.saveEmailHeaders(accountId, sentPath, result.emails, result.total);
        if (!wanted()) return;
        const existingOptimistic = (get().sentEmails || []).filter(e => e._optimistic && e._accountId === accountId);
        hold(result.emails);
        publishPage(result.emails);
        const merged = get().sentEmails || [];
        const optimisticSurvivors = merged.filter(e => e._optimistic && e._accountId === accountId);
        console.log('[loadSentHeaders:merge_done]', {
          accountId,
          fresh_count: result.emails.length,
          optimistic_before: existingOptimistic.length,
          optimistic_after: optimisticSurvivors.length,
          optimistic_messageIds_dropped: existingOptimistic
            .filter(e => !optimisticSurvivors.find(s => s.uid === e.uid))
            .map(e => e.messageId),
          merged_count: merged.length,
        });
        if (cachedCount !== (result.total || 0)) fillFromDaemon();
      }
    }
  } catch (e) {
    console.warn('[loadSentHeaders:fetch_fail]', { accountId, error: e.message });
  }
}
