// ── messageListSlice — email list, sorting, pagination, loading ──

import * as db from '../../services/db';
import * as api from '../../services/api';
import { useSettingsStore } from '../settingsStore';
import { ensureFreshToken, hasValidCredentials, resolveServerAccount } from '../../services/authUtils';
import { isGraphAccount, normalizeGraphFolderName, graphFoldersToMailboxes, graphMessageToEmail } from '../../services/graphConfig';
import { saveRestoreDescriptor as _saveRestore, setGraphIdMap as _setGraphIdMap, getGraphMessageId, restoreGraphIdMap as _restoreGraphIdMap } from '../../services/cacheManager';
import { _buildRestoreDescriptor } from './unifiedHelpers';
import { createPerfTrace } from '../../utils/perfTrace';

// Module-level flag change counter — used in updateSortedEmails fingerprint
let _flagChangeCounter = 0;

// Module-level cache for getChatEmails() — avoids calling set() during render
let _chatEmailsCache = [];
let _chatEmailsFingerprint = '';

// Module-level cache for getThreads() — avoids rebuilding threads on every call
let _threadsCache = new Map();
let _threadsFingerprint = '';

// Module-level loadMore dedup timer
let _loadMoreTimer = null;

// Module-level loadEmails generation counter — prevents stale concurrent calls
let _loadEmailsGeneration = 0;
// Module-level retry flag — prevents infinite retry loops on persistent errors
let _loadEmailsRetried = false;

// ── AbortController for progressive loading — cancels background loading on switch ──
let _loadAbortController = null;

// Module-level range retry state — avoids polluting Zustand store with dynamic keys
const _rangeRetryDelays = new Map();

// ── Network retry scheduler ────────────────────────────────────────
// Retry sequence: immediate -> 3s -> 6s -> 12s -> 30s -> 60s -> wait for 'online'
const _RETRY_DELAYS_MS = [0, 3000, 6000, 12000, 30000, 60000];
let _networkRetryTimer = null;
let _networkRetryStep = 0;

// Expose for accountSlice and facade event listeners
export function _scheduleNetworkRetry(useMailStoreRef) {
  if (_networkRetryTimer) clearTimeout(_networkRetryTimer);
  const delay = _RETRY_DELAYS_MS[Math.min(_networkRetryStep, _RETRY_DELAYS_MS.length - 1)];
  _networkRetryStep++;
  console.log('[mailStore] Retry scheduled in %dms (step %d)', delay, _networkRetryStep);
  _networkRetryTimer = setTimeout(() => {
    _networkRetryTimer = null;
    const { activeAccountId, activeMailbox, activateAccount } = useMailStoreRef.getState();
    if (activeAccountId) activateAccount(activeAccountId, activeMailbox || 'INBOX');
  }, delay);
}

export function _resetNetworkRetry() {
  if (_networkRetryTimer) clearTimeout(_networkRetryTimer);
  _networkRetryTimer = null;
  _networkRetryStep = 0;
}

// Expose for accountSlice
export function getLoadAbortController() { return _loadAbortController; }
export function setLoadAbortController(ctrl) { _loadAbortController = ctrl; }
export function getLoadMoreTimer() { return _loadMoreTimer; }
export function setLoadMoreTimer(timer) { _loadMoreTimer = timer; }
export function getLoadEmailsGeneration() { return _loadEmailsGeneration; }
export function bumpLoadEmailsGeneration() { return ++_loadEmailsGeneration; }
export function getLoadEmailsRetried() { return _loadEmailsRetried; }
export function setLoadEmailsRetried(v) { _loadEmailsRetried = v; }
export function bumpFlagChangeCounter() { _flagChangeCounter++; }
export function invalidateChatAndThreadCaches() {
  _chatEmailsFingerprint = '';
  _threadsFingerprint = '';
}

// Suspicious empty result detection helpers
function isSuspiciousEmptyEmailResult(serverTotal, cachedHeaders, savedEmailIds) {
  if (serverTotal > 0) return false;
  const cachedTotal = cachedHeaders?.totalEmails || cachedHeaders?.lastKnownGoodTotalEmails || 0;
  const savedCount = savedEmailIds?.size || 0;
  return cachedTotal > 0 || savedCount > 0;
}

import { buildThreads } from '../../utils/emailParser';

export const createMessageListSlice = (set, get) => ({
  // Emails
  emails: [],
  localEmails: [],
  savedEmailIds: new Set(),
  archivedEmailIds: new Set(),
  serverUidSet: new Set(), // Full set of UIDs known to exist on the IMAP server

  // Pre-sorted emails for performance (memoization)
  sortedEmails: [],

  // Sent folder headers for chat view (merged with INBOX for conversations)
  sentEmails: [],

  // Pagination
  currentPage: 1,
  hasMoreEmails: true,
  totalEmails: 0,

  // Track which ranges have been loaded
  loadedRanges: [], // Array of {start, end} objects
  // Loading state for specific ranges
  loadingRanges: new Set(), // Set of "start-end" strings

  // Update sorted emails (memoization for performance)
  updateSortedEmails: () => {
    const { emails, localEmails, viewMode, savedEmailIds, archivedEmailIds, serverUidSet, unifiedInbox, activeAccountId, activeMailbox, _sortedEmailsFingerprint } = get();

    // Fingerprint check: skip if the input set hasn't materially changed
    const fp = `${activeAccountId}-${activeMailbox}-${viewMode}-${emails.length}-${emails[0]?.uid || 0}-${emails[emails.length - 1]?.uid || 0}-${localEmails.length}-${archivedEmailIds.size}-${savedEmailIds.size}-${serverUidSet.size}-${_flagChangeCounter}`;
    if (fp === _sortedEmailsFingerprint) return;

    // In unified inbox, UIDs collide across accounts — use compound key for dedup
    const uidKey = unifiedInbox
      ? (e) => `${e._accountId || ''}:${e.uid}`
      : (e) => e.uid;

    let result = [];

    if (viewMode === 'server') {
      // Server mode: show only IMAP emails, all as 'server' source.
      // Decorate in-place instead of cloning — these fields are transient view state.
      for (const e of emails) {
        e.isLocal = false;
        e.isArchived = false;
        e.source = 'server';
      }
      result = emails;
    } else if (viewMode === 'local') {
      // Local mode: show only archived emails from disk.
      // Use serverUidSet (full IMAP UID set) to distinguish local vs local-only.
      result = [];
      for (const e of localEmails) {
        if (archivedEmailIds.has(e.uid)) {
          e.isLocal = true;
          e.isArchived = true;
          e.source = serverUidSet.has(e.uid) ? 'local' : 'local-only';
          result.push(e);
        }
      }
    } else {
      // viewMode === 'all': server emails + archived local-only emails.
      // Decorate in-place instead of cloning to avoid duplicating the entire array.
      const loadedKeys = new Set(emails.map(e => uidKey(e)));
      for (const e of emails) {
        e.isLocal = savedEmailIds.has(e.uid);
        e.isArchived = archivedEmailIds.has(e.uid);
        e.source = 'server';
      }
      result = [...emails]; // shallow copy for concat, but objects are shared

      // Add archived local emails not yet loaded as headers.
      // Use serverUidSet to distinguish: on server but not loaded yet ('local') vs truly local-only.
      for (const localEmail of localEmails) {
        if (!loadedKeys.has(uidKey(localEmail)) && archivedEmailIds.has(localEmail.uid)) {
          localEmail.isLocal = true;
          localEmail.isArchived = true;
          localEmail.source = serverUidSet.has(localEmail.uid) ? 'local' : 'local-only';
          result.push(localEmail);
        }
      }
    }

    // Sort by date descending (newest first) - pre-parse dates for performance
    for (const e of result) {
      e._ts = new Date(e.date || e.internalDate || 0).getTime();
    }
    result.sort((a, b) => b._ts - a._ts);

    // Apply persisted link safety alerts from settingsStore
    const { linkAlerts, linkSafetyEnabled } = useSettingsStore.getState();
    if (linkAlerts && Object.keys(linkAlerts).length > 0) {
      for (const e of result) {
        if (!e._linkAlert && linkAlerts[e.uid]) {
          e._linkAlert = linkAlerts[e.uid];
        }
      }
    }

    // Detect sender impersonation (display name looks like different email/domain)
    if (linkSafetyEnabled) {
      for (const e of result) {
        if (e._senderAlert !== undefined) continue;
        const name = (e.from?.name || '').replace(/^["\\]+|["\\]+$/g, '').replace(/\\"/g, '"').trim();
        const addr = (e.from?.address || '').toLowerCase();
        if (!name || !addr) continue;
        const nameLower = name.toLowerCase();
        // Display name is an email that doesn't match actual sender
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name) && nameLower !== addr) {
          // Check if domains are related (subdomain match)
          const nameDomain = nameLower.split('@')[1] || '';
          const addrDomain = addr.split('@')[1] || '';
          if (nameDomain !== addrDomain && !addrDomain.endsWith('.' + nameDomain) && !nameDomain.endsWith('.' + addrDomain)) {
            e._senderAlert = 'red';
          }
        }
        // Display name is a domain that doesn't match sender domain
        else if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(nameLower)) {
          const senderDomain = addr.split('@')[1] || '';
          // Allow subdomain matches (e.g., name "snapcraft.io" from "forum.snapcraft.io")
          if (nameLower !== senderDomain && !senderDomain.endsWith('.' + nameLower) && !nameLower.endsWith('.' + senderDomain)) {
            e._senderAlert = 'yellow';
          }
        }
      }
    }

    _chatEmailsFingerprint = ''; // Invalidate module-level chat cache
    _threadsFingerprint = ''; // Invalidate module-level threads cache
    set({ sortedEmails: result, _sortedEmailsFingerprint: fp });
  },

  // Load emails
  loadEmails: async () => {
    const { activeAccountId, accounts, activeMailbox } = get();
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;

    // Early bail if credentials are missing — don't even start loading
    if (!hasValidCredentials(account)) {
      set({
        loading: false,
        loadingMore: false,
        connectionStatus: 'error',
        connectionError: 'Password not found. Please re-enter your password in Settings.',
        connectionErrorType: 'passwordMissing',
      });
      return;
    }

    const loadTrace = createPerfTrace('loadEmails', { accountId: activeAccountId, mailbox: activeMailbox });

    // Clear any pending network retry timer
    _resetNetworkRetry();

    // Abort any previous progressive loading
    if (_loadAbortController) _loadAbortController.abort();
    _loadAbortController = new AbortController();
    const loadSignal = _loadAbortController.signal;

    // Bump generation — any previous in-flight loadEmails call becomes stale
    const generation = ++_loadEmailsGeneration;

    // Helper: check if this loadEmails call is still current
    const isStale = () => get().activeAccountId !== activeAccountId || _loadEmailsGeneration !== generation;

    // Safety: clear stuck loading state after 20s — covers the ENTIRE function,
    // including credential checks, network checks, and IMAP operations.
    const loadingGuard = setTimeout(() => {
      if (get().activeAccountId === activeAccountId && get().loading) {
        console.warn('[loadEmails] Loading timeout — clearing stuck loading state after 20s');
        // Show error so user knows something went wrong (not just empty folder)
        const hasEmails = get().emails.length > 0;
        set({
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
    // Proactively refresh OAuth2 token if expiring soon
    account = await ensureFreshToken(account);
    if (isStale()) return;
    loadTrace.mark('token-ready', { email: account.email });

    // ── Graph API path ────────────────────────────────────────────────────
    if (isGraphAccount(account)) {
      return await get()._loadEmailsViaGraph(account, activeAccountId, activeMailbox, generation);
    }

    const invoke = window.__TAURI__?.core?.invoke;

    // CONDSTORE fast-path: if store already has savedEmailIds (restored from descriptor or prior load), skip disk reads
    const storeHasIds = get().savedEmailIds.size > 0;
    const cacheIsFresh = storeHasIds && get().emails.length > 0;

    let savedEmailIds, archivedEmailIds, cachedHeaders;
    if (cacheIsFresh && storeHasIds) {
      // Use existing store values (restored from account cache) — skip disk I/O
      savedEmailIds = get().savedEmailIds;
      archivedEmailIds = get().archivedEmailIds;
      cachedHeaders = await db.getEmailHeadersMeta(activeAccountId, activeMailbox);
    } else {
      // Full disk read
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
    set({ savedEmailIds, archivedEmailIds });

    // Fire-and-forget: load archived email headers from disk in background.
    // IMPORTANT: localEmails is managed ONLY by this fire-and-forget chain — never overwritten
    // by IMAP sync set() calls. This ensures archived emails persist once loaded.
    if (archivedEmailIds.size > 0 && (get().localEmails || []).length === 0) {
      const archivedAccount = activeAccountId;
      (async () => {
        try {
          // Try local-index.json first (fast, no MIME parsing)
          let localEmails = await db.readLocalEmailIndex(activeAccountId, activeMailbox);
          if (!localEmails) {
            // Fallback: .eml scanning via batched reader
            localEmails = await db.getArchivedEmails(activeAccountId, activeMailbox, archivedEmailIds);
          }
          if (get().activeAccountId !== archivedAccount || loadSignal.aborted) return;
          set({ localEmails });
          get().updateSortedEmails();
        } catch (e) {
          console.warn('[loadEmails] archived emails failed:', e);
        }
      })();
    }

    // Use existing emails from store (populated by QuickLoad or activateAccount)
    const existingStoreEmails = get().emails;
    const hasExistingEmails = existingStoreEmails.length > 0;
    console.log('[loadEmails] Decision point: hasExistingEmails=%s (%d), cachedHeaders.totalCached=%s, loading=%s',
      hasExistingEmails, existingStoreEmails.length, cachedHeaders?.totalCached ?? 'null', get().loading);

    if (hasExistingEmails) {
      // QuickLoad or activateAccount already populated emails — just update local state
      // NOTE: Do NOT set localEmails here — the fire-and-forget chain manages it independently
      set({
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
      // No emails in store but cache exists — load partial (200 most recent) for fast display
      console.log('[loadEmails] Store empty, loading 200 from cache (total cached: %d)', cachedHeaders.totalCached);
      const partialHeaders = await db.getEmailHeadersPartial(activeAccountId, activeMailbox, 500);
      if (isStale()) return;

      if (partialHeaders && partialHeaders.emails.length > 0) {
        set({
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
      // No cache - reset state to empty. Local emails are shown via updateSortedEmails
      // in 'all' mode (the default) — they don't belong in the `emails` array.
      console.log('[loadEmails] No cached headers, starting fresh');
      set({
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

    // Keep previous/cached emails for degraded modes (password missing, offline)
    const previousEmails = get().emails;

    // Resolve credentialed account (store -> keychain -> token refresh)
    const resolved = await resolveServerAccount(activeAccountId, account);
    if (!resolved.ok) {
      console.error('[loadEmails] Credentials missing for account:', account.email);
      if (!isStale()) set({
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

    // Check network connectivity (if Tauri available)

    if (invoke) {
      try {
        const isOnline = await invoke('check_network_connectivity');
        if (isStale()) return;
        console.log('[loadEmails] Network connectivity result:', isOnline);
        if (isOnline === false) {
          console.error('[loadEmails] No network connectivity detected!');
          if (!isStale()) set({
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
        set({
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
        set({
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
      // ── Delta-sync: check mailbox status before fetching ──────────────
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

      if (hasCachedSync) {
        // We have uidValidity/uidNext from last sync — try delta-sync
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
          // UIDVALIDITY changed — cache is invalid, full reload required
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
          // CONDSTORE fast path: if highestModseq matches and uidNext matches, NOTHING changed
          // Also verify exists count matches — if server has fewer emails, deletions happened
          newHighestModseq != null && cachedHighestModseq != null &&
          newHighestModseq === cachedHighestModseq &&
          newUidNext === cachedUidNext &&
          status.exists >= existingEmails.length * 0.5 // Guard: if >50% gone, need UID sync
        ) {
          _loadEmailsRetried = false;
          set({
            connectionStatus: 'connected',
            connectionError: null,
            connectionErrorType: null,
            loadingMore: false
          });
          get().updateSortedEmails();
          set({ loading: false, loadingMore: false });
          loadTrace.end('condstore-noop', {
            existingCount: existingEmails.length,
            serverTotal,
          });
          // If store is partial, load remaining from disk cache then IMAP
          if (existingEmails.length < serverTotal) {
            console.log('[loadEmails] CONDSTORE: store partial (%d/%d), loading remaining from cache...', existingEmails.length, serverTotal);
            set({ hasMoreEmails: true, totalEmails: serverTotal });
            if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
            _loadMoreTimer = setTimeout(() => { _loadMoreTimer = null; get().loadMoreEmails(); }, 200);
          }
          return;
        } else if (
          // CONDSTORE flag-only sync: uidNext same but modseq changed -> only flags changed
          // BUT: if server exists count differs significantly from cache, emails were deleted
          // and we need a full UID sync, not just flag updates
          newHighestModseq != null && cachedHighestModseq != null &&
          newHighestModseq !== cachedHighestModseq &&
          newUidNext === cachedUidNext &&
          status.exists >= existingEmails.length * 0.5 // If more than 50% gone, skip to UID sync
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
              // No actual changes found — keep cache
              set({
                connectionStatus: 'connected',
                connectionError: null,
                connectionErrorType: null,
                loadingMore: false
              });
              get().updateSortedEmails();
              set({ loading: false, loadingMore: false });
              loadTrace.end('condstore-flags-only', {
                changedFlags: changes.length,
                serverTotal,
              });
              // If store is partial, load remaining from disk cache then IMAP
              if (existingEmails.length < serverTotal) {
                console.log('[loadEmails] CONDSTORE flag-sync: store partial (%d/%d), scheduling loadMoreEmails', existingEmails.length, serverTotal);
                set({ hasMoreEmails: true, totalEmails: serverTotal });
                if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
                _loadMoreTimer = setTimeout(() => { _loadMoreTimer = null; get().loadMoreEmails(); }, 200);
              }
              return;
            }
          } catch (e) {
            console.warn('[loadEmails] CONDSTORE flag sync failed, falling back to UID search:', e);
            // Fall through to UID search below
            mergedEmails = null;
          }
        } else if (newUidNext === cachedUidNext && serverTotal === (cachedHeaders?.totalCached ?? existingEmails.length)) {
          // Nothing changed (non-CONDSTORE path) — skip all IMAP fetching
          // Exact match required — a decrease means deletions happened, needs UID sync
          set({
            connectionStatus: 'connected',
            connectionError: null,
            connectionErrorType: null,
            loadingMore: false,
            totalEmails: serverTotal
          });
          get().updateSortedEmails();
          set({ loading: false, loadingMore: false });
          loadTrace.end('delta-noop', {
            existingCount: existingEmails.length,
            serverTotal,
          });
          // If store only has partial data (QuickLoad), schedule loadMoreEmails to paginate from IMAP
          if (existingEmails.length < serverTotal) {
            console.log('[loadEmails] Delta-sync: store partial (%d/%d), scheduling loadMoreEmails', existingEmails.length, serverTotal);
            set({ hasMoreEmails: true });
            if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
            _loadMoreTimer = setTimeout(() => { _loadMoreTimer = null; get().loadMoreEmails(); }, 200);
          }
          return;
        }

        // UID search delta-sync: something changed that wasn't handled above
        if (mergedEmails == null && newUidValidity === cachedUidValidity) {
          const serverUids = await api.searchAllUids(account, activeMailbox);
          const serverUidSet = new Set(serverUids);
          set({ serverUidSet }); // Persist full server UID set for view mode classification
          const storeUidSet = new Set(existingEmails.map(e => e.uid));

          // Find truly new UIDs — only those above cachedUidNext (not just missing from partial store).
          // Without this, a store with 200 emails from QuickLoad would think 16k+ UIDs are "new".
          const newUids = cachedUidNext
            ? serverUids.filter(uid => uid >= cachedUidNext)
            : serverUids.filter(uid => !storeUidSet.has(uid));
          // Find deleted UIDs (only check against what's in the store)
          const deletedUids = existingEmails.filter(e => !serverUidSet.has(e.uid)).map(e => e.uid);

          // Start with existing emails, remove deleted ones
          let updatedEmails = existingEmails;
          if (deletedUids.length > 0) {
            const deletedSet = new Set(deletedUids);
            updatedEmails = updatedEmails.filter(e => !deletedSet.has(e.uid));
          }

          // Fetch headers for new UIDs only (sorted descending for newest-first)
          if (newUids.length > 0) {
            const sortedNewUids = [...newUids].sort((a, b) => b - a);
            const { emails: newHeaders } = await api.fetchHeadersByUids(account, activeMailbox, sortedNewUids);
            const newEmailsWithMeta = newHeaders.map(email => ({
              ...email,
              isLocal: savedEmailIds.has(email.uid),
              source: 'server'
            }));
            // New emails go at the top (they have higher UIDs = newer)
            updatedEmails = [...newEmailsWithMeta, ...updatedEmails];
          }

          // Re-index
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

        // Get fresh status for uidValidity/uidNext/highestModseq to cache for next time
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

        // Stale UID cleanup
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

      // ── Suspicious empty guard ──────────────────────────────────────
      // If server returned 0 emails but prior cache/Maildir had data, reject the result
      if (isSuspiciousEmptyEmailResult(serverTotal, cachedHeaders, savedEmailIds) && (!mergedEmails || mergedEmails.length === 0)) {
        console.warn(
          '[loadEmails] Server returned 0 emails for %s/%s but prior cache had %d, Maildir has %d — rejecting as suspicious',
          account.email, activeMailbox,
          cachedHeaders?.totalEmails || cachedHeaders?.lastKnownGoodTotalEmails || 0,
          savedEmailIds?.size || 0
        );
        set({
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

      // Clear suspect state — we passed the suspicious-empty guard above,
      // so the server result is legitimate (even if legitimately empty).
      const currentSuspect = get().suspectEmptyServerData;
      if (currentSuspect?.accountId === activeAccountId && currentSuspect?.type === 'emails') {
        set({ suspectEmptyServerData: null });
      }

      const currentPage = Math.ceil(mergedEmails.length / 200) || 1;
      const hasMoreEmails = mergedEmails.length < serverTotal;

      // Guard: account may have changed during async IMAP operations
      if (isStale()) {
        console.log('[loadEmails] Account changed during fetch, discarding results for', activeAccountId);
        return;
      }

      // Merge loaded UIDs into serverUidSet (partial page adds to existing set from delta-sync)
      const existingServerUidSet = get().serverUidSet;
      const mergedServerUidSet = existingServerUidSet.size > 0
        ? new Set([...existingServerUidSet, ...mergedEmails.map(e => e.uid)])
        : new Set(mergedEmails.map(e => e.uid));

      _loadEmailsRetried = false; // Reset retry flag on success
      set({
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

      // Update per-account unread count for INBOX
      if (activeMailbox === 'INBOX') {
        const unread = get().emails.filter(e => !e.flags?.includes('\\Seen')).length;
        useSettingsStore.getState().setUnreadForAccount(activeAccountId, unread);
      }

      // Save to account cache for instant restore on switch-back (skip in unified inbox mode)
      if (!get().unifiedInbox) {
        _saveRestore(_buildRestoreDescriptor(get()));
      }

      // Save merged headers with uidValidity/uidNext/highestModseq for next delta-sync
      db.saveEmailHeaders(activeAccountId, activeMailbox, mergedEmails, serverTotal, {
        uidValidity: newUidValidity,
        uidNext: newUidNext,
        highestModseq: newHighestModseq ?? null,
        serverUids: get().serverUidSet
      }).catch(e => console.warn('[loadEmails] Failed to cache headers:', e));

      // Continue loading more if we don't have all emails yet
      if (hasMoreEmails) {
        if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
        _loadMoreTimer = setTimeout(() => { _loadMoreTimer = null; get().loadMoreEmails(); }, 200);
      }
    } catch (error) {
      console.error('[loadEmails] Failed to load emails:', error);

      // Determine error type
      let errorType = 'serverError';
      let errorMessage = error.message;

      if (error.message?.includes('authenticated but not connected') || error.message?.includes('Command Error. 12')) {
        errorType = 'outlookOAuth';
        errorMessage = 'Microsoft IMAP connection failed. This is a known Microsoft server issue affecting personal Outlook.com accounts with OAuth2. See FAQ for details.';
      } else if (error.message?.includes('XOAUTH2 auth failed')) {
        errorType = 'oauthExpired';
        const { isPersonalMicrosoftEmail: isPersonalMs } = await import('../../services/graphConfig');
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

      // Keep previous/cached server emails on error - don't wipe out the cache!
      // Local emails are merged via updateSortedEmails in 'all' mode — don't mix into `emails`.
      if (!isStale()) {
        set({
          emails: previousEmails ?? get().emails,
          connectionStatus: 'error',
          connectionError: errorMessage,
          connectionErrorType: errorType
        });
        get().updateSortedEmails();

        // Schedule progressive retry for transient network errors
        const noRetry = errorType === 'passwordMissing' || errorType === 'oauthExpired' || errorType === 'outlookOAuth';
        if (!noRetry) {
          // Use the store reference from get() — _scheduleNetworkRetry needs useMailStore
          _scheduleNetworkRetry({ getState: get });
        }
      }
      loadTrace.end('error', { message: error.message });
    } finally {
      clearTimeout(loadingGuard);
      if (!isStale()) set({ loading: false, loadingMore: false, loadingProgress: null });
    }
  },

  // ── Graph API email loading ──────────────────────────────────────────────
  _loadEmailsViaGraph: async (account, activeAccountId, activeMailbox, generation) => {
    const isStale = () => get().activeAccountId !== activeAccountId || _loadEmailsGeneration !== generation;

    // Restore persisted Graph ID map from disk (no-op if already in memory)
    await _restoreGraphIdMap(activeAccountId, activeMailbox);
    if (isStale()) return;

    // Load local state (saved/archived IDs)
    const [savedEmailIds, archivedEmailIds] = await Promise.all([
      db.getSavedEmailIds(activeAccountId, activeMailbox),
      db.getArchivedEmailIds(activeAccountId, activeMailbox),
    ]);
    if (isStale()) return;
    set({ savedEmailIds, archivedEmailIds });

    // Load archived emails from disk (fire-and-forget, same pattern as IMAP)
    if (archivedEmailIds.size > 0 && (get().localEmails || []).length === 0) {
      const archivedAccount = activeAccountId;
      db.getArchivedEmails(activeAccountId, activeMailbox, archivedEmailIds, (batchEmails) => {
        if (get().activeAccountId !== archivedAccount) return;
        set({ localEmails: batchEmails });
        get().updateSortedEmails();
      }).catch(e => console.warn('[loadEmailsViaGraph] getArchivedEmails failed:', e));
    }

    set({ loading: get().emails.length === 0, loadingMore: true, error: null });

    try {
      // 1. Use cached mailbox list when fresh enough; otherwise refresh from Graph.
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
        set({ mailboxes, mailboxesFetchedAt: Date.now() });
        db.saveMailboxes(activeAccountId, mailboxes);
      } else if (mailboxes.length > 0) {
        set({ mailboxes, mailboxesFetchedAt: cachedMailboxEntry?.fetchedAt ?? null });
      }

      // 2. Find the Graph folder ID for the active mailbox
      const targetFolder = mailboxes.find(m => m.path === activeMailbox);
      if (!targetFolder || !targetFolder._graphFolderId) {
        console.warn('[loadEmailsViaGraph] No matching folder for', activeMailbox);
        set({ loading: false, loadingMore: false, connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
        return;
      }

      // 3. Fetch messages
      const result = await api.graphListMessages(account.oauth2AccessToken, targetFolder._graphFolderId, 200, 0);
      if (isStale()) return;

      const headers = result.headers || [];
      const graphMessageIds = result.graphMessageIds || [];

      // 4. Build UID -> Graph message ID mapping
      const uidToGraphId = new Map();
      headers.forEach((h, i) => {
        uidToGraphId.set(h.uid, graphMessageIds[i]);
      });
      _setGraphIdMap(activeAccountId, activeMailbox, uidToGraphId);

      // 5. Enrich headers with display metadata
      const mergedEmails = headers.map((email, idx) => ({
        ...email,
        displayIndex: idx,
        isLocal: savedEmailIds.has(email.uid),
        source: 'server',
      }));

      const serverTotal = mergedEmails.length; // Graph doesn't give a total independent of results
      const hasMoreEmails = !!result.nextLink;

      set({
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

      // Update per-account unread count for INBOX
      if (activeMailbox === 'INBOX') {
        const unread = get().emails.filter(e => !e.flags?.includes('\\Seen')).length;
        useSettingsStore.getState().setUnreadForAccount(activeAccountId, unread);
      }

      // Save to account cache for instant restore on switch-back (skip in unified inbox mode)
      if (!get().unifiedInbox) {
        _saveRestore(_buildRestoreDescriptor(get()));
      }

      // Cache headers for quick-load on next startup
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
        set({
          connectionStatus: 'error',
          connectionError: errorMessage,
          connectionErrorType: errorType,
        });
        get().updateSortedEmails();
      }
    } finally {
      if (!isStale()) set({ loading: false, loadingMore: false });
    }
  },

  // Load more emails (called internally for background loading)
  // Uses unlimited exponential backoff on failure: 3s, 9s, 18s, 36s, ...
  loadMoreEmails: async () => {
    const { activeAccountId, accounts, activeMailbox, emails, currentPage, hasMoreEmails, loadingMore } = get();
    let account = accounts.find(a => a.id === activeAccountId);

    // Don't load if already loading, no more emails, or no account
    if (!account || loadingMore || !hasMoreEmails) return;

    // Resolve credentialed account — silent fail if missing (pagination is non-critical)
    const resolved = await resolveServerAccount(account.id, account);
    if (!resolved.ok) return;
    account = resolved.account;

    // Don't load if offline — will resume via online event
    if (!navigator.onLine) {
      set({ _loadMorePausedOffline: true });
      return;
    }

    set({ loadingMore: true });

    try {
      const nextPage = currentPage + 1;
      const serverResult = await api.fetchEmails(account, activeMailbox, nextPage);

      // Reset retry delay on success
      set({ _loadMoreRetryDelay: 0 });

      // Detect mailbox mutation: if total changed since we started loading,
      // sequence numbers have shifted — restart pagination from scratch
      const previousTotal = get().totalEmails;
      if (previousTotal > 0 && serverResult.total !== previousTotal) {
        console.warn(`[loadMoreEmails] Mailbox total changed (${previousTotal} -> ${serverResult.total}), restarting pagination`);
        set({ loadingMore: false });
        get().loadEmails();
        return;
      }

      // Use requestIdleCallback to update state when browser is idle
      const updateState = () => {
        // Guard: if user switched mailbox/account while idle, discard stale result
        const current = get();
        if (current.activeAccountId !== activeAccountId || current.activeMailbox !== activeMailbox) {
          set({ loadingMore: false });
          return;
        }

        const newEmails = [...current.emails, ...serverResult.emails];
        // Expand serverUidSet with newly loaded UIDs
        const updatedServerUidSet = new Set(current.serverUidSet);
        for (const e of serverResult.emails) updatedServerUidSet.add(e.uid);
        set({
          emails: newEmails,
          currentPage: nextPage,
          hasMoreEmails: serverResult.hasMore,
          totalEmails: serverResult.total,
          loadingMore: false,
          serverUidSet: updatedServerUidSet
        });

        get().updateSortedEmails();

        // Update account cache with latest state (skip in unified inbox mode)
        if (!get().unifiedInbox) {
          _saveRestore(_buildRestoreDescriptor(get()));
        }

        db.saveEmailHeaders(activeAccountId, activeMailbox, newEmails, serverResult.total)
          .catch(e => console.warn('[loadMoreEmails] Failed to cache headers:', e));

        if (serverResult.skippedUids && serverResult.skippedUids.length > 0) {
          console.warn(`[loadMoreEmails] ${serverResult.skippedUids.length} messages skipped on page ${nextPage}, will re-request`);
          // Re-request same page by not advancing currentPage
          set({ currentPage: nextPage - 1, hasMoreEmails: true });
          if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
          _loadMoreTimer = setTimeout(() => { _loadMoreTimer = null; get().loadMoreEmails(); }, 5000);
        } else if (serverResult.hasMore) {
          if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
          _loadMoreTimer = setTimeout(() => { _loadMoreTimer = null; get().loadMoreEmails(); }, 200);
        }
      };

      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(updateState, { timeout: 2000 });
      } else {
        setTimeout(updateState, 50);
      }
    } catch (error) {
      console.error('[loadMoreEmails] Failed to load more emails:', error);
      set({ loadingMore: false });

      // Unlimited exponential backoff: 3s, 9s, 18s, 36s, 72s, cap at 120s
      if (get().hasMoreEmails && get().emails.length < get().totalEmails) {
        const prevDelay = get()._loadMoreRetryDelay || 0;
        const nextDelay = prevDelay === 0 ? 3000 : Math.min(prevDelay * 2, 120000);
        set({ _loadMoreRetryDelay: nextDelay });
        console.log(`[loadMoreEmails] Will retry in ${nextDelay / 1000}s...`);
        if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
        _loadMoreTimer = setTimeout(() => { _loadMoreTimer = null; get().loadMoreEmails(); }, nextDelay);
      }
    }
  },

  // Load emails by index range (for virtualized scrolling)
  loadEmailRange: async (startIndex, endIndex) => {
    const { activeAccountId, accounts, activeMailbox, loadedRanges, loadingRanges, savedEmailIds } = get();
    let account = accounts.find(a => a.id === activeAccountId);
    account = await ensureFreshToken(account);

    const hasCredentials = account && (account.password || (account.authType === 'oauth2' && account.oauth2AccessToken));
    if (!hasCredentials) return;

    // Check if this range is already loaded
    const isRangeLoaded = (start, end) => {
      for (const range of loadedRanges) {
        if (range.start <= start && range.end >= end) return true;
      }
      return false;
    };

    if (isRangeLoaded(startIndex, endIndex)) return;

    // Check if already loading this range
    const rangeKey = `${startIndex}-${endIndex}`;
    if (loadingRanges.has(rangeKey)) return;

    // Mark as loading
    const newLoadingRanges = new Set(loadingRanges);
    newLoadingRanges.add(rangeKey);
    set({ loadingRanges: newLoadingRanges });

    try {
      const result = await api.fetchEmailsRange(account, activeMailbox, startIndex, endIndex);

      // Detect mailbox mutation — total changed, indices are stale
      const previousTotal = get().totalEmails;
      if (previousTotal > 0 && result.total !== previousTotal) {
        console.warn(`[loadEmailRange] Mailbox total changed (${previousTotal} -> ${result.total}), restarting`);
        const loadingRangesAfter = new Set(get().loadingRanges);
        loadingRangesAfter.delete(rangeKey);
        set({ loadingRanges: loadingRangesAfter });
        get().loadEmails();
        return;
      }

      if (result.emails && result.emails.length > 0) {
        const currentEmails = get().emails;
        const existingUids = new Set(currentEmails.map(e => e.uid));

        // Merge new emails by UID (dedup)
        const newEntries = [];
        for (const email of result.emails) {
          if (!existingUids.has(email.uid)) {
            newEntries.push({ ...email, isLocal: savedEmailIds.has(email.uid), source: 'server' });
          }
        }

        // Dense sorted subset — merge and re-sort by date descending
        const merged = [...currentEmails, ...newEntries];
        for (const e of merged) {
          if (e._ts === undefined) e._ts = new Date(e.date || e.internalDate || 0).getTime();
        }
        merged.sort((a, b) => b._ts - a._ts);

        // Evict far-offscreen entries if list grows too large
        const MAX_LOADED_ENTRIES = 5000;
        let finalEmails = merged;
        if (merged.length > MAX_LOADED_ENTRIES) {
          finalEmails = merged.slice(0, MAX_LOADED_ENTRIES);
        }

        // Merge loaded range with existing ranges
        const newLoadedRanges = [...get().loadedRanges, { start: startIndex, end: endIndex }];
        newLoadedRanges.sort((a, b) => a.start - b.start);
        const mergedRanges = [];
        for (const range of newLoadedRanges) {
          if (mergedRanges.length === 0) {
            mergedRanges.push(range);
          } else {
            const last = mergedRanges[mergedRanges.length - 1];
            if (range.start <= last.end + 1) {
              last.end = Math.max(last.end, range.end);
            } else {
              mergedRanges.push(range);
            }
          }
        }

        const loadingRangesAfter = new Set(get().loadingRanges);
        loadingRangesAfter.delete(rangeKey);
        const rangeServerUidSet = new Set(get().serverUidSet);
        for (const e of result.emails) rangeServerUidSet.add(e.uid);

        set({
          loadedRanges: mergedRanges,
          loadingRanges: loadingRangesAfter,
          emails: finalEmails,
          totalEmails: result.total,
          serverUidSet: rangeServerUidSet
        });

        get().updateSortedEmails();

        // Cache the updated emails
        db.saveEmailHeaders(activeAccountId, activeMailbox, finalEmails, result.total)
          .catch(e => console.warn('[loadEmailRange] Failed to cache headers:', e));

        // If server reported skipped UIDs, schedule a retry for this range
        if (result.skippedUids && result.skippedUids.length > 0) {
          console.warn(`[loadEmailRange] ${result.skippedUids.length} messages skipped, scheduling retry for range ${startIndex}-${endIndex}`);
          setTimeout(() => {
            // Remove the range from loadedRanges so it can be re-fetched
            const currentRanges = get().loadedRanges.filter(r => !(r.start === startIndex && r.end === endIndex));
            set({ loadedRanges: currentRanges });
            get().loadEmailRange(startIndex, endIndex);
          }, 5000);
        }
      }
    } catch (error) {
      console.error('[loadEmailRange] Failed:', error);
      const loadingRangesAfter = new Set(get().loadingRanges);
      loadingRangesAfter.delete(rangeKey);
      set({ loadingRanges: loadingRangesAfter });

      // Retry failed range with exponential backoff (module-level Map, not Zustand)
      const prevDelay = _rangeRetryDelays.get(rangeKey) || 0;
      const nextDelay = prevDelay === 0 ? 3000 : Math.min(prevDelay * 2, 120000);
      _rangeRetryDelays.set(rangeKey, nextDelay);
      console.log(`[loadEmailRange] Retrying range ${startIndex}-${endIndex} in ${nextDelay / 1000}s`);
      setTimeout(() => {
        _rangeRetryDelays.delete(rangeKey);
        get().loadEmailRange(startIndex, endIndex);
      }, nextDelay);
    }
  },

  // Check if a specific index is loaded
  isIndexLoaded: (index) => {
    const { loadedRanges } = get();
    for (const range of loadedRanges) {
      if (index >= range.start && index < range.end) return true;
    }
    return false;
  },

  // Get email at specific index (returns null if out of bounds)
  getEmailAtIndex: (index) => {
    const { emails } = get();
    return emails[index] || null;
  },

  // Get combined emails based on view mode (returns pre-sorted for performance)
  getCombinedEmails: () => {
    return get().sortedEmails;
  },

  // Get the Sent mailbox path from the mailboxes tree (e.g. "Sent", "INBOX.Sent", "[Gmail]/Sent Mail")
  getSentMailboxPath: () => {
    const { mailboxes } = get();
    const findSent = (boxes) => {
      for (const box of boxes) {
        if (box.specialUse === '\\Sent') return box.path;
        if (box.children?.length > 0) {
          const found = findSent(box.children);
          if (found) return found;
        }
      }
      return null;
    };
    return findSent(mailboxes);
  },

  // Load Sent folder headers into sentEmails state.
  // Quick-loads from disk cache, then refreshes from IMAP when connected.
  loadSentHeaders: async (accountId) => {
    const sentPath = get().getSentMailboxPath();
    if (!sentPath) { set({ sentEmails: [] }); return; }

    // Quick-load from disk cache first (instant UI) — partial load for speed
    const cached = await db.getEmailHeadersPartial(accountId, sentPath, 200);
    // Guard: account may have changed during async cache read
    if (get().activeAccountId !== accountId) return;
    if (cached?.emails?.length > 0) {
      set({ sentEmails: cached.emails });
    }

    // Then refresh from server (Sent folder can grow as user sends)
    const { accounts, connectionStatus, mailboxes } = get();
    const account = accounts.find(a => a.id === accountId);
    if (!account || connectionStatus !== 'connected') return;

    try {
      if (isGraphAccount(account)) {
        // Graph API: find Sent folder ID from mailboxes
        const sentFolder = mailboxes.find(m => m.path === sentPath);
        if (sentFolder?._graphFolderId) {
          const freshAccount = await ensureFreshToken(account);
          const result = await api.graphListMessages(freshAccount.oauth2AccessToken, sentFolder._graphFolderId, 200, 0);
          if (get().activeAccountId !== accountId) return;
          const sentHeaders = result.headers || [];
          if (sentHeaders.length > 0) {
            await db.saveEmailHeaders(accountId, sentPath, sentHeaders, sentHeaders.length);
            if (get().activeAccountId !== accountId) return;
            set({ sentEmails: sentHeaders });
          }
        }
      } else {
        const result = await api.fetchEmails(account, sentPath, 1, 200);
        // Guard: account may have changed during async IMAP fetch
        if (get().activeAccountId !== accountId) return;
        if (result?.emails?.length > 0) {
          await db.saveEmailHeaders(accountId, sentPath, result.emails, result.total);
          // Guard: check again after async save
          if (get().activeAccountId !== accountId) return;
          set({ sentEmails: result.emails });
        }
      }
    } catch (e) {
      console.warn('[loadSentHeaders] fetch failed:', e.message);
      // Keep whatever was in cache
    }
  },

  // Get merged INBOX + Sent emails for chat view (memoized via module-level cache)
  getChatEmails: () => {
    const { sortedEmails, sentEmails, archivedEmailIds, viewMode } = get();

    // Fingerprint check: skip merge+sort if inputs haven't changed
    const { activeAccountId, activeMailbox } = get();
    const fp = `${activeAccountId}-${activeMailbox}-${viewMode}-${sortedEmails.length}-${sortedEmails[0]?.uid || 0}-${sortedEmails[sortedEmails.length - 1]?.uid || 0}-${sentEmails.length}-${sentEmails[0]?.uid || 0}-${_flagChangeCounter}-${archivedEmailIds.size}`;
    if (fp === _chatEmailsFingerprint && _chatEmailsCache.length > 0) return _chatEmailsCache;

    if (sentEmails.length === 0) {
      _chatEmailsCache = sortedEmails;
      _chatEmailsFingerprint = fp;
      return sortedEmails;
    }

    // Deduplicate by messageId (some servers copy sent to INBOX)
    const seen = new Set();
    const merged = [];

    for (const email of sortedEmails) {
      if (email.messageId) seen.add(email.messageId);
      merged.push(email);
    }

    for (const email of sentEmails) {
      if (email.messageId && seen.has(email.messageId)) continue;
      if (email.messageId) seen.add(email.messageId);
      email._fromSentFolder = true;
      merged.push(email);
    }

    for (const e of merged) {
      if (e._ts === undefined) e._ts = new Date(e.date || e.internalDate || 0).getTime();
    }
    merged.sort((a, b) => b._ts - a._ts);

    _chatEmailsCache = merged;
    _chatEmailsFingerprint = fp;
    // Track thread/chat cache memory (~0.5KB per entry for references)
    // Thread cache memory tracked by fingerprint invalidation, no separate governor needed
    return merged;
  },

  // Build threads from merged INBOX + Sent emails using RFC header chains (memoized)
  getThreads: () => {
    const chatEmails = get().getChatEmails();
    const { viewMode } = get();
    const fp = `${viewMode}-${chatEmails.length}-${chatEmails[0]?.uid || 0}-${chatEmails[chatEmails.length - 1]?.uid || 0}-${_flagChangeCounter}`;
    if (fp === _threadsFingerprint && _threadsCache.size > 0) {
      return _threadsCache;
    }
    const threads = buildThreads(chatEmails);
    _threadsCache = threads;
    _threadsFingerprint = fp;
    return threads;
  },
});
