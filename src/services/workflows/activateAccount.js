// ── activateAccount workflow — orchestrates account/mailbox activation ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { ensureFreshToken, resolveServerAccount } from '../authUtils';
import { buildThreads } from '../../utils/emailParser';
import { UidMap } from '../UidMap';
import { getDaemonHealth } from '../transport';
import { syncNow, waitForSync } from '../syncService';
import { mailboxIsUnchanged, markVerified } from '../syncProbe';
import { recall as memoRecall, remember as memoRemember, peek as memoPeek } from '../headerMemo';
import { checkRestoreNeeded } from '../restoreDetection';
import { isGraphAccount, GRAPH_FOLDER_NAME_MAP, graphFoldersToMailboxes, inferSpecialUse, graphMessageToEmail } from '../graphConfig';
import { saveRestoreDescriptor as _saveRestore, getRestoreDescriptor as _getRestore, setGraphIdMap as _setGraphIdMap, getGraphMessageId, restoreGraphIdMap as _restoreGraphIdMap } from '../cacheManager';
import { createPerfTrace } from '../../utils/perfTrace';
import { countMailboxes, isMailboxTreeComplete, pickMailboxList, INBOX_PLACEHOLDER, retryOnce } from './mailboxTree';
import { _buildRestoreDescriptor, _resolveUnifiedContext, _selKey, _parseSelKey } from '../../stores/slices/unifiedHelpers';
import { serverVerifiedPatch, shortWindowPatch } from '../../stores/slices/syncSlice';
import { serverUids, NO_SERVER_UIDS } from '../../stores/slices/serverUids';
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
      localMailboxes = INBOX_PLACEHOLDER;
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
    // One retry: the first fetch of a session races credential loading and
    // fails with "Password missing". The IMAP pool recovers milliseconds
    // later, but nothing re-ran this — and the background prefetch skips the
    // active account — so that account kept the INBOX placeholder all session.
    : retryOnce(() => fetchAccountMailboxes(account), { isAborted: () => signal.aborted })
        .then(freshMailboxes => {
          if (!freshMailboxes) return null;
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

  // Embed Graph message ID directly on each header — avoids fragile positional
  // UID→GraphID map that breaks when email order changes between fetches.
  const uidToGraphId = new Map();
  headers.forEach((h, i) => {
    h._graphId = graphMessageIds[i];
    uidToGraphId.set(h.uid, graphMessageIds[i]);
  });
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

  commitToStore(uidMap, signal, accountId, useMailStoreRef, serverVerifiedPatch({
    totalEmails: serverTotal,
    hasMoreEmails: !!result.nextLink,
    currentPage: 1,
    serverUids: serverUids(sorted.map(e => e.uid), { complete: !result.nextLink }),
  }));

  if (!useMailStoreRef.getState().unifiedInbox) {
    _saveRestore(_buildRestoreDescriptor(useMailStoreRef.getState()));
  }
  db.saveEmailHeaders(accountId, activeMailbox, sorted, serverTotal)
    .catch(e => console.warn('[activateAccount:graph] Failed to cache headers:', e));

  trace.end('graph-done', { count: sorted.length });
}

/**
 * Keep the mailbox we're leaving in memory so switching back doesn't re-read
 * every sidecar off disk (one file per message — 15k for a large mailbox).
 *
 * Snapshots the STORE, not the disk read that seeded it: flag changes made
 * during the visit (mark read, star) are written to sidecars without moving
 * `_meta.json`, so a disk-time snapshot would fail to look stale and would
 * serve pre-read flags back on return.
 *
 * Fire-and-forget — a failure here only costs the next switch a disk walk.
 */
function _memoizeOutgoing(accountId, mailbox, emails) {
  if (!accountId || !mailbox || mailbox === 'UNIFIED' || !emails?.length) return;
  // Optimistic sent rows aren't on disk yet; counting them could let a partial
  // set clear the completeness bar and be recalled as if whole.
  const settled = emails.filter(e => !e._optimistic);
  db.getEmailHeadersMeta(accountId, mailbox)
    .then(meta => memoRemember(accountId, mailbox, settled, meta))
    .catch(() => {});
}

/**
 * Resume the cache drain when the list on screen is short of what we hold.
 *
 * The paths that verify the server against the CACHE return without touching
 * the list — correctly, since nothing changed server-side. But the list is a
 * window onto that cache and can be short of it, and no one else re-checks:
 * every later activation asks the same question, gets "unchanged", and returns.
 * The IMAP fallback already re-arms the drain this way (the CONDSTORE branches
 * in `loadServerEmails`); the daemon's probe-unchanged branch did not, which is
 * how a list stuck at "3 of 11 emails" survived any number of reload clicks.
 */
async function _resumeDrainIfWindowShort(accountId, mailbox, signal, useMailStoreRef, get) {
  const meta = await db.getEmailHeadersMeta(accountId, mailbox).catch(() => null);
  if (signal.aborted) return;

  const state = useMailStoreRef.getState();
  if (state.activeAccountId !== accountId || state.activeMailbox !== mailbox) return;

  const patch = shortWindowPatch(state.emails.length, meta);
  if (!patch) return;

  console.log('[activateAccount] Window short of cache for %s/%s (%d of %d) — resuming drain',
    accountId, mailbox, state.emails.length, patch.totalEmails);
  useMailStoreRef.setState(patch);

  const timer = getLoadMoreTimer();
  if (timer) clearTimeout(timer);
  setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, 200));
}

function commitToStore(uidMap, signal, accountId, useMailStoreRef, extras = {}) {
  if (signal.aborted) return;
  const store = useMailStoreRef.getState();
  if (store.activeAccountId !== accountId) return;

  const sortedEmails = uidMap.toSortedArray();

  // Preserve optimistic sent-email entries that have not yet been reconciled
  // by the server copy. IMAP APPEND can lag the UI by >8s on slow servers;
  // wiping them here would make a just-sent email vanish from the Sent list
  // until the next refresh. Match by messageId (set by the optimistic insert).
  const freshMessageIds = new Set(sortedEmails.map(e => e.messageId).filter(Boolean));
  const optimisticSurvivors = (store.emails || []).filter(
    e => e._optimistic && e._accountId === accountId && !freshMessageIds.has(e.messageId)
  );
  const merged = optimisticSurvivors.length > 0
    ? [...optimisticSurvivors, ...sortedEmails]
    : sortedEmails;

  useMailStoreRef.setState({
    emails: merged,
    totalEmails: (extras.totalEmails ?? sortedEmails.length) + optimisticSurvivors.length,
    loadedRanges: [{ start: 0, end: merged.length }],
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
    _memoizeOutgoing(currentAccountId, get().activeMailbox, currentEmails);
  }
  const previousMailbox = get().activeMailbox;
  if (isMailboxSwitch && previousMailbox && previousMailbox !== mailbox && previousMailbox !== 'UNIFIED') {
    _saveRestore(_buildRestoreDescriptor(get(), previousMailbox));
    _memoizeOutgoing(currentAccountId, previousMailbox, currentEmails);
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

    // The descriptor holds a 50-row window, but the complete set for this
    // mailbox is usually still in memory from the last visit — paint that.
    // Painting 50 rows against a totalEmails of 9,065 is what made the counter
    // drop and climb again on every switch, and the memo was only consulted
    // afterwards, by which point a background sync had often invalidated it.
    // Freshness is the background refresh's job either way.
    const memoPainted = memoPeek(accountId, restored.mailbox || mailbox);
    // Optimistic sent rows are excluded from the memo (they aren't on disk yet)
    // but the descriptor window carries them. Painting the memo alone would make
    // a send still waiting on IMAP APPEND vanish from Sent on a switch away and
    // back — the store is where `commitToStore` looks to preserve them, and this
    // setState replaces it.
    const optimistic = memoPainted
      ? restored.firstWindow.filter(e => e._optimistic)
      : [];
    const painted = !memoPainted
      ? restored.firstWindow
      : optimistic.length
        ? [...optimistic, ...memoPainted]
        : memoPainted;

    console.log('[activateAccount] %s restore HIT for %s:%s — rendering %d headers (%s)',
      label, accountId, restored.mailbox, painted.length,
      memoPainted ? 'in-memory set' : 'first window');
    invalidateChatAndThreadCaches();

    // The descriptor snapshots whatever the store held, so it can carry the
    // INBOX placeholder from a session whose folder fetch failed. Painting that
    // over a cache that has since been filled is what left the sidebar (and the
    // Move dropdown) showing one folder for good — the background refresh that
    // follows sees a fresh cache, fetches nothing, and writes nothing.
    let restoredMailboxes = restored.mailboxes;
    if (!isMailboxTreeComplete(restoredMailboxes)) {
      const cachedMailboxEntry = await db.getCachedMailboxEntry(accountId);
      restoredMailboxes = pickMailboxList(restored.mailboxes, cachedMailboxEntry?.mailboxes);
    }

    const restoredSavedIds = new Set(restored.firstWindowSavedUids || []);
    const restoredArchivedIds = new Set(restored.firstWindowArchivedUids || []);
    // The descriptor only lists saved/archived UIDs for its own window; past it,
    // recover them from the rows, which carry the flags.
    for (const e of painted) {
      if (e.isLocal) restoredSavedIds.add(e.uid);
      if (e.isArchived) restoredArchivedIds.add(e.uid);
    }

    useMailStore.setState({
      activeAccountId: accountId,
      activeMailbox: restored.mailbox || mailbox,
      unifiedInbox: false,
      emails: painted,
      totalEmails: restored.totalEmails,
      // All three were previously left at the OUTGOING account's values, so
      // pagination and range loading ran against a window that no longer
      // existed. `hasMoreEmails` is false rather than `painted.length <
      // totalEmails` on purpose: this paint is a placeholder, and a placeholder
      // must not arm pagination. On a 50-row window it would immediately fire
      // `loadMoreEmails`, whose `_drainCache` slices by UID order the window
      // doesn't follow — racing the background refresh that is about to set the
      // real value a few milliseconds later.
      hasMoreEmails: false,
      loadedRanges: [{ start: 0, end: painted.length }],
      cachedCount: 0,
      // The outgoing account's drain may still be in flight holding this true;
      // leaving it set would block pagination for the incoming one.
      loadingMore: false,
      savedEmailIds: restoredSavedIds,
      archivedEmailIds: restoredArchivedIds,
      mailboxes: restoredMailboxes,
      mailboxesFetchedAt: restored.mailboxesFetchedAt ?? null,
      serverUids: NO_SERVER_UIDS,
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
    activationTrace.mark('descriptor-restored', { paintedCount: painted.length });

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
      serverUids: NO_SERVER_UIDS,
      cachedCount: 0,
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

      // Prefer the headers still in memory from the last time this mailbox was
      // open. Reading them back off disk means one file per message — 15,000
      // reads and parses for a large mailbox — and it ran on every switch,
      // which is why the list restarted at "500 of 15,065" and climbed each
      // time. `_meta.json` is read either way and doubles as the staleness
      // check, so a hit costs nothing extra and a miss costs nothing either.
      const [memoMeta, archivedEmailIds, savedEmailIds] = await Promise.all([
        db.getEmailHeadersMeta(accountId, effectiveMailbox),
        db.getArchivedEmailIds(accountId, effectiveMailbox),
        db.getSavedEmailIds(accountId, effectiveMailbox),
      ]);
      if (signal.aborted) return;

      // On a stamp mismatch this re-reads only the sidecars that moved (readdir
      // + mtime, then one read per changed UID) instead of discarding the set —
      // a single new message used to cost a full re-read of the mailbox.
      const memoized = await memoRecall(accountId, effectiveMailbox, memoMeta, {
        listCachedUids: db.listCachedUids,
        getEmailHeadersByUids: db.getEmailHeadersByUids,
      });
      if (signal.aborted) return;
      const cachedHeaders = memoized
        ? {
            emails: memoized,
            totalEmails: memoMeta?.totalEmails ?? memoized.length,
            totalCached: memoMeta?.totalCached ?? memoized.length,
            uidValidity: memoMeta?.uidValidity ?? null,
            serverUids: null,
          }
        : await db.getEmailHeadersPartial(accountId, effectiveMailbox, 500);
      if (signal.aborted) return;
      if (memoized) {
        console.log('[activateAccount] Reused %d in-memory headers for %s/%s — no disk walk',
          memoized.length, accountId, effectiveMailbox);
      }
      localTrace.mark('cache-loaded', {
        cachedCount: cachedHeaders?.emails?.length || 0,
        archivedCount: archivedEmailIds.size,
        savedCount: savedEmailIds.size,
      });

      // How much of the mailbox the sidecar cache holds. The progress indicator
      // reads this instead of the store window, which is a view onto the cache
      // and can legitimately shrink.
      useMailStore.setState({
        savedEmailIds,
        archivedEmailIds,
        cachedCount: memoMeta?.totalCached ?? 0,
      });

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

        const cachedTotal = cachedHeaders.totalEmails || cachedHeaders.emails.length;
        const cachedHasMore = cachedHeaders.emails.length < cachedTotal;
        commitToStore(uidMap, signal, accountId, useMailStoreRef, {
          loading: false,
          // Deliberately does NOT touch `loadingMore`. This is the first paint,
          // not pagination — and it raced `loadServerEmails`, whose `finally`
          // clears the flag on every exit. Since the sync probe made the server
          // half return in ~100ms, it finished FIRST and the disk half's `true`
          // became the permanent value, so `loadMoreEmails` (which returns early
          // on `loadingMore`) never ran again: the list stuck at 500 of 9,065
          // with nothing loading. Only loadMoreEmails owns this flag now.
          totalEmails: cachedTotal,
          hasMoreEmails: cachedHasMore,
          currentPage: Math.ceil(cachedHeaders.emails.length / 200) || 1,
          // The header cache stores a uid list but never records whether it
          // was a complete enumeration, so a restore from it can only ever be
          // incomplete. Claiming otherwise is what let a cache-derived set
          // masquerade as proof of server absence.
          ...(cachedHeaders.serverUids
            ? { serverUids: serverUids(cachedHeaders.serverUids, { complete: false }) }
            : {}),
        });
        localTrace.mark('first-paint', { emailCount: cachedHeaders.emails.length });

        // Persist a restore descriptor for this mailbox NOW — previously this
        // only happened on switch-away, so the first visit to any non-INBOX
        // folder (e.g. Spam/Junk) stayed on the slow path until the user
        // navigated away and back. Saving here makes subsequent visits
        // instant, matching INBOX behavior.
        if (!isBackgroundRefresh && !signal.aborted) {
          try {
            _saveRestore(_buildRestoreDescriptor(get(), resolvedMailbox));
          } catch (e) {
            console.warn('[activateAccount] Failed to save early restore descriptor:', e);
          }
        }

        if (resolvedMailbox === 'INBOX') {
          const unread = cachedHeaders.emails.filter(e => !e.flags?.includes('\\Seen')).length;
          useSettingsStore.getState().setUnreadForAccount(accountId, unread);
        }
      } else if (savedEmailIds.size > 0 && !isBackgroundRefresh) {
        // Expected recovery, not an anomaly: the sync that follows repopulates
        // the cache. No suspectEmptyServerData here — the disk walk can finish
        // after the server half's clear, leaving the banner stuck all session.
        console.warn(
          '[activateAccount] Cache empty but Maildir has %d saved emails for %s/%s — rebuilding silently',
          savedEmailIds.size, accountId, effectiveMailbox
        );
        useMailStore.setState({ loading: true });
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

          // Ask the cheap question first: has anything actually changed since
          // the cache was written? One SELECT beats `sync.now` plus a blocking
          // 30s `sync.wait`, and switching between accounts hits this path on
          // every single switch. Anything but a clean "unchanged" syncs.
          const probe = await mailboxIsUnchanged(account, accountId, effectiveMailbox);
          // probe.unchanged answers "has the server moved since the cache was
          // written" — a different question from "do we have a complete
          // enumeration". A descriptor-restore paint (this file, the
          // NO_SERVER_UIDS sites) legitimately empties the uid set on every
          // switch back to a mailbox, and this probe alone can never
          // recover it: an unchanged verdict says nothing was missed, not
          // that anything was ever found. Short-circuiting on probe.unchanged
          // regardless of completeness is what let a reset survive forever
          // — completeness can only go false->true through an actual sync
          // (below), so skip the shortcut and fall through to one whenever
          // completeness is still unproven. Once a sync re-establishes it,
          // subsequent unchanged checks (including probed-recently) take the
          // shortcut again — this only costs a sync once per reset, not once
          // per check.
          if (probe.unchanged && get().serverUids.complete) {
            console.log('[activateAccount] %s/%s unchanged (%s) — skipping sync',
              accountId, effectiveMailbox, probe.reason);
            markVerified(accountId, effectiveMailbox);
            if (!signal.aborted) {
              useMailStore.setState(serverVerifiedPatch());
              // "Unchanged" is about the cache, not about what we are showing.
              await _resumeDrainIfWindowShort(accountId, effectiveMailbox, signal, useMailStoreRef, get);
            }
            serverTrace.end('probe-unchanged', { reason: probe.reason });
            return;
          }
          if (probe.unchanged) {
            console.log('[activateAccount] %s/%s unchanged but completeness is unproven — syncing to (re-)prove it',
              accountId, effectiveMailbox);
          }
          console.log('[activateAccount] %s/%s needs sync (%s)',
            accountId, effectiveMailbox, probe.reason);

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
            markVerified(accountId, effectiveMailbox);
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

              // Drop rows the daemon pruned as expunged. merge() alone can't do
              // this — it never removes. Only prune within the UID range this
              // read actually covers: below its lowest UID we have no evidence,
              // and the read is capped at 500 while uidMap may hold far more.
              const freshUids = new Set(freshCache.emails.map(e => e.uid));
              const lowestFresh = freshCache.emails.reduce((min, e) => Math.min(min, e.uid), Infinity);
              let pruned = 0;
              for (const email of uidMap.toSortedArray()) {
                if (email.uid >= lowestFresh && !freshUids.has(email.uid)) {
                  uidMap.delete(email.uid);
                  pruned++;
                }
              }
              if (pruned > 0) console.log('[activateAccount] Dropped %d expunged rows after daemon sync', pruned);

              uidMap.merge(headersWithSource);
              if (freshCache.uidValidity != null) uidMap.checkUidValidity(freshCache.uidValidity);

              // The daemon just did a real IMAP sync and this is a re-read of
              // what it wrote — live truth, not a stale disk placeholder.
              // freshUids IS the whole mailbox exactly when this read (capped
              // at 500) already reaches totalEmails; when it does, lowestFresh
              // is the mailbox's true lowest UID, so the prune loop above
              // already reconciled every uidMap entry against freshUids — no
              // window left unaccounted for. No extra round trip: both counts
              // came from the read this branch already did.
              const daemonSyncComplete = freshCache.emails.length >= (freshCache.totalEmails || freshCache.emails.length);

              commitToStore(uidMap, signal, accountId, useMailStoreRef, serverVerifiedPatch({
                totalEmails: freshCache.totalEmails || freshCache.emails.length,
                cachedCount: freshCache.totalCached ?? freshCache.emails.length,
                hasMoreEmails: !daemonSyncComplete,
                currentPage: Math.ceil(freshCache.emails.length / 200) || 1,
                // freshCache.serverUids is a disk-cached field from some
                // earlier full search — nothing on disk records whether it was
                // complete, so it can never be claimed as proof of absence.
                // When this read already proved the mailbox, freshUids IS the
                // whole mailbox and is the better value; the wider cached set
                // is only worth keeping while completeness is unproven anyway.
                serverUids: freshCache.serverUids && !daemonSyncComplete
                  ? serverUids(freshCache.serverUids, { complete: false })
                  : serverUids(freshUids, { complete: daemonSyncComplete }),
              }));

              // Save an in-memory restore descriptor for this mailbox so the
              // next activation restores instantly. Without this, first-time
              // visits to non-INBOX folders (Spam, Junk, custom folders)
              // stayed on the slow path even after the server populated.
              if (!signal.aborted) {
                try {
                  _saveRestore(_buildRestoreDescriptor(get(), effectiveMailbox));
                } catch (e) {
                  console.warn('[activateAccount] Failed to save restore descriptor after server sync:', e);
                }
              }

              // No saveEmailHeaders here — uidMap holds exactly what the daemon
              // just wrote to the sidecar cache, so re-persisting it is pure
              // write amplification.
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
      // UIDs the delta-sync found gone server-side — the only thing allowed to
      // delete sidecars, since the store is a window onto a larger cache.
      let prunedUids = [];
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
          await db.clearMailboxCache(accountId, effectiveMailbox);
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
          useMailStore.setState(serverVerifiedPatch({ totalEmails: serverTotal }));
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
          useMailStore.setState(serverVerifiedPatch({ totalEmails: serverTotal }));
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

          const serverUidList = await api.searchAllUids(account, effectiveMailbox);
          if (signal.aborted) return;
          const foundUids = new Set(serverUidList);
          useMailStore.setState({ serverUids: serverUids(foundUids, { complete: true }) });

          const existingEmails = uidMap.toSortedArray();
          const storeUidSet = new Set(existingEmails.map(e => e.uid));
          const newUids = cachedUidNext
            ? serverUidList.filter(uid => uid >= cachedUidNext)
            : serverUidList.filter(uid => !storeUidSet.has(uid));

          for (const email of existingEmails) {
            if (!foundUids.has(email.uid)) {
              uidMap.delete(email.uid);
              prunedUids.push(email.uid);
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

      const existingServerUidSet = get().serverUids.uids;
      const sorted = uidMap.toSortedArray();
      const mergedServerUidSet = existingServerUidSet.size > 0
        ? new Set([...existingServerUidSet, ...sorted.map(e => e.uid)])
        : new Set(sorted.map(e => e.uid));

      // True exactly when a page-1 fetch (the UIDVALIDITY-changed or
      // no-cached-sync branch above — serverEmails stays null on the
      // delta-sync path, which already proved this at searchAllUids above)
      // is provably the whole mailbox: sorted matching serverEmails 1:1
      // rules out an earlier local-cache paint (loadLocalEmails' own
      // uidMap.merge) having left unverified rows in the map, and reaching
      // serverTotal means nothing was left on later pages. No extra round
      // trip — both numbers already came out of this fetch.
      const coldFetchProvedComplete = serverEmails != null
        && sorted.length === serverEmails.length
        && serverEmails.length >= serverTotal;

      setLoadEmailsRetried(false);
      commitToStore(uidMap, signal, accountId, useMailStoreRef, serverVerifiedPatch({
        totalEmails: serverTotal,
        hasMoreEmails: sorted.length < serverTotal,
        currentPage: Math.ceil(sorted.length / 200) || 1,
        // A cold page-1 fetch can prove completeness; the delta-sync path
        // already proved it at searchAllUids above, so carry that forward
        // rather than overwriting it with a merge that proves nothing.
        serverUids: serverUids(mergedServerUidSet, {
          complete: serverEmails != null ? coldFetchProvedComplete : get().serverUids.complete,
        }),
      }));
      serverTrace.mark('server-merged', { count: sorted.length, serverTotal });

      // Descriptor saved on switch-away, not during load

      db.saveEmailHeaders(accountId, effectiveMailbox, sorted, serverTotal, {
        uidValidity: newUidValidity,
        uidNext: newUidNext,
        highestModseq: newHighestModseq ?? null,
        serverUids: get().serverUids.uids,
        removedUids: prunedUids,
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

  // Post-sync: if this account's IMAP host recently changed, check whether the
  // new server is near-empty vs. our local Maildir and offer to restore.
  // Fire-and-forget — must never block or break activation. Skip background
  // refreshes (the foreground pass already covers it) and re-resolve the
  // account from the store so previousImapHost (stamped at saveAccount) is
  // present even if the closure's copy predates the host change.
  if (!isBackgroundRefresh && !signal.aborted && get().activeAccountId === accountId) {
    const detectAccount = get().accounts.find(a => a.id === accountId) || account;
    Promise.resolve().then(() => checkRestoreNeeded(detectAccount)).catch(() => {});
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


// ── setActiveAccount workflow ──

export async function setActiveAccount(accountId) {
  const { useMailStore } = await import('../../stores/mailStore');
  const lastMailbox = useSettingsStore.getState().getLastMailbox(accountId);
  await useMailStore.getState().activateAccount(accountId, lastMailbox || 'INBOX');
}


// ── Expose _unifiedFolderCache for loadUnifiedInbox workflow ──
export { _unifiedFolderCache, fetchAccountMailboxes, shouldUseFreshMailboxCache, isSuspiciousEmptyMailboxResult, MAILBOX_PREFETCH_LIMIT };
