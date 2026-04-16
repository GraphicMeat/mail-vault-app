// ── activateAccount workflow — orchestrates account/mailbox activation ──

import { v4 as uuidv4 } from 'uuid';
import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { hasValidCredentials, ensureFreshToken, resolveServerAccount } from '../authUtils';
import { buildThreads } from '../../utils/emailParser';
import { UidMap } from '../UidMap';
import { getDaemonHealth } from '../transport';
import { syncNow, waitForSync } from '../syncService';
import { isGraphAccount, GRAPH_FOLDER_NAME_MAP, APP_TO_GRAPH_FOLDER_MAP, normalizeGraphFolderName, graphFoldersToMailboxes, inferSpecialUse, graphMessageToEmail } from '../graphConfig';
import { saveRestoreDescriptor as _saveRestore, getRestoreDescriptor as _getRestore, invalidateRestoreDescriptors as _invalidateRestore, getAccountCacheMailboxes as _getAccountMailboxes, setGraphIdMap as _setGraphIdMap, getGraphMessageId, clearGraphIdMap as _clearGraphIdMap, restoreGraphIdMap as _restoreGraphIdMap } from '../cacheManager';
import { createPerfTrace } from '../../utils/perfTrace';
import { _buildRestoreDescriptor, _resolveUnifiedContext, _selKey, _parseSelKey, _resolveMailboxPath } from '../../stores/slices/unifiedHelpers';
import {
  _resetNetworkRetry, _scheduleNetworkRetry,
  getLoadAbortController, setLoadAbortController,
  getLoadMoreTimer, setLoadMoreTimer,
  setLoadEmailsRetried, invalidateChatAndThreadCaches, bumpFlagChangeCounter,
} from '../../stores/slices/messageListSlice';

// ── AbortController for activateAccount — cancels previous activation on rapid switch ──
let _activeController = null;

// ── Unified folder cache — stores merged emails per folder for instant switching ──
const _unifiedFolderCache = new Map(); // folderId -> { emails: [...], timestamp }

const MAILBOX_CACHE_FRESH_MS = 10 * 60 * 1000;
const MAILBOX_PREFETCH_LIMIT = 2;

function isMailboxCacheFresh(fetchedAt) {
  return !!fetchedAt && (Date.now() - fetchedAt) < MAILBOX_CACHE_FRESH_MS;
}

function countMailboxes(mailboxes = []) {
  let count = 0;
  const visit = (nodes) => {
    for (const node of nodes || []) {
      count += 1;
      if (node.children?.length) visit(node.children);
    }
  };
  visit(mailboxes);
  return count;
}

function isMailboxTreeComplete(mailboxes = []) {
  const total = countMailboxes(mailboxes);
  if (total === 0) return false;
  // If any mailbox has nested children, the cache uses the old tree format — force refresh
  if (mailboxes.some(m => m.children?.length > 0)) return false;
  if (total > 1) return true;
  const only = mailboxes[0];
  return !!only && only.path !== 'INBOX';
}

function shouldUseFreshMailboxCache(entry) {
  return isMailboxCacheFresh(entry?.fetchedAt) && isMailboxTreeComplete(entry?.mailboxes);
}

async function fetchAccountMailboxes(account) {
  const freshAccount = await ensureFreshToken(account);
  if (isGraphAccount(freshAccount)) {
    const graphFolders = await api.graphListFolders(freshAccount.oauth2AccessToken);
    return graphFoldersToMailboxes(graphFolders);
  }
  return api.fetchMailboxes(freshAccount);
}

/**
 * loadMailboxes — two-stream folder loading for activateAccount.
 */
async function loadMailboxes(accountId, account, requestedMailbox, signal, useMailStoreRef, { isBackgroundRefresh = false } = {}) {
  const cachedEntry = await db.getCachedMailboxEntry(accountId).catch(() => null);
  if (signal.aborted) return null;

  let localMailboxes = cachedEntry?.mailboxes;
  if (!localMailboxes || localMailboxes.length === 0) {
    if (cachedEntry?.lastKnownGoodMailboxes?.length > 0) {
      console.warn('[loadMailboxes] Current mailbox cache empty, using last-known-good for', accountId);
      localMailboxes = cachedEntry.lastKnownGoodMailboxes;
    } else {
      localMailboxes = [{ name: 'INBOX', path: 'INBOX', specialUse: null, children: [] }];
    }
  }

  if (!isBackgroundRefresh) {
    useMailStoreRef.setState({
      mailboxes: localMailboxes,
      mailboxesFetchedAt: cachedEntry?.fetchedAt ?? null,
    });
  }

  let effectiveMailbox = requestedMailbox;
  const allPaths = new Set();
  const collectPaths = (mboxes) => {
    for (const m of mboxes) {
      allPaths.add(m.path);
      if (m.children?.length) collectPaths(m.children);
    }
  };
  collectPaths(localMailboxes);

  if (effectiveMailbox !== 'INBOX' && !allPaths.has(effectiveMailbox)) {
    console.warn(`[loadMailboxes] Mailbox "${effectiveMailbox}" not found in cache, falling back to INBOX`);
    effectiveMailbox = 'INBOX';
    if (!isBackgroundRefresh) {
      useMailStoreRef.setState({ activeMailbox: 'INBOX' });
      useSettingsStore.getState().setLastMailbox(accountId, 'INBOX');
    }
  }

  const isFresh = shouldUseFreshMailboxCache(cachedEntry);
  const serverMailboxesPromise = isFresh
    ? Promise.resolve(null)
    : fetchAccountMailboxes(account)
        .then(freshMailboxes => {
          if (signal.aborted) return null;
          if (useMailStoreRef.getState().activeAccountId !== accountId) return null;

          if (isSuspiciousEmptyMailboxResult(freshMailboxes, cachedEntry)) {
            console.warn(
              '[loadMailboxes] Server returned [] mailboxes for %s but prior cache had %d — rejecting as suspicious',
              account.email,
              countMailboxes(cachedEntry.lastKnownGoodMailboxes || cachedEntry.mailboxes)
            );
            useMailStoreRef.setState({
              suspectEmptyServerData: {
                accountId,
                type: 'mailboxes',
                message: 'Server returned empty folder list unexpectedly. Showing cached folders while verifying.',
                timestamp: Date.now(),
              },
            });
            return null;
          }

          const currentSuspect = useMailStoreRef.getState().suspectEmptyServerData;
          if (currentSuspect?.accountId === accountId && currentSuspect?.type === 'mailboxes') {
            useMailStoreRef.setState({ suspectEmptyServerData: null });
          }

          const currentMailboxes = useMailStoreRef.getState().mailboxes;
          const changed = _mailboxesChanged(currentMailboxes, freshMailboxes);

          if (changed) {
            const freshPaths = new Set();
            const collect = (mboxes) => { for (const m of mboxes) { freshPaths.add(m.path); if (m.children?.length) collect(m.children); } };
            collect(freshMailboxes);

            const updates = {
              mailboxes: freshMailboxes,
              mailboxesFetchedAt: Date.now(),
            };

            const currentActive = useMailStoreRef.getState().activeMailbox;
            if (currentActive !== 'INBOX' && currentActive !== 'UNIFIED' && !freshPaths.has(currentActive)) {
              console.warn(`[loadMailboxes] Active mailbox "${currentActive}" not found on server, switching to INBOX`);
              updates.activeMailbox = 'INBOX';
              useSettingsStore.getState().setLastMailbox(accountId, 'INBOX');
            }

            useMailStoreRef.setState(updates);
          } else {
            useMailStoreRef.setState({ mailboxesFetchedAt: Date.now() });
          }

          db.saveMailboxes(accountId, freshMailboxes);

          const existing = _getRestore(accountId, useMailStoreRef.getState().activeMailbox, useMailStoreRef.getState().viewMode || 'all');
          if (existing) {
            _saveRestore({ ...existing, mailboxes: freshMailboxes, mailboxesFetchedAt: Date.now() });
          }

          return freshMailboxes;
        })
        .catch(e => {
          console.warn('[loadMailboxes] Server fetch failed (non-fatal):', e.message);
          return null;
        });

  return { cachedEntry, localMailboxes, effectiveMailbox, serverMailboxesPromise };
}

function _mailboxesChanged(current, fresh) {
  if (!current || !fresh) return true;
  if (current.length !== fresh.length) return true;

  const pathMap = new Map();
  const walk = (nodes, map) => {
    for (const n of nodes) {
      map.set(n.path, (n.children?.length || 0));
      if (n.children?.length) walk(n.children, map);
    }
  };
  walk(current, pathMap);

  const freshMap = new Map();
  walk(fresh, freshMap);

  if (pathMap.size !== freshMap.size) return true;
  for (const [path, count] of pathMap) {
    if (freshMap.get(path) !== count) return true;
  }
  return false;
}

function isSuspiciousEmptyMailboxResult(freshMailboxes, cachedEntry) {
  if (!freshMailboxes || freshMailboxes.length > 0) return false;
  if (!cachedEntry) return false;
  const priorMailboxes = cachedEntry.lastKnownGoodMailboxes || cachedEntry.mailboxes;
  return isMailboxTreeComplete(priorMailboxes);
}

function isSuspiciousEmptyEmailResult(serverTotal, cachedHeaders, savedEmailIds) {
  if (serverTotal > 0) return false;
  const cachedTotal = cachedHeaders?.totalEmails || cachedHeaders?.lastKnownGoodTotalEmails || 0;
  const savedCount = savedEmailIds?.size || 0;
  return cachedTotal > 0 || savedCount > 0;
}

/**
 * _loadServerEmailsViaGraph — Graph API server stream for activateAccount.
 */
async function _loadServerEmailsViaGraph(account, accountId, activeMailbox, uidMap, signal, trace, useMailStoreRef) {
  const savedEmailIds = useMailStoreRef.getState().savedEmailIds;

  await _restoreGraphIdMap(accountId, activeMailbox);
  if (signal.aborted) return;

  let mailboxes = useMailStoreRef.getState().mailboxes || [];
  let targetFolder = mailboxes.find(m => m.path === activeMailbox && m._graphFolderId);

  if (!targetFolder) {
    const graphFolders = await api.graphListFolders(account.oauth2AccessToken);
    if (signal.aborted) return;
    mailboxes = graphFoldersToMailboxes(graphFolders);
    useMailStoreRef.setState({ mailboxes, mailboxesFetchedAt: Date.now() });
    db.saveMailboxes(accountId, mailboxes);
    targetFolder = mailboxes.find(m => m.path === activeMailbox);
  }

  if (!targetFolder || !targetFolder._graphFolderId) {
    console.warn('[activateAccount:graph] No matching folder for', activeMailbox);
    useMailStoreRef.setState({ loading: false, loadingMore: false, connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
    return;
  }

  const result = await api.graphListMessages(account.oauth2AccessToken, targetFolder._graphFolderId, 200, 0);
  if (signal.aborted) return;

  const headers = result.headers || [];
  const graphMessageIds = result.graphMessageIds || [];

  const uidToGraphId = new Map();
  headers.forEach((h, i) => { uidToGraphId.set(h.uid, graphMessageIds[i]); });
  _setGraphIdMap(accountId, activeMailbox, uidToGraphId);

  const serverEmails = headers.map((email, idx) => ({
    ...email,
    displayIndex: idx,
    isLocal: savedEmailIds.has(email.uid),
    source: 'server',
  }));
  uidMap.merge(serverEmails);

  const serverTotal = serverEmails.length;
  const sorted = uidMap.toSortedArray();

  if (signal.aborted) return;

  commitToStore(uidMap, signal, accountId, useMailStoreRef, {
    connectionStatus: 'connected',
    connectionError: null,
    connectionErrorType: null,
    loading: false,
    loadingMore: false,
    totalEmails: serverTotal,
    hasMoreEmails: !!result.nextLink,
    currentPage: 1,
    serverUidSet: new Set(sorted.map(e => e.uid)),
  });

  if (!useMailStoreRef.getState().unifiedInbox) {
    _saveRestore(_buildRestoreDescriptor(useMailStoreRef.getState()));
  }
  db.saveEmailHeaders(accountId, activeMailbox, sorted, serverTotal)
    .catch(e => console.warn('[activateAccount:graph] Failed to cache headers:', e));

  trace.end('graph-done', { count: sorted.length });
}

function commitToStore(uidMap, signal, accountId, useMailStoreRef, extras = {}) {
  if (signal.aborted) return;
  const store = useMailStoreRef.getState();
  if (store.activeAccountId !== accountId) return;

  const sortedEmails = uidMap.toSortedArray();
  useMailStoreRef.setState({
    emails: sortedEmails,
    totalEmails: extras.totalEmails ?? sortedEmails.length,
    loadedRanges: [{ start: 0, end: sortedEmails.length }],
    ...extras,
  });

  useMailStoreRef.getState().updateSortedEmails();
}


// ── Main activateAccount workflow ──

export async function activateAccount(accountId, mailbox, options = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();
  const set = (s) => useMailStore.setState(typeof s === 'function' ? s(get()) : s);
  const useMailStoreRef = { getState: get, setState: (s) => useMailStore.setState(s) };
  const activationTrace = createPerfTrace('activateAccount', { accountId, mailbox });

  _resetNetworkRetry();

  if (_activeController) _activeController.abort('account-switch');
  const _loadAbortController = getLoadAbortController();
  if (_loadAbortController) _loadAbortController.abort('account-switch');
  _activeController = new AbortController();
  const { signal } = _activeController;

  let account = get().accounts.find(a => a.id === accountId);
  if (!account) {
    activationTrace.end('missing-account');
    return;
  }

  if (account.authType === 'oauth2' && account.oauth2Transport !== 'graph') {
    const { isPersonalMicrosoftEmail: isPersonalMs } = await import('../graphConfig');
    if (isPersonalMs(account.email)) {
      console.log('[activateAccount] Auto-repairing transport for', account.email, '-> graph');
      account = { ...account, oauth2Transport: 'graph' };
    }
  }

  const { activeAccountId: currentAccountId, emails: currentEmails, totalEmails: currentTotalEmails } = get();
  const isMailboxSwitch = currentAccountId === accountId;

  if (currentAccountId && currentAccountId !== accountId && (currentEmails.length > 0 || currentTotalEmails > 0)) {
    _saveRestore(_buildRestoreDescriptor(get()));
  }
  const previousMailbox = get().activeMailbox;
  if (isMailboxSwitch && previousMailbox && previousMailbox !== mailbox && previousMailbox !== 'UNIFIED') {
    _saveRestore(_buildRestoreDescriptor(get(), previousMailbox));
  }

  // Skip descriptor restore on background refresh — it must do a full load,
  // otherwise it re-enters the descriptor path and loops infinitely.
  const isBackgroundRefresh = options._backgroundRefresh === true;
  const viewMode = get().viewMode || 'all';
  const restored = !isBackgroundRefresh ? _getRestore(
    accountId,
    isMailboxSwitch ? mailbox : (get().activeMailbox || mailbox),
    viewMode
  ) : null;
  if (restored) {
    const isAccountSwitch = !isMailboxSwitch;
    const label = isAccountSwitch ? 'Account' : 'Mailbox';
    console.log('[activateAccount] %s restore HIT for %s:%s — rendering %d first-window headers',
      label, accountId, restored.mailbox, restored.firstWindow.length);
    invalidateChatAndThreadCaches();

    let restoredMailboxes = restored.mailboxes;
    if (!restoredMailboxes || restoredMailboxes.length === 0) {
      const cachedMailboxEntry = await db.getCachedMailboxEntry(accountId);
      restoredMailboxes = cachedMailboxEntry?.mailboxes || [{ name: 'INBOX', path: 'INBOX', specialUse: null, children: [] }];
    }

    const restoredSavedIds = new Set(restored.firstWindowSavedUids || []);
    const restoredArchivedIds = new Set(restored.firstWindowArchivedUids || []);

    useMailStore.setState({
      activeAccountId: accountId,
      activeMailbox: restored.mailbox || mailbox,
      unifiedInbox: false,
      emails: restored.firstWindow,
      totalEmails: restored.totalEmails,
      savedEmailIds: restoredSavedIds,
      archivedEmailIds: restoredArchivedIds,
      mailboxes: restoredMailboxes,
      mailboxesFetchedAt: restored.mailboxesFetchedAt ?? null,
      serverUidSet: new Set(),
      selectedEmailId: restored.selectedUid || null,
      selectedEmail: null,
      selectedEmailSource: null,
      selectedThread: null,
      selectedEmailIds: new Set(),
      loading: false,
      loadingMore: false,
      error: null,
      restoring: true,
    });
    get().updateSortedEmails();
    activationTrace.mark('descriptor-restored', { firstWindowCount: restored.firstWindow.length });

    get().activateAccount(accountId, restored.mailbox || mailbox, { _backgroundRefresh: true }).catch(() => {});
    setTimeout(() => get().loadSentHeaders(accountId), 150);

    activationTrace.end('cache-hit-return');
    return;
  }

  invalidateChatAndThreadCaches();
  setLoadEmailsRetried(false);

  if (!isBackgroundRefresh) {
    useMailStore.setState({
      activeAccountId: accountId,
      activeMailbox: mailbox,
      unifiedInbox: false,
      // Clear stale data from previous account/mailbox — prevents cross-account bleed
      emails: [],
      localEmails: [],
      sentEmails: [],
      sortedEmails: [],
      totalEmails: 0,
      savedEmailIds: new Set(),
      archivedEmailIds: new Set(),
      serverUidSet: new Set(),
      hasMoreEmails: true,
      currentPage: 1,
      loading: true,
      selectedEmailId: null,
      selectedEmail: null,
      selectedEmailSource: null,
      selectedThread: null,
      selectedEmailIds: new Set(),
      connectionError: null,
      connectionErrorType: null,
      error: null,
    });
    if (isMailboxSwitch) {
      useSettingsStore.getState().setLastMailbox(accountId, mailbox);
    }
  }

  const uidMap = new UidMap(null);

  const mbResult = await loadMailboxes(accountId, account, mailbox, signal, useMailStoreRef, { isBackgroundRefresh });
  if (!mbResult || signal.aborted) return;
  const { effectiveMailbox: resolvedMailbox, serverMailboxesPromise } = mbResult;

  const loadLocalEmails = async () => {
    if (signal.aborted) return;
    const localTrace = createPerfTrace('loadLocal', { accountId, mailbox: resolvedMailbox });

    try {
      const effectiveMailbox = resolvedMailbox;

      const [cachedHeaders, archivedEmailIds, savedEmailIds] = await Promise.all([
        db.getEmailHeadersPartial(accountId, effectiveMailbox, 500),
        db.getArchivedEmailIds(accountId, effectiveMailbox),
        db.getSavedEmailIds(accountId, effectiveMailbox),
      ]);
      if (signal.aborted) return;
      localTrace.mark('cache-loaded', {
        cachedCount: cachedHeaders?.emails?.length || 0,
        archivedCount: archivedEmailIds.size,
        savedCount: savedEmailIds.size,
      });

      useMailStore.setState({ savedEmailIds, archivedEmailIds });

      if (cachedHeaders && cachedHeaders.emails.length > 0) {
        const headersWithSource = cachedHeaders.emails.map(e => ({
          ...e,
          source: e.source || 'cache',
          isLocal: savedEmailIds.has(e.uid),
          isArchived: archivedEmailIds.has(e.uid),
        }));
        uidMap.merge(headersWithSource);

        if (cachedHeaders.uidValidity != null) {
          uidMap.checkUidValidity(cachedHeaders.uidValidity);
        }

        commitToStore(uidMap, signal, accountId, useMailStoreRef, {
          loading: false,
          loadingMore: true,
          totalEmails: cachedHeaders.totalEmails || cachedHeaders.emails.length,
          hasMoreEmails: cachedHeaders.emails.length < (cachedHeaders.totalEmails || cachedHeaders.emails.length),
          currentPage: Math.ceil(cachedHeaders.emails.length / 200) || 1,
          ...(cachedHeaders.serverUids ? { serverUidSet: cachedHeaders.serverUids } : {}),
        });
        localTrace.mark('first-paint', { emailCount: cachedHeaders.emails.length });

        if (resolvedMailbox === 'INBOX') {
          const unread = cachedHeaders.emails.filter(e => !e.flags?.includes('\\Seen')).length;
          useSettingsStore.getState().setUnreadForAccount(accountId, unread);
        }
      } else if (savedEmailIds.size > 0 && !isBackgroundRefresh) {
        console.warn(
          '[activateAccount] Cache empty but Maildir has %d saved emails for %s/%s — treating as corrupted cache, showing local recovery data',
          savedEmailIds.size, accountId, effectiveMailbox
        );
        useMailStore.setState({
          loading: true,
          suspectEmptyServerData: {
            accountId,
            type: 'emails',
            message: 'Email cache was empty but local data exists. Rebuilding from local copies while syncing with server.',
            timestamp: Date.now(),
          },
        });
      } else if (!isBackgroundRefresh) {
        useMailStore.setState({ loading: true });
      }

      if (archivedEmailIds.size > 0) {
        const archivedAccount = accountId;
        db.getArchivedEmails(accountId, effectiveMailbox, archivedEmailIds, (batchEmails) => {
          if (signal.aborted || get().activeAccountId !== archivedAccount) return;
          useMailStore.setState({ localEmails: batchEmails });
          get().updateSortedEmails();
        }).catch(e => console.warn('[activateAccount] getArchivedEmails failed:', e));
      }

      localTrace.end('done');
    } catch (e) {
      console.warn('[activateAccount] Local stream failed (non-fatal):', e);
    }
  };

  const loadServerEmails = async () => {
    if (signal.aborted) return;
    const serverTrace = createPerfTrace('loadServer', { accountId, mailbox });

    try {
      const resolved = await resolveServerAccount(accountId, account);
      if (signal.aborted) return;
      serverTrace.mark('token-ready');

      if (!resolved.ok) {
        if (!signal.aborted) {
          useMailStore.setState({
            connectionStatus: 'error',
            connectionError: 'Password not found. Please re-enter your password in Settings.',
            connectionErrorType: 'passwordMissing',
            loading: false,
            loadingMore: false,
          });
        }
        serverTrace.end('missing-credentials');
        return;
      }
      account = resolved.account;

      const effectiveMailbox = get().activeMailbox;

      if (isGraphAccount(account)) {
        await _loadServerEmailsViaGraph(account, accountId, effectiveMailbox, uidMap, signal, serverTrace, useMailStoreRef);
        return;
      }

      const daemonHealth = getDaemonHealth();
      if (daemonHealth.alive) {
        try {
          const syncAccount = {
            id: accountId,
            email: account.email,
            imapConfig: {
              email: account.email, password: account.password,
              imapHost: account.imapHost, imapPort: account.imapPort,
              imapSecure: account.imapSecure, authType: account.authType,
              oauth2AccessToken: account.oauth2AccessToken,
              smtpHost: account.smtpHost, smtpPort: account.smtpPort,
              smtpSecure: account.smtpSecure, name: account.name,
              oauth2Transport: account.oauth2Transport,
            },
          };

          serverTrace.mark('daemon-sync-start');
          console.log('[activateAccount] Triggering daemon sync for', accountId, effectiveMailbox);
          await syncNow(syncAccount, effectiveMailbox);

          console.log('[activateAccount] Waiting for daemon sync completion...');
          const syncResult = await waitForSync(accountId, 30000);
          console.log('[activateAccount] Daemon sync result:', JSON.stringify(syncResult));
          if (signal.aborted) return;

          serverTrace.mark('daemon-sync-complete', {
            success: syncResult?.success,
            newEmails: syncResult?.new_emails,
            total: syncResult?.total_emails,
          });

          if (syncResult?.success) {
            console.log('[activateAccount] Re-reading cache after daemon sync...');
            const freshCache = await db.getEmailHeadersPartial(accountId, effectiveMailbox, 500);
            console.log('[activateAccount] Cache read:', freshCache?.emails?.length, 'emails, total:', freshCache?.totalEmails);
            if (signal.aborted) return;

            if (freshCache?.emails?.length > 0) {
              const headersWithSource = freshCache.emails.map(e => ({
                ...e,
                source: 'cache',
                isLocal: get().savedEmailIds.has(e.uid),
                isArchived: get().archivedEmailIds.has(e.uid),
              }));
              uidMap.merge(headersWithSource);
              if (freshCache.uidValidity != null) uidMap.checkUidValidity(freshCache.uidValidity);

              commitToStore(uidMap, signal, accountId, useMailStoreRef, {
                connectionStatus: 'connected',
                connectionError: null,
                connectionErrorType: null,
                suspectEmptyServerData: null,
                loading: false,
                loadingMore: false,
                totalEmails: freshCache.totalEmails || freshCache.emails.length,
                hasMoreEmails: freshCache.emails.length < (freshCache.totalEmails || freshCache.emails.length),
                currentPage: Math.ceil(freshCache.emails.length / 200) || 1,
                ...(freshCache.serverUids ? { serverUidSet: freshCache.serverUids } : {}),
              });

              // Descriptor saved on switch-away, not during load
              db.saveEmailHeaders(accountId, effectiveMailbox, uidMap.toSortedArray(), freshCache.totalEmails || freshCache.emails.length)
                .catch(e => console.warn('[activateAccount] Failed to persist headers:', e));
            }

            serverTrace.end('daemon-sync-done', { emailCount: freshCache?.emails?.length || 0 });
          } else {
            if (!signal.aborted) {
              useMailStore.setState({
                connectionStatus: 'error',
                connectionError: syncResult?.error || 'Sync failed',
                connectionErrorType: 'serverError',
                loading: false,
                loadingMore: false,
              });
            }
            serverTrace.end('daemon-sync-error', { error: syncResult?.error });
          }
          return;
        } catch (e) {
          console.warn('[activateAccount] Daemon sync failed:', e.message);
          serverTrace.mark('daemon-sync-fallback');
        }
      }

      // ── IMAP fallback (only when daemon is not alive) ──
      const invoke = window.__TAURI__?.core?.invoke;
      if (invoke) {
        try {
          const isOnline = await invoke('check_network_connectivity');
          if (signal.aborted) return;
          if (isOnline === false) {
            useMailStore.setState({ connectionStatus: 'error', connectionError: 'No internet connection. Showing cached emails.', connectionErrorType: 'offline', loading: false, loadingMore: false });
            serverTrace.end('offline');
            return;
          }
        } catch {
          useMailStore.setState({ connectionStatus: 'error', connectionError: 'Could not check internet.', connectionErrorType: 'offline', loading: false, loadingMore: false });
          serverTrace.end('connectivity-failed');
          return;
        }
      } else if (!navigator.onLine) {
        useMailStore.setState({ connectionStatus: 'error', connectionError: 'No internet connection.', connectionErrorType: 'offline', loading: false, loadingMore: false });
        serverTrace.end('browser-offline');
        return;
      }

      // ── IMAP path ──
      const cachedMeta = await db.getEmailHeadersMeta(accountId, effectiveMailbox);
      if (signal.aborted) return;

      const cachedUidValidity = cachedMeta?.uidValidity;
      const cachedUidNext = cachedMeta?.uidNext;
      const cachedHighestModseq = cachedMeta?.highestModseq;
      const hasCachedSync = cachedUidValidity != null && cachedUidNext != null && uidMap.size > 0;

      let serverEmails;
      let serverTotal;
      let newUidValidity;
      let newUidNext;
      let newHighestModseq;
      const savedEmailIds = get().savedEmailIds;

      if (hasCachedSync) {
        const status = await api.checkMailboxStatus(account, effectiveMailbox);
        if (signal.aborted) return;
        serverTrace.mark('mailbox-status', {
          exists: status.exists,
          uidNext: status.uidNext,
          highestModseq: status.highestModseq ?? null,
        });

        newUidValidity = status.uidValidity;
        newUidNext = status.uidNext;
        newHighestModseq = status.highestModseq ?? null;
        serverTotal = status.exists;

        if (newUidValidity !== cachedUidValidity) {
          console.log('[activateAccount] UIDVALIDITY changed (%d -> %d), full reload', cachedUidValidity, newUidValidity);
          uidMap.invalidate();
          uidMap.checkUidValidity(newUidValidity);
          const serverResult = await api.fetchEmails(account, effectiveMailbox, 1);
          if (signal.aborted) return;
          serverTotal = serverResult.total;
          serverEmails = serverResult.emails.map((email, idx) => ({
            ...email,
            displayIndex: idx,
            isLocal: savedEmailIds.has(email.uid),
            source: 'server',
          }));
        } else if (
          newHighestModseq != null && cachedHighestModseq != null &&
          newHighestModseq === cachedHighestModseq &&
          newUidNext === cachedUidNext
        ) {
          console.log('[activateAccount] CONDSTORE: nothing changed');
          useMailStore.setState({
            connectionStatus: 'connected',
            connectionError: null,
            connectionErrorType: null,
            suspectEmptyServerData: null,
            loading: false,
            loadingMore: false,
            totalEmails: serverTotal,
          });
          get().updateSortedEmails();

          if (uidMap.size < serverTotal) {
            useMailStore.setState({ hasMoreEmails: true, totalEmails: serverTotal });
            const _loadMoreTimer = getLoadMoreTimer();
            if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
            setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, 500));
          }

          // Descriptor saved on switch-away, not during load

          serverTrace.end('condstore-noop');
          return;
        } else if (newUidNext === cachedUidNext && serverTotal <= (cachedMeta?.totalCached ?? uidMap.size)) {
          useMailStore.setState({
            connectionStatus: 'connected',
            connectionError: null,
            connectionErrorType: null,
            loading: false,
            loadingMore: false,
            totalEmails: serverTotal,
          });
          get().updateSortedEmails();

          if (uidMap.size < serverTotal) {
            useMailStore.setState({ hasMoreEmails: true });
            const _loadMoreTimer = getLoadMoreTimer();
            if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
            setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, 500));
          }

          // Descriptor saved on switch-away, not during load

          serverTrace.end('delta-noop');
          return;
        } else {
          console.log('[activateAccount] Delta-sync: something changed');

          if (newHighestModseq != null && cachedHighestModseq != null && newHighestModseq !== cachedHighestModseq) {
            try {
              const changes = await api.fetchChangedFlags(account, effectiveMailbox, cachedHighestModseq);
              if (signal.aborted) return;
              if (changes.length > 0) {
                const changeMap = new Map(changes.map(c => [c.uid, c.flags]));
                for (const [uid, flags] of changeMap) {
                  const existing = uidMap.get(uid);
                  if (existing) {
                    uidMap.set(uid, { ...existing, flags });
                  }
                }
              }
            } catch (e) {
              console.warn('[activateAccount] Flag sync failed, continuing with UID search:', e);
            }
          }

          const serverUids = await api.searchAllUids(account, effectiveMailbox);
          if (signal.aborted) return;
          const serverUidSet = new Set(serverUids);
          useMailStore.setState({ serverUidSet });

          const existingEmails = uidMap.toSortedArray();
          const storeUidSet = new Set(existingEmails.map(e => e.uid));
          const newUids = cachedUidNext
            ? serverUids.filter(uid => uid >= cachedUidNext)
            : serverUids.filter(uid => !storeUidSet.has(uid));

          for (const email of existingEmails) {
            if (!serverUidSet.has(email.uid)) {
              uidMap.delete(email.uid);
            }
          }

          if (newUids.length > 0) {
            const sortedNewUids = [...newUids].sort((a, b) => b - a);
            const { emails: newHeaders } = await api.fetchHeadersByUids(account, effectiveMailbox, sortedNewUids);
            if (signal.aborted) return;
            const newEmailsWithMeta = newHeaders.map(email => ({
              ...email,
              isLocal: savedEmailIds.has(email.uid),
              source: 'server',
            }));
            uidMap.merge(newEmailsWithMeta);
          }

          serverEmails = null;
          serverTotal = status.exists;
        }
      } else {
        console.log('[activateAccount] Fresh fetch: %s mailbox=%s', account.email, effectiveMailbox);
        const serverResult = await api.fetchEmails(account, effectiveMailbox, 1);
        if (signal.aborted) return;
        serverTotal = serverResult.total;

        try {
          const status = await api.checkMailboxStatus(account, effectiveMailbox);
          newUidValidity = status.uidValidity;
          newUidNext = status.uidNext;
          newHighestModseq = status.highestModseq ?? null;
        } catch (e) {
          console.warn('[activateAccount] Could not get mailbox status:', e);
        }

        serverEmails = serverResult.emails.map((email, idx) => ({
          ...email,
          displayIndex: idx,
          isLocal: savedEmailIds.has(email.uid),
          source: 'server',
        }));
      }

      if (serverEmails) {
        uidMap.merge(serverEmails);
      }

      if (signal.aborted) return;

      const existingServerUidSet = get().serverUidSet;
      const sorted = uidMap.toSortedArray();
      const mergedServerUidSet = existingServerUidSet.size > 0
        ? new Set([...existingServerUidSet, ...sorted.map(e => e.uid)])
        : new Set(sorted.map(e => e.uid));

      setLoadEmailsRetried(false);
      commitToStore(uidMap, signal, accountId, useMailStoreRef, {
        connectionStatus: 'connected',
        connectionError: null,
        connectionErrorType: null,
        suspectEmptyServerData: null,
        loading: false,
        loadingMore: false,
        totalEmails: serverTotal,
        hasMoreEmails: sorted.length < serverTotal,
        currentPage: Math.ceil(sorted.length / 200) || 1,
        serverUidSet: mergedServerUidSet,
      });
      serverTrace.mark('server-merged', { count: sorted.length, serverTotal });

      // Descriptor saved on switch-away, not during load

      db.saveEmailHeaders(accountId, effectiveMailbox, sorted, serverTotal, {
        uidValidity: newUidValidity,
        uidNext: newUidNext,
        highestModseq: newHighestModseq ?? null,
        serverUids: get().serverUidSet,
      }).catch(e => console.warn('[activateAccount] Failed to cache headers:', e));

      if (sorted.length < serverTotal) {
        const _loadMoreTimer = getLoadMoreTimer();
        if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
        setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, 500));
      }

      serverTrace.end('done');
    } catch (error) {
      console.error('[activateAccount] Server stream failed:', error);

      let errorType = 'serverError';
      let errorMessage = error.message;

      if (error.message?.includes('authenticated but not connected') || error.message?.includes('Command Error. 12')) {
        errorType = 'outlookOAuth';
        errorMessage = 'Microsoft IMAP connection failed. This is a known Microsoft server issue affecting personal Outlook.com accounts with OAuth2. See FAQ for details.';
      } else if (error.message?.includes('XOAUTH2 auth failed')) {
        errorType = 'oauthExpired';
        const { isPersonalMicrosoftEmail: isPersonalMs } = await import('../graphConfig');
        if (isPersonalMs(account?.email)) {
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

      if (!signal.aborted) {
        useMailStore.setState({
          connectionStatus: 'error',
          connectionError: errorMessage,
          connectionErrorType: errorType,
        });
        get().updateSortedEmails();

        const noRetry = errorType === 'passwordMissing' || errorType === 'oauthExpired' || errorType === 'outlookOAuth';
        if (!noRetry) {
          _scheduleNetworkRetry(useMailStoreRef);
        }
      }
      serverTrace.end('error', { message: error.message });
    } finally {
      if (!signal.aborted) useMailStore.setState({ loading: false, loadingMore: false, restoring: false });
    }
  };

  const loadingGuard = setTimeout(() => {
    if (get().activeAccountId === accountId && get().loading) {
      console.warn('[activateAccount] Loading timeout — clearing stuck state after 20s');
      const hasEmails = get().emails.length > 0;
      useMailStore.setState({
        loading: false,
        loadingMore: false,
        restoring: false,
        ...(!hasEmails ? {
          connectionStatus: 'error',
          connectionError: 'Loading timed out. Tap refresh to retry.',
          connectionErrorType: 'timeout',
        } : {}),
      });
    }
  }, 20000);

  try {
    await Promise.all([loadLocalEmails(), loadServerEmails()]);

    if (!signal.aborted && get().activeAccountId === accountId) {
      get().loadSentHeaders(accountId);

      if (serverMailboxesPromise) {
        await serverMailboxesPromise;
      }
    }
  } finally {
    clearTimeout(loadingGuard);
  }

  // Clear restoring flag — disk hydration and/or server sync is complete
  if (get().restoring) {
    useMailStore.setState({ restoring: false });
  }

  activationTrace.end('done', { emailCount: get().emails.length });
}


// ── init workflow ──

export async function init() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();
  const set = (s) => useMailStore.setState(typeof s === 'function' ? s(get()) : s);

  try {
    console.log('[init] Starting db.initDB...');
    await db.initDB();
    console.log('[init] db.initDB done, getting accounts...');
    const accounts = await db.getAccounts();
    console.log('[init] Got', accounts.length, 'accounts');
    useMailStore.setState({ accounts });

    if (accounts.length > 0) {
      await db.ensureAccountsInFile(accounts);
      const { hiddenAccounts } = useSettingsStore.getState();
      const { activeAccountId: currentActiveId } = get();

      const currentIsValid = currentActiveId && accounts.some(a => a.id === currentActiveId) && !hiddenAccounts[currentActiveId];
      const firstVisible = currentIsValid
        ? accounts.find(a => a.id === currentActiveId)
        : (accounts.find(a => !hiddenAccounts[a.id]) || accounts[0]);

      if (!firstVisible) {
        useMailStore.setState({ loading: false });
        return;
      }

      const hasCredentials = firstVisible.password || (firstVisible.authType === 'oauth2' && firstVisible.oauth2AccessToken);

      if (!hasCredentials) {
        console.log('[init] Credentials not available for', firstVisible.email);
        useMailStore.setState({
          loading: false,
          connectionError: 'Password not found. Click Retry or re-enter in Settings.',
          connectionErrorType: 'passwordMissing'
        });
        const cachedMailboxEntry = await db.getCachedMailboxEntry(firstVisible.id);
        if (cachedMailboxEntry?.mailboxes) {
          useMailStore.setState({ mailboxes: cachedMailboxEntry.mailboxes, mailboxesFetchedAt: cachedMailboxEntry.fetchedAt });
        }
      } else if (currentActiveId === firstVisible.id) {
        const { emails: currentEmails, loading: currentLoading, sortedEmails: currentSorted } = get();
        console.log('[init] Account already active: emails=%d, sortedEmails=%d, loading=%s', currentEmails.length, currentSorted.length, currentLoading);
        if (currentEmails.length === 0) {
          // Quick-load set account active but didn't hydrate — force activation
          console.log('[init] No emails hydrated — forcing activateAccount');
          const lastMailbox = useSettingsStore.getState().getLastMailbox(firstVisible.id);
          await get().activateAccount(firstVisible.id, lastMailbox || 'INBOX');
        } else if (currentLoading) {
          // Loading stuck with emails present — clear the flag
          console.warn('[init] Loading stuck with %d emails — forcing loading=false', currentEmails.length);
          useMailStore.setState({ loading: false });
          if (currentSorted.length === 0) get().updateSortedEmails();
        }
      } else {
        const lastMailbox = useSettingsStore.getState().getLastMailbox(firstVisible.id);
        await get().activateAccount(firstVisible.id, lastMailbox || 'INBOX');
      }
    }

    get()._prewarmAccountCaches()
      .catch(() => {})
      .then(() => {
        const schedulePrefetch = () => get()._prefetchAllMailboxes({ limit: MAILBOX_PREFETCH_LIMIT }).catch(() => {});
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(() => setTimeout(schedulePrefetch, 5000), { timeout: 15000 });
        } else {
          setTimeout(schedulePrefetch, 15000);
        }
      });
  } catch (error) {
    console.error('Failed to initialize:', error);
    useMailStore.setState({ error: error.message, loading: false });
  }
}


// ── _prefetchAllMailboxes workflow ──

export async function _prefetchAllMailboxes({ limit = MAILBOX_PREFETCH_LIMIT } = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { accounts, activeAccountId } = get();
  const { hiddenAccounts } = useSettingsStore.getState();

  const otherAccounts = accounts.filter(a =>
    a.id !== activeAccountId && !hiddenAccounts[a.id]
  );

  if (otherAccounts.length === 0) return;
  const mailboxEntries = await Promise.all(otherAccounts.map(async account => ({
    account,
    entry: await db.getCachedMailboxEntry(account.id).catch(() => null),
  })));
  const staleAccounts = mailboxEntries
    .filter(({ entry }) => !shouldUseFreshMailboxCache(entry))
    .sort((a, b) => (a.entry?.fetchedAt || 0) - (b.entry?.fetchedAt || 0))
    .slice(0, limit);

  if (staleAccounts.length === 0) return;
  console.log('[prefetch] Pre-fetching mailboxes for', staleAccounts.length, 'background accounts');

  await Promise.allSettled(staleAccounts.map(async ({ account, entry }) => {
    try {
      if (shouldUseFreshMailboxCache(entry)) return;
      const mailboxes = await fetchAccountMailboxes(account);

      if (isSuspiciousEmptyMailboxResult(mailboxes, entry)) {
        console.warn(`[prefetch] Server returned [] mailboxes for ${account.email} — skipping persist (prior cache had data)`);
        return;
      }

      await db.saveMailboxes(account.id, mailboxes);
      const cachedDesc = _getRestore(account.id, 'INBOX', 'all');
      if (cachedDesc) {
        _saveRestore({ ...cachedDesc, mailboxes, mailboxesFetchedAt: Date.now() });
      }
    } catch (e) {
      console.warn(`[prefetch] Mailbox fetch failed for ${account.email} (non-fatal):`, e.message);
    }
  }));
  console.log('[prefetch] Mailbox pre-fetch complete');
}


// ── _prewarmAccountCaches workflow ──

export async function _prewarmAccountCaches() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { accounts, activeAccountId } = get();
  const { hiddenAccounts } = useSettingsStore.getState();

  const otherAccounts = accounts.filter(a =>
    a.id !== activeAccountId && !hiddenAccounts[a.id]
  );

  if (otherAccounts.length === 0) return;
  console.log('[prewarm] Pre-warming account cache for', otherAccounts.length, 'background accounts');

  await Promise.allSettled(otherAccounts.map(async (account) => {
    if (_getRestore(account.id, 'INBOX', 'all')) return;

    try {
      const [cachedHeaders, archivedEmailIds, savedEmailIds, cachedMailboxEntry] = await Promise.all([
        db.getEmailHeadersPartial(account.id, 'INBOX', 500),
        db.getArchivedEmailIds(account.id, 'INBOX'),
        db.getSavedEmailIds(account.id, 'INBOX'),
        db.getCachedMailboxEntry(account.id).catch(() => null),
      ]);
      if (!cachedHeaders || !cachedHeaders.emails || cachedHeaders.emails.length === 0) return;

      const cachedMailboxes = cachedMailboxEntry?.mailboxes || null;

      let localEmails = [];
      if (archivedEmailIds.size > 0) {
        try {
          localEmails = await db.readLocalEmailIndex(account.id, 'INBOX') ||
            await db.getArchivedEmails(account.id, 'INBOX', archivedEmailIds);
        } catch (e) {
          console.warn(`[prewarm] Failed to load local emails for ${account.email}:`, e.message);
        }
      }

      _saveRestore({
        accountId: account.id,
        mailbox: 'INBOX',
        viewMode: 'all',
        totalEmails: cachedHeaders.totalEmails || cachedHeaders.emails.length,
        topVisibleIndex: 0,
        selectedUid: null,
        mailboxes: cachedMailboxes || [],
        mailboxesFetchedAt: cachedMailboxEntry?.fetchedAt ?? null,
        firstWindow: cachedHeaders.emails.slice(0, 50),
        firstWindowSavedUids: cachedHeaders.emails.slice(0, 50)
          .filter(e => savedEmailIds.has(e.uid)).map(e => e.uid),
        firstWindowArchivedUids: cachedHeaders.emails.slice(0, 50)
          .filter(e => archivedEmailIds.has(e.uid)).map(e => e.uid),
        timestamp: Date.now(),
      });
      const unread = cachedHeaders.emails.filter(e => !e.flags?.includes('\\Seen')).length;
      useSettingsStore.getState().setUnreadForAccount(account.id, unread);

      console.log('[prewarm] Cached', cachedHeaders.emails.length, 'headers +', localEmails.length, 'local emails for', account.email);
    } catch (e) {
      console.warn(`[prewarm] Failed for ${account.email} (non-fatal):`, e.message);
    }
  }));
  console.log('[prewarm] Account cache pre-warm complete');
}


// ── addAccount workflow ──

export async function addAccount(accountData) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const existingAccount = get().accounts.find(
    a => a.email.toLowerCase() === accountData.email.toLowerCase()
  );
  if (existingAccount) {
    throw new Error('An account with this email address already exists');
  }

  const account = {
    id: uuidv4(),
    ...accountData,
    createdAt: new Date().toISOString()
  };
  console.log('[mailStore] Created account object with id:', account.id);

  console.log('[mailStore] Testing connection...');
  try {
    if (isGraphAccount(account)) {
      const freshAccount = await ensureFreshToken(account);
      await api.graphListFolders(freshAccount.oauth2AccessToken);
    } else {
      await api.testConnection(account);
    }
    console.log('[mailStore] Connection test successful');
  } catch (error) {
    console.error('[mailStore] Connection test failed:', error);
    throw typeof error === 'string' ? new Error(error) : error;
  }

  console.log('[mailStore] Saving account to database...');
  try {
    await db.saveAccount(account);
    console.log('[mailStore] Account saved successfully');
  } catch (error) {
    console.error('[mailStore] Failed to save account:', error);
    throw error;
  }

  useMailStore.setState(state => ({
    accounts: [...state.accounts, account]
  }));
  console.log('[mailStore] Account added to store');

  if (get().accounts.length === 1) {
    await get().activateAccount(account.id, 'INBOX');
  }

  return account;
}


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


// ── setActiveAccount workflow ──

export async function setActiveAccount(accountId) {
  const { useMailStore } = await import('../../stores/mailStore');
  const lastMailbox = useSettingsStore.getState().getLastMailbox(accountId);
  await useMailStore.getState().activateAccount(accountId, lastMailbox || 'INBOX');
}


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


// ── retryKeychainAccess workflow ──

export async function retryKeychainAccess() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { activeAccountId } = get();

  console.log('[mailStore] Retrying keychain access...');

  try {
    db.clearCredentialsCache();

    const freshAccounts = await db.getAccounts();

    if (freshAccounts.length === 0) {
      console.warn('[mailStore] No accounts found after keychain retry');
      useMailStore.setState({
        connectionError: 'No accounts found. Please add your account in Settings.',
        connectionErrorType: 'passwordMissing'
      });
      return false;
    }

    const activeAccount = freshAccounts.find(a => a.id === activeAccountId);
    const hasCredentials = activeAccount && (activeAccount.password || (activeAccount.authType === 'oauth2' && activeAccount.oauth2AccessToken));

    if (!hasCredentials) {
      console.warn('[mailStore] Active account still has no credentials after keychain retry');
      useMailStore.setState({
        accounts: freshAccounts,
        connectionError: 'Password not found. Please re-enter your password in Settings.',
        connectionErrorType: 'passwordMissing'
      });
      return false;
    }

    console.log('[mailStore] Keychain retry successful, reloading...');
    useMailStore.setState({
      accounts: freshAccounts,
      connectionStatus: 'connecting',
      connectionError: null,
      connectionErrorType: null
    });

    const { activeMailbox } = get();
    await get().activateAccount(activeAccountId, activeMailbox || 'INBOX');
    return true;
  } catch (error) {
    console.error('[mailStore] Keychain retry failed:', error);
    useMailStore.setState({
      connectionError: 'Could not access Keychain. Please re-enter your password in Settings.',
      connectionErrorType: 'passwordMissing'
    });
    return false;
  }
}

// ── Expose _unifiedFolderCache for loadUnifiedInbox workflow ──
export { _unifiedFolderCache, fetchAccountMailboxes, shouldUseFreshMailboxCache, isSuspiciousEmptyMailboxResult, MAILBOX_PREFETCH_LIMIT };
