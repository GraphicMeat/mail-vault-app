// ── loadEmails workflow — email list loading, Graph API path, sent headers ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { ensureFreshToken, hasValidCredentials, resolveServerAccount } from '../authUtils';
import { isGraphAccount, normalizeGraphFolderName, graphFoldersToMailboxes, graphMessageToEmail } from '../graphConfig';
import { saveRestoreDescriptor as _saveRestore, setGraphIdMap as _setGraphIdMap, getGraphMessageId, restoreGraphIdMap as _restoreGraphIdMap } from '../cacheManager';
import { _buildRestoreDescriptor } from '../../stores/slices/unifiedHelpers';
import { createPerfTrace } from '../../utils/perfTrace';
import {
  _resetNetworkRetry, _scheduleNetworkRetry,
  getLoadAbortController, setLoadAbortController,
  getLoadMoreTimer, setLoadMoreTimer,
  getLoadEmailsGeneration, bumpLoadEmailsGeneration,
  getLoadEmailsRetried, setLoadEmailsRetried,
  bumpFlagChangeCounter, invalidateChatAndThreadCaches,
} from '../../stores/slices/messageListSlice';


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

  const { activeAccountId, accounts, activeMailbox } = get();
  let account = accounts.find(a => a.id === activeAccountId);
  if (!account) return;

  // Early bail if credentials are missing
  if (!hasValidCredentials(account)) {
    useMailStore.setState({
      loading: false,
      loadingMore: false,
      connectionStatus: 'error',
      connectionError: 'Password not found. Please re-enter your password in Settings.',
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

  const isStale = () => get().activeAccountId !== activeAccountId || getLoadEmailsGeneration() !== generation;

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
          connectionError: 'Loading timed out. Tap refresh to retry.',
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
        connectionError: 'Password not found. Please re-enter your password in Settings.',
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
        const isOnline = await invoke('check_network_connectivity');
        if (isStale()) return;
        console.log('[loadEmails] Network connectivity result:', isOnline);
        if (isOnline === false) {
          console.error('[loadEmails] No network connectivity detected!');
          if (!isStale()) useMailStore.setState({
            emails: previousEmails,
            connectionStatus: 'error',
            connectionError: 'No internet connection. Showing cached and locally archived emails.',
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
          connectionError: 'Could not check internet connection. Showing cached and locally archived emails.',
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
          connectionError: 'No internet connection. Showing cached and locally archived emails.',
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
    let serverTotal;
    let newUidValidity;
    let newUidNext;
    let newHighestModseq;
    let _loadMoreTimer;

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
        const serverResult = await api.fetchEmails(account, activeMailbox, 1);
        serverTotal = serverResult.total;
        mergedEmails = serverResult.emails.map((email, idx) => ({
          ...email,
          displayIndex: idx,
          isLocal: savedEmailIds.has(email.uid),
          source: 'server'
        }));
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
        status.exists >= existingEmails.length * 0.5
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
        const serverUids = await api.searchAllUids(account, activeMailbox);
        const serverUidSet = new Set(serverUids);
        useMailStore.setState({ serverUidSet });
        const storeUidSet = new Set(existingEmails.map(e => e.uid));

        const newUids = cachedUidNext
          ? serverUids.filter(uid => uid >= cachedUidNext)
          : serverUids.filter(uid => !storeUidSet.has(uid));
        const deletedUids = existingEmails.filter(e => !serverUidSet.has(e.uid)).map(e => e.uid);

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
          message: 'Server returned empty inbox unexpectedly. Showing cached data while verifying.',
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

    const existingServerUidSet = get().serverUidSet;
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
      serverUidSet: mergedServerUidSet
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
      serverUids: get().serverUidSet
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

export async function _loadEmailsViaGraph(account, activeAccountId, activeMailbox, generation) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const isStale = () => get().activeAccountId !== activeAccountId || getLoadEmailsGeneration() !== generation;

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

    const shouldRefreshMailboxes = !shouldUseFreshMailboxCacheLocal(cachedMailboxEntry) || !cachedTarget;

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

    const result = await api.graphListMessages(account.oauth2AccessToken, targetFolder._graphFolderId, 200, 0);
    if (isStale()) return;

    const headers = result.headers || [];
    const graphMessageIds = result.graphMessageIds || [];

    const uidToGraphId = new Map();
    headers.forEach((h, i) => {
      uidToGraphId.set(h.uid, graphMessageIds[i]);
    });
    _setGraphIdMap(activeAccountId, activeMailbox, uidToGraphId);

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
      serverUidSet: new Set(mergedEmails.map(e => e.uid)),
    });

    get().updateSortedEmails();

    if (activeMailbox === 'INBOX') {
      const unread = get().emails.filter(e => !e.flags?.includes('\\Seen')).length;
      useSettingsStore.getState().setUnreadForAccount(activeAccountId, unread);
    }

    // Descriptor saved on switch-away, not after every load
    db.saveEmailHeaders(activeAccountId, activeMailbox, mergedEmails, serverTotal)
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

export async function loadSentHeaders(accountId) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const sentPath = get().getSentMailboxPath();
  if (!sentPath) { useMailStore.setState({ sentEmails: [] }); return; }

  const cached = await db.getEmailHeadersPartial(accountId, sentPath, 200);
  if (get().activeAccountId !== accountId) return;
  if (cached?.emails?.length > 0) {
    useMailStore.setState({ sentEmails: cached.emails });
  }

  const { accounts, connectionStatus, mailboxes } = get();
  const account = accounts.find(a => a.id === accountId);
  if (!account || connectionStatus !== 'connected') return;

  try {
    if (isGraphAccount(account)) {
      const sentFolder = mailboxes.find(m => m.path === sentPath);
      if (sentFolder?._graphFolderId) {
        const freshAccount = await ensureFreshToken(account);
        const result = await api.graphListMessages(freshAccount.oauth2AccessToken, sentFolder._graphFolderId, 200, 0);
        if (get().activeAccountId !== accountId) return;
        const sentHeaders = result.headers || [];
        if (sentHeaders.length > 0) {
          await db.saveEmailHeaders(accountId, sentPath, sentHeaders, sentHeaders.length);
          if (get().activeAccountId !== accountId) return;
          useMailStore.setState({ sentEmails: sentHeaders });
        }
      }
    } else {
      const result = await api.fetchEmails(account, sentPath, 1, 200);
      if (get().activeAccountId !== accountId) return;
      if (result?.emails?.length > 0) {
        await db.saveEmailHeaders(accountId, sentPath, result.emails, result.total);
        if (get().activeAccountId !== accountId) return;
        useMailStore.setState({ sentEmails: result.emails });
      }
    }
  } catch (e) {
    console.warn('[loadSentHeaders] fetch failed:', e.message);
  }
}
