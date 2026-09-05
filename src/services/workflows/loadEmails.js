// ── loadEmails workflow — email list loading, Graph API path, sent headers ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { useConnectivityStore } from '../../stores/connectivityStore';
import { ensureFreshToken, hasValidCredentials, resolveServerAccount } from '../authUtils';
import { isGraphAccount, normalizeGraphFolderName, graphFoldersToMailboxes, graphMessageToEmail } from '../graphConfig';
import { saveRestoreDescriptor as _saveRestore, listGraphMessages as _listGraphMessages, getGraphMessageId, restoreGraphIdMap as _restoreGraphIdMap } from '../cacheManager';
import { _buildRestoreDescriptor } from '../../stores/slices/unifiedHelpers';
import { serverUids } from '../../stores/slices/serverUids';
import { createPerfTrace } from '../../utils/perfTrace';
import { waitForSentMailboxPath } from '../../utils/sentFolder';
import { takeForcedMailboxRefetch } from './helpers/mailboxRefetch';
import {
  _resetNetworkRetry, _scheduleNetworkRetry,
  getLoadAbortController, setLoadAbortController,
  getLoadMoreTimer, setLoadMoreTimer,
  getLoadEmailsGeneration, bumpLoadEmailsGeneration,
  getLoadEmailsRetried, setLoadEmailsRetried,
  bumpFlagChangeCounter, invalidateChatAndThreadCaches,
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
function isSuspiciousEmptyEmailResult(serverTotal, cachedHeaders, savedEmailIds) {
  if (serverTotal > 0) return false;
  const cachedTotal = cachedHeaders?.totalEmails || cachedHeaders?.lastKnownGoodTotalEmails || 0;
  const savedCount = savedEmailIds?.size || 0;
  return cachedTotal > 0 || savedCount > 0;
}


// ── loadEmails workflow ──

export async function loadEmails() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { activeAccountId, accounts, activeMailbox, mailboxScope } = get();
  let account = accounts.find(a => a.id === activeAccountId);
  if (!account) return;

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
    account = await ensureFreshToken(account);
    if (isStale()) return;
    loadTrace.mark('token-ready', { email: account.email });

    // ── Graph API path ──
    if (isGraphAccount(account)) {
      return await _loadEmailsViaGraph(account, activeAccountId, activeMailbox, generation);
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
      [savedEmailIds, archivedEmailIds, cachedHeaders] = await Promise.all([
        db.getSavedEmailIds(activeAccountId, activeMailbox),
        db.getArchivedEmailIds(activeAccountId, activeMailbox),
        db.getEmailHeadersMeta(activeAccountId, activeMailbox),
      ]);
    }
    if (isStale()) return;
    loadTrace.mark('cache-meta-ready', {
      cacheIsFresh: !!cacheIsFresh,
      cachedTotal: cachedHeaders?.totalCached || 0,
      savedCount: savedEmailIds?.size || 0,
      archivedCount: archivedEmailIds?.size || 0,
    });
    useMailStore.setState({ savedEmailIds, archivedEmailIds });

    // Fire-and-forget: load archived email headers from disk in background
    if (archivedEmailIds.size > 0 && (get().localEmails || []).length === 0) {
      const archivedAccount = activeAccountId;
      (async () => {
        try {
          let localEmails = await db.readLocalEmailIndex(activeAccountId, activeMailbox);
          if (!localEmails) {
            localEmails = await db.getArchivedEmails(activeAccountId, activeMailbox, archivedEmailIds);
          }
          if (get().activeAccountId !== archivedAccount || loadSignal.aborted) return;
          useMailStore.setState({ localEmails });
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
    } else if (cachedHeaders && cachedHeaders.totalCached > 0) {
      console.log('[loadEmails] Store empty, loading 200 from cache (total cached: %d)', cachedHeaders.totalCached);
      const partialHeaders = await db.getEmailHeadersPartial(activeAccountId, activeMailbox, 500);
      if (isStale()) return;

      if (partialHeaders && partialHeaders.emails.length > 0) {
        useMailStore.setState({
          emails: partialHeaders.emails,
          loadedRanges: [{ start: 0, end: partialHeaders.emails.length }],
          loadingRanges: new Set(),
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
        loadingRanges: new Set(),
        emails: []
      });
      get().updateSortedEmails();
      loadTrace.mark('fresh-empty-state-rendered');
    }

    // Keep previous/cached emails for degraded modes
    const previousEmails = get().emails;

    // Resolve credentialed account
    const resolved = await resolveServerAccount(activeAccountId, account);
    if (!resolved.ok) {
      console.error('[loadEmails] Credentials missing for account:', account.email);
      if (!isStale()) useMailStore.setState({
        emails: previousEmails,
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
            emails: previousEmails,
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
          emails: previousEmails,
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
          emails: previousEmails,
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

      if (newUidValidity !== cachedUidValidity) {
        console.log('[loadEmails] UIDVALIDITY changed (%d -> %d), full reload', cachedUidValidity, newUidValidity);
        await db.clearMailboxCache(activeAccountId, activeMailbox);
        const serverResult = await api.fetchEmails(account, activeMailbox, 1);
        serverTotal = serverResult.total;
        mergedEmails = serverResult.emails.map((email, idx) => ({
          ...email,
          displayIndex: idx,
          isLocal: savedEmailIds.has(email.uid),
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
            isLocal: savedEmailIds.has(email.uid),
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
          isLocal: savedEmailIds.has(email.uid),
          source: 'server'
        }));
        const shiftedExisting = cleanedExisting.map((email, idx) => ({
          ...email,
          displayIndex: newEmails.length + idx,
          isLocal: savedEmailIds.has(email.uid)
        }));
        mergedEmails = [...newEmailsWithIndex, ...shiftedExisting];
      } else {
        mergedEmails = serverResult.emails.map((email, idx) => ({
          ...email,
          displayIndex: idx,
          isLocal: savedEmailIds.has(email.uid),
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
    if (isSuspiciousEmptyEmailResult(serverTotal, cachedHeaders, savedEmailIds) && (!mergedEmails || mergedEmails.length === 0)) {
      console.warn(
        '[loadEmails] Server returned 0 emails for %s/%s but prior cache had %d, Maildir has %d — rejecting as suspicious',
        account.email, activeMailbox,
        cachedHeaders?.totalEmails || cachedHeaders?.lastKnownGoodTotalEmails || 0,
        savedEmailIds?.size || 0
      );
      useMailStore.setState({
        suspectEmptyServerData: {
          accountId: activeAccountId,
          type: 'emails',
          message: t('svc.loadEmails.serverReturnedEmptyInboxUnexpectedly'),
          timestamp: Date.now(),
        },
        connectionStatus: 'connected',
        connectionError: null,
        connectionErrorType: null,
        loading: false,
        loadingMore: false,
      });
      loadTrace.end('suspicious-empty-rejected', {
        serverTotal,
        cachedTotal: cachedHeaders?.totalEmails || 0,
        savedCount: savedEmailIds?.size || 0,
      });
      return;
    }

    // Clear suspect state
    const currentSuspect = get().suspectEmptyServerData;
    if (currentSuspect?.accountId === activeAccountId && currentSuspect?.type === 'emails') {
      useMailStore.setState({ suspectEmptyServerData: null });
    }

    const currentPage = Math.ceil(mergedEmails.length / 200) || 1;
    const hasMoreEmails = mergedEmails.length < serverTotal;

    if (isStale()) {
      console.log('[loadEmails] Account changed during fetch, discarding results for', activeAccountId);
      return;
    }

    const existingServerUidSet = get().serverUids.uids;
    const mergedServerUidSet = existingServerUidSet.size > 0
      ? new Set([...existingServerUidSet, ...mergedEmails.map(e => e.uid)])
      : new Set(mergedEmails.map(e => e.uid));

    setLoadEmailsRetried(false);
    useMailStore.setState({
      emails: mergedEmails,
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

    if (activeMailbox === 'INBOX') {
      const unread = get().emails.filter(e => !e.flags?.includes('\\Seen')).length;
      useSettingsStore.getState().setUnreadForAccount(activeAccountId, unread);
    }

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

    if (error.message?.includes('authenticated but not connected') || error.message?.includes('Command Error. 12')) {
      errorType = 'outlookOAuth';
      errorMessage = 'Microsoft IMAP connection failed. This is a known Microsoft server issue affecting personal Outlook.com accounts with OAuth2. See FAQ for details.';
    } else if (error.message?.includes('XOAUTH2 auth failed')) {
      errorType = 'oauthExpired';
      const { isPersonalMicrosoftEmail: isPersonalMs } = await import('../graphConfig');
      const activeAccount = get().accounts.find(a => a.id === get().activeAccountId);
      if (isPersonalMs(activeAccount?.email)) {
        errorMessage = 'This Outlook account uses Graph API. Please reconnect with Microsoft in Settings to fix authentication.';
      } else {
        errorMessage = 'OAuth2 authentication failed. Please reconnect your account in Settings.';
      }
    } else if (error.message?.includes('password') || error.message?.includes('authentication') || error.message?.includes('No password') || error.message?.includes('Login failed') || error.message?.includes('auth failed')) {
      errorType = 'passwordMissing';
      errorMessage = 'Authentication failed. Please check your password in Settings.';
    } else if (error.message?.includes('network') || error.message?.includes('timeout') || error.message?.includes('ENOTFOUND') || error.message?.includes('ECONNREFUSED') || error.message?.includes('Server unreachable')) {
      errorType = 'offline';
      errorMessage = error.message;
    }

    if (!isStale()) {
      useMailStore.setState({
        emails: previousEmails ?? get().emails,
        connectionStatus: 'error',
        connectionError: errorMessage,
        connectionErrorType: errorType
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


// ── _loadEmailsViaGraph workflow ──

/** A header's received time in ms, or NaN when it carries no parseable date. */
function _headerDateMs(email) {
  return Date.parse(email?.internalDate || email?.date || '');
}

export async function _loadEmailsViaGraph(account, activeAccountId, activeMailbox, generation) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const isStale = () => get().activeAccountId !== activeAccountId || get().activeMailbox !== activeMailbox || getLoadEmailsGeneration() !== generation;

  await _restoreGraphIdMap(activeAccountId, activeMailbox);
  if (isStale()) return;

  const [savedEmailIds, archivedEmailIds] = await Promise.all([
    db.getSavedEmailIds(activeAccountId, activeMailbox),
    db.getArchivedEmailIds(activeAccountId, activeMailbox),
  ]);
  if (isStale()) return;
  useMailStore.setState({ savedEmailIds, archivedEmailIds });

  if (archivedEmailIds.size > 0 && (get().localEmails || []).length === 0) {
    const archivedAccount = activeAccountId;
    db.getArchivedEmails(activeAccountId, activeMailbox, archivedEmailIds, (batchEmails) => {
      if (get().activeAccountId !== archivedAccount) return;
      useMailStore.setState({ localEmails: batchEmails });
      get().updateSortedEmails();
    }).catch(e => console.warn('[loadEmailsViaGraph] getArchivedEmails failed:', e));
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

    const shouldRefreshMailboxes = takeForcedMailboxRefetch(activeAccountId) || !shouldUseFreshMailboxCacheLocal(cachedMailboxEntry) || !cachedTarget;

    if (shouldRefreshMailboxes) {
      const graphFolders = await api.graphListFolders(account.oauth2AccessToken);
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
      activeAccountId, activeMailbox, account.oauth2AccessToken, targetFolder._graphFolderId
    );
    if (isStale()) return;

    const headers = result.headers || [];

    const mergedEmails = headers.map((email, idx) => ({
      ...email,
      displayIndex: idx,
      isLocal: savedEmailIds.has(email.uid),
      source: 'server',
    }));

    const serverTotal = mergedEmails.length;
    const hasMoreEmails = !!result.nextLink;

    useMailStore.setState({
      emails: mergedEmails,
      loadedRanges: [{ start: 0, end: mergedEmails.length }],
      connectionStatus: 'connected',
      connectionError: null,
      connectionErrorType: null,
      currentPage: 1,
      hasMoreEmails,
      totalEmails: serverTotal,
      loading: false,
      loadingMore: false,
      serverUids: serverUids(mergedEmails.map(e => e.uid), { complete: !hasMoreEmails }),
    });

    get().updateSortedEmails();

    if (activeMailbox === 'INBOX') {
      const unread = get().emails.filter(e => !e.flags?.includes('\\Seen')).length;
      useSettingsStore.getState().setUnreadForAccount(activeAccountId, unread);
    }

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
    const graphUids = new Set(mergedEmails.map(e => e.uid));
    const pageDates = mergedEmails.map(_headerDateMs).filter(Number.isFinite);
    const pageOldestMs = pageDates.length ? Math.min(...pageDates) : Infinity;
    // NaN fails every comparison, so a row we can't date is never inside the
    // window and never deleted on a guess.
    const removedUids = priorEmails
      .filter(e => !graphUids.has(e.uid) && _headerDateMs(e) >= pageOldestMs)
      .map(e => e.uid);

    // Descriptor saved on switch-away, not after every load
    db.saveEmailHeaders(activeAccountId, activeMailbox, mergedEmails, serverTotal, { removedUids })
      .catch(e => console.warn('[loadEmailsViaGraph] Failed to cache headers:', e));

  } catch (error) {
    console.error('[loadEmailsViaGraph] Failed:', error);

    let errorType = 'serverError';
    let errorMessage = error.message;

    if (error.message?.includes('network') || error.message?.includes('timeout')) {
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
function _mergeOptimisticSent(fresh, existing, accountId) {
  const freshMessageIds = new Set(
    fresh.map(e => e.messageId).filter(Boolean)
  );
  const pendingOptimistic = (existing || []).filter(
    e => e._optimistic && e._accountId === accountId && !freshMessageIds.has(e.messageId)
  );
  return [...pendingOptimistic, ...fresh.map(e => ({ ...e, _accountId: accountId }))];
}

export async function loadSentHeaders(accountId) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  // On a cold profile this runs while `mailboxes` is still the INBOX
  // placeholder. Bailing here left Sent unmerged for the whole session, so
  // wait for the real folder list instead of reading the path once.
  let sentPath = get().getSentMailboxPath();
  if (!sentPath) {
    sentPath = await waitForSentMailboxPath(useMailStore);
    if (get().activeAccountId !== accountId) return;
  }
  console.log('[loadSentHeaders:start]', { accountId, sentPath });
  if (!sentPath) {
    console.warn('[loadSentHeaders:no_sent_path] accountId=%s — getSentMailboxPath returned null', accountId);
    useMailStore.setState({ sentEmails: [] });
    return;
  }

  const cached = await db.getEmailHeadersPartial(accountId, sentPath, 200);
  if (get().activeAccountId !== accountId) return;
  console.log('[loadSentHeaders:cache]', {
    accountId,
    sentPath,
    cachedCount: cached?.emails?.length || 0,
    firstCachedMessageIds: (cached?.emails || []).slice(0, 3).map(e => e.messageId),
  });
  if (cached?.emails?.length > 0) {
    useMailStore.setState(s => ({
      sentEmails: _mergeOptimisticSent(cached.emails, s.sentEmails, accountId),
    }));
    invalidateChatAndThreadCaches();
  }

  const { accounts, connectionStatus, mailboxes } = get();
  const account = accounts.find(a => a.id === accountId);
  if (!account || connectionStatus !== 'connected') {
    console.warn('[loadSentHeaders:skip_server_fetch]', { accountId, hasAccount: !!account, connectionStatus });
    return;
  }

  try {
    if (isGraphAccount(account)) {
      const sentFolder = mailboxes.find(m => m.path === sentPath);
      if (sentFolder?._graphFolderId) {
        const freshAccount = await ensureFreshToken(account);
        console.log('[loadSentHeaders:graph_fetch_start]', { accountId, folderId: sentFolder._graphFolderId });
        const result = await _listGraphMessages(
          accountId, sentPath, freshAccount.oauth2AccessToken, sentFolder._graphFolderId
        );
        if (get().activeAccountId !== accountId) return;
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
          if (get().activeAccountId !== accountId) return;
          useMailStore.setState(s => ({
            sentEmails: _mergeOptimisticSent(sentHeaders, s.sentEmails, accountId),
          }));
          invalidateChatAndThreadCaches();
        }
      } else {
        console.warn('[loadSentHeaders:graph_no_folder_id]', { accountId, sentPath });
      }
    } else {
      console.log('[loadSentHeaders:imap_fetch_start]', { accountId, sentPath });
      const result = await api.fetchEmails(account, sentPath, 1, 200);
      if (get().activeAccountId !== accountId) return;
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
        if (get().activeAccountId !== accountId) return;
        const existingOptimistic = (get().sentEmails || []).filter(e => e._optimistic && e._accountId === accountId);
        useMailStore.setState(s => ({
          sentEmails: _mergeOptimisticSent(result.emails, s.sentEmails, accountId),
        }));
        invalidateChatAndThreadCaches();
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
      }
    }
  } catch (e) {
    console.warn('[loadSentHeaders:fetch_fail]', { accountId, error: e.message });
  }
}
