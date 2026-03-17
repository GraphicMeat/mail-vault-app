import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../services/db';
import * as api from '../services/api';
import { useSettingsStore } from './settingsStore';
import { hasValidCredentials, ensureFreshToken } from '../services/authUtils';
import { hasRealAttachments } from '../services/attachmentUtils';
import { buildThreads } from '../utils/emailParser';
import { UidMap } from '../services/UidMap';
import { isGraphAccount, GRAPH_FOLDER_NAME_MAP, APP_TO_GRAPH_FOLDER_MAP, normalizeGraphFolderName, graphFoldersToMailboxes, inferSpecialUse, graphMessageToEmail } from '../services/graphConfig';
import { saveToMailboxCache as _saveToMailboxCache, getFromMailboxCache as _getFromMailboxCache, invalidateMailboxCache as _invalidateMailboxCache, saveToAccountCache as _saveToAccountCache, getFromAccountCache as _getFromAccountCache, invalidateAccountCache as _invalidateAccountCache, getAccountCacheEntries, setGraphIdMap as _setGraphIdMap, getGraphMessageId, clearGraphIdMap as _clearGraphIdMap } from '../services/cacheManager';
export { graphMessageToEmail, getGraphMessageId };

// ── Unified inbox helpers ───────────────────────────────────────────────────

// Resolve real account + mailbox for a UID in unified inbox mode.
// Unified inbox emails carry _accountId/_accountEmail; the real mailbox is always INBOX.
function _resolveUnifiedContext(uid, state) {
  const email = state.emails.find(e => e.uid === uid);
  if (!email?._accountId) return null;
  const account = state.accounts.find(a => a.id === email._accountId);
  if (!account) return null;
  return { account, accountId: email._accountId, mailbox: 'INBOX' };
}

// Module-level cache for getChatEmails() — avoids calling set() during render
let _chatEmailsCache = [];
let _chatEmailsFingerprint = '';

// Module-level cache for getThreads() — avoids rebuilding threads on every call
let _threadsCache = new Map();
let _threadsFingerprint = '';

// Module-level cache size tracking — avoids mutating Zustand state outside set()
let _cacheCurrentSizeMB = 0;

// Module-level flag change counter — used in updateSortedEmails fingerprint
let _flagChangeCounter = 0;

// Module-level loadMore dedup timer
let _loadMoreTimer = null;
let _markAsReadTimer = null;

// Module-level loadEmails generation counter — prevents stale concurrent calls
let _loadEmailsGeneration = 0;
// Module-level retry flag — prevents infinite retry loops on persistent errors
let _loadEmailsRetried = false;

// ── AbortController for activateAccount — cancels previous activation on rapid switch ──
let _activeController = null;

// ── AbortController for progressive loading — cancels background loading on switch ──
let _loadAbortController = null;

// Module-level range retry state — avoids polluting Zustand store with dynamic keys
const _rangeRetryDelays = new Map();
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
 *
 * Returns { cachedMailboxes, cachedMailboxEntry, effectiveMailbox } immediately
 * from the local cache (for first paint), and kicks off a server fetch in parallel
 * that updates the store + disk only when the result differs from cache.
 *
 * @param {string} accountId
 * @param {object} account - account object (with credentials)
 * @param {string} requestedMailbox - the mailbox the user requested
 * @param {AbortSignal} signal
 * @param {object} options - { isBackgroundRefresh }
 * @returns {{ cachedEntry, localMailboxes, effectiveMailbox, serverMailboxesPromise }}
 */
async function loadMailboxes(accountId, account, requestedMailbox, signal, { isBackgroundRefresh = false } = {}) {
  // ── Local: read disk cache ──
  const cachedEntry = await db.getCachedMailboxEntry(accountId).catch(() => null);
  if (signal.aborted) return null;

  const localMailboxes = cachedEntry?.mailboxes || [
    { name: 'INBOX', path: 'INBOX', specialUse: null, children: [] }
  ];

  // Set cached mailboxes immediately (first paint)
  if (!isBackgroundRefresh) {
    useMailStore.setState({
      mailboxes: localMailboxes,
      mailboxesFetchedAt: cachedEntry?.fetchedAt ?? null,
    });
  }

  // Validate requested mailbox exists in cached tree
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
      useMailStore.setState({ activeMailbox: 'INBOX' });
      useSettingsStore.getState().setLastMailbox(accountId, 'INBOX');
    }
  }

  // ── Server: fetch from IMAP/Graph in parallel (non-blocking) ──
  // Only fetch if cache is stale or incomplete.
  const isFresh = shouldUseFreshMailboxCache(cachedEntry);
  const serverMailboxesPromise = isFresh
    ? Promise.resolve(null) // cache is fresh, skip server call
    : fetchAccountMailboxes(account)
        .then(freshMailboxes => {
          if (signal.aborted) return null;
          if (useMailStore.getState().activeAccountId !== accountId) return null;

          // Only update if actually different (avoid unnecessary re-renders)
          const currentMailboxes = useMailStore.getState().mailboxes;
          const changed = _mailboxesChanged(currentMailboxes, freshMailboxes);

          if (changed) {
            // Validate activeMailbox still exists in fresh list
            const freshPaths = new Set();
            const collect = (mboxes) => { for (const m of mboxes) { freshPaths.add(m.path); if (m.children?.length) collect(m.children); } };
            collect(freshMailboxes);

            const updates = {
              mailboxes: freshMailboxes,
              mailboxesFetchedAt: Date.now(),
            };

            const currentActive = useMailStore.getState().activeMailbox;
            if (currentActive !== 'INBOX' && currentActive !== 'UNIFIED' && !freshPaths.has(currentActive)) {
              console.warn(`[loadMailboxes] Active mailbox "${currentActive}" not found on server, switching to INBOX`);
              updates.activeMailbox = 'INBOX';
              useSettingsStore.getState().setLastMailbox(accountId, 'INBOX');
            }

            useMailStore.setState(updates);
          } else {
            // Just update the timestamp
            useMailStore.setState({ mailboxesFetchedAt: Date.now() });
          }

          // Always persist (updates timestamp on disk even if unchanged)
          db.saveMailboxes(accountId, freshMailboxes);

          // Update in-memory account cache
          const cached = _getFromAccountCache(accountId);
          if (cached) {
            cached.mailboxes = freshMailboxes;
            cached.mailboxesFetchedAt = Date.now();
          }

          return freshMailboxes;
        })
        .catch(e => {
          console.warn('[loadMailboxes] Server fetch failed (non-fatal):', e.message);
          return null;
        });

  return { cachedEntry, localMailboxes, effectiveMailbox, serverMailboxesPromise };
}

/**
 * Cheap diff: returns true if the mailbox tree has changed.
 * Compares path sets + children counts (avoids deep equality for perf).
 */
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

import { createPerfTrace } from '../utils/perfTrace';

/**
 * _loadServerEmailsViaGraph — Graph API server stream for activateAccount.
 * Extracted as a module-level function so it can access api/db without store closure.
 */
async function _loadServerEmailsViaGraph(account, accountId, activeMailbox, uidMap, signal, trace) {
  const savedEmailIds = useMailStore.getState().savedEmailIds;

  // 1. Use mailboxes already set by loadMailboxes() — only force-refresh from
  //    Graph if the target folder is missing its _graphFolderId (edge case:
  //    cached mailboxes were from IMAP era before Graph migration).
  let mailboxes = useMailStore.getState().mailboxes || [];
  let targetFolder = mailboxes.find(m => m.path === activeMailbox && m._graphFolderId);

  if (!targetFolder) {
    // Force a Graph folder fetch — loadMailboxes may have used stale IMAP cache
    const graphFolders = await api.graphListFolders(account.oauth2AccessToken);
    if (signal.aborted) return;
    mailboxes = graphFoldersToMailboxes(graphFolders);
    useMailStore.setState({ mailboxes, mailboxesFetchedAt: Date.now() });
    db.saveMailboxes(accountId, mailboxes);
    targetFolder = mailboxes.find(m => m.path === activeMailbox);
  }

  // 2. Find the Graph folder ID
  if (!targetFolder || !targetFolder._graphFolderId) {
    console.warn('[activateAccount:graph] No matching folder for', activeMailbox);
    useMailStore.setState({ loading: false, loadingMore: false, connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
    return;
  }

  // 3. Fetch messages
  const result = await api.graphListMessages(account.oauth2AccessToken, targetFolder._graphFolderId, 200, 0);
  if (signal.aborted) return;

  const headers = result.headers || [];
  const graphMessageIds = result.graphMessageIds || [];

  // 4. Build UID → Graph message ID mapping
  const uidToGraphId = new Map();
  headers.forEach((h, i) => { uidToGraphId.set(h.uid, graphMessageIds[i]); });
  _setGraphIdMap(accountId, activeMailbox, uidToGraphId);

  // 5. Merge into UidMap
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

  commitToStore(uidMap, signal, accountId, {
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

  // Save to account cache and disk
  if (!useMailStore.getState().unifiedInbox) {
    _saveToAccountCache(accountId, useMailStore.getState());
  }
  db.saveEmailHeaders(accountId, activeMailbox, sorted, serverTotal)
    .catch(e => console.warn('[activateAccount:graph] Failed to cache headers:', e));

  trace.end('graph-done', { count: sorted.length });
}

/**
 * commitToStore — converts UidMap + local state into Zustand store state.
 * Called by both local and server streams during activateAccount.
 * Checks signal.aborted and activeAccountId before writing.
 */
function commitToStore(uidMap, signal, accountId, extras = {}) {
  if (signal.aborted) return;
  const store = useMailStore.getState();
  if (store.activeAccountId !== accountId) return;

  const sortedEmails = uidMap.toSortedArray();
  const emailsByIndex = new Map();
  sortedEmails.forEach((email, idx) => {
    emailsByIndex.set(idx, email);
  });

  // Merge with view mode filtering (server/local/all) via updateSortedEmails after set
  const stateUpdate = {
    emails: sortedEmails,
    emailsByIndex,
    totalEmails: extras.totalEmails ?? sortedEmails.length,
    loadedRanges: [{ start: 0, end: sortedEmails.length }],
    ...extras,
  };

  useMailStore.setState(stateUpdate);
  // Recompute sortedEmails (applies viewMode filtering + local email merging)
  useMailStore.getState().updateSortedEmails();
}

/**
 * Returns cached emails across all accounts (for cross-account analytics).
 * Includes both the active account and any LRU-cached accounts.
 */
export function getAccountCacheEmails() {
  const result = [];
  const seen = new Set();

  for (const [accountEmail, cached] of getAccountCacheEntries().entries()) {
    seen.add(accountEmail);
    result.push({
      accountEmail,
      emails: cached.emails || [],
      sentEmails: cached.sentEmails || [],
    });
  }

  // Include current active account if not already in cache
  const state = useMailStore.getState();
  const activeId = state.activeAccountId;
  if (activeId && !seen.has(activeId)) {
    result.push({
      accountEmail: activeId,
      emails: state.emails || [],
      sentEmails: state.sentEmails || [],
    });
  }

  return result;
}

export const useMailStore = create((set, get) => ({
  // Accounts
  accounts: [],
  activeAccountId: null,
  
  // Mailboxes
  mailboxes: [],
  mailboxesFetchedAt: null,
  activeMailbox: 'INBOX',
  
  // Emails
  emails: [],
  localEmails: [],
  savedEmailIds: new Set(),
  archivedEmailIds: new Set(),
  serverUidSet: new Set(), // Full set of UIDs known to exist on the IMAP server
  selectedEmailId: null,
  selectedEmail: null,
  selectedEmailSource: null, // 'server' | 'local' | 'local-only'
  selectedThread: null, // thread object from buildThreads, or null for single email

  // Sparse email storage for virtualized scrolling
  // Maps display index -> email header
  emailsByIndex: new Map(),
  // Track which ranges have been loaded
  loadedRanges: [], // Array of {start, end} objects
  // Loading state for specific ranges
  loadingRanges: new Set(), // Set of "start-end" strings
  
  // Email cache - stores full email content by key (accountId-mailbox-uid)
  // Each entry also stores timestamp for LRU eviction
  emailCache: new Map(), // Map<cacheKey, { email, timestamp, size }>
  cacheCurrentSizeMB: 0,
  
  // View mode: 'all' | 'server' | 'local'
  viewMode: 'all',

  // Pre-sorted emails for performance (memoization)
  sortedEmails: [],
  _sortedEmailsFingerprint: '',
  // Incremented on flag changes (read/unread) — allows thread caches to invalidate
  _flagSeq: 0,

  // Sent folder headers for chat view (merged with INBOX for conversations)
  sentEmails: [],
  
  // Connection status: 'connected' | 'disconnected' | 'error'
  connectionStatus: 'disconnected',
  connectionError: null,
  // Error type: 'passwordMissing' | 'offline' | 'serverError' | null
  connectionErrorType: null,
  
  // UI state
  loading: false,
  loadingEmail: false,
  loadingMore: false,
  error: null,

  // Undo send
  pendingSend: null,  // { composeState, timeoutId, timestamp, delay }

  // Pagination
  currentPage: 1,
  hasMoreEmails: true,
  totalEmails: 0,
  
  // Selection for bulk actions
  selectedEmailIds: new Set(),
  
  // Bulk save progress
  bulkSaveProgress: null, // { total, completed, errors, active }
  exportProgress: null, // { total, completed, active, mode: 'export'|'import' }

  // Progressive loading progress
  loadingProgress: null, // { loaded: N, total: M } during background loading

  // Unified inbox mode
  unifiedInbox: false,

  // Unread counts across all accounts
  totalUnreadCount: 0,


  // Clear email cache (call when switching accounts/mailboxes)
  clearEmailCache: () => {
    _cacheCurrentSizeMB = 0;
    // Invalidate account cache for current account
    const { activeAccountId } = get();
    if (activeAccountId) _invalidateAccountCache(activeAccountId);
    set({ emailCache: new Map(), cacheCurrentSizeMB: 0 });
  },
  
  // Undo send — queue a send with a delay, or send immediately if disabled
  queueSend: (composeState, sendFn) => {
    const { undoSendEnabled, undoSendDelay } = useSettingsStore.getState();
    if (!undoSendEnabled || undoSendDelay === 0) {
      sendFn();
      return;
    }
    const timeoutId = setTimeout(() => {
      sendFn();
      set({ pendingSend: null });
    }, undoSendDelay * 1000);
    set({ pendingSend: { composeState, timeoutId, timestamp: Date.now(), delay: undoSendDelay } });
  },

  cancelPendingSend: () => {
    const { pendingSend } = get();
    if (pendingSend) {
      clearTimeout(pendingSend.timeoutId);
      const saved = pendingSend.composeState;
      set({ pendingSend: null });
      return saved;
    }
    return null;
  },

  // Estimate size of an email object in MB
  estimateEmailSizeMB: (email) => {
    try {
      const str = JSON.stringify(email);
      return str.length / (1024 * 1024);
    } catch {
      return 0.1; // Default estimate
    }
  },
  
  // Add email to cache with size limit enforcement
  // Strips rawSource and attachment content to minimize memory footprint
  addToCache: (cacheKey, email, cacheLimitMB) => {
    const { emailCache, cacheCurrentSizeMB } = get();

    // Strip heavy fields before caching — rawSource is already on disk as .eml,
    // and attachment content is fetched on demand
    const lightEmail = { ...email };
    delete lightEmail.rawSource;
    if (lightEmail.attachments) {
      lightEmail.attachments = lightEmail.attachments.map(att => {
        const { content, ...meta } = att;
        return meta;
      });
    }

    const emailSize = get().estimateEmailSizeMB(lightEmail);

    // Enforce limit (treat 0 as unlimited but still cap at a safe ceiling for WKWebView)
    const effectiveLimit = cacheLimitMB > 0 ? cacheLimitMB : 4096;

    // Evict oldest entries if we'd exceed the limit.
    // O(1) per eviction: Map preserves insertion order, so first key = oldest.
    // Delete-before-set ensures re-cached keys move to the end (LRU order).
    let currentSize = _cacheCurrentSizeMB;

    while (currentSize + emailSize > effectiveLimit && emailCache.size > 0) {
      const oldestKey = emailCache.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = emailCache.get(oldestKey);
      currentSize -= evicted.size;
      emailCache.delete(oldestKey);
    }

    // Delete first if key exists so re-insert moves it to end of insertion order (LRU)
    if (emailCache.has(cacheKey)) emailCache.delete(cacheKey);
    emailCache.set(cacheKey, {
      email: lightEmail,
      timestamp: Date.now(),
      size: emailSize
    });

    // Update size tracking without triggering a store notification on every cached email.
    // Only emit set() when the size changes by ≥1MB to avoid 15+ re-renders/sec from pipeline.
    const newSize = currentSize + emailSize;
    _cacheCurrentSizeMB = newSize;
    if (Math.abs(newSize - get().cacheCurrentSizeMB) >= 1) {
      set({ cacheCurrentSizeMB: newSize });
    }
  },
  
  // Update sorted emails (memoization for performance)
  updateSortedEmails: () => {
    const { emails, localEmails, viewMode, savedEmailIds, archivedEmailIds, serverUidSet, unifiedInbox, _sortedEmailsFingerprint } = get();

    // Fingerprint check: skip if the input set hasn't materially changed
    const fp = `${viewMode}-${emails.length}-${emails[0]?.uid || 0}-${emails[emails.length - 1]?.uid || 0}-${localEmails.length}-${archivedEmailIds.size}-${savedEmailIds.size}-${serverUidSet.size}-${_flagChangeCounter}`;
    if (fp === _sortedEmailsFingerprint) return;

    // In unified inbox, UIDs collide across accounts — use compound key for dedup
    const uidKey = unifiedInbox
      ? (e) => `${e._accountId || ''}:${e.uid}`
      : (e) => e.uid;

    let result = [];

    if (viewMode === 'server') {
      // Server mode: show only IMAP emails, all as 'server' source.
      // Don't mark isArchived — in server context everything is a server email.
      result = emails.map(e => ({
        ...e,
        isLocal: false,
        isArchived: false,
        source: 'server'
      }));
    } else if (viewMode === 'local') {
      // Local mode: show only archived emails from disk.
      // Use serverUidSet (full IMAP UID set) to distinguish local vs local-only.
      result = localEmails
        .filter(e => archivedEmailIds.has(e.uid))
        .map(e => ({
          ...e,
          isLocal: true,
          isArchived: true,
          source: serverUidSet.has(e.uid) ? 'local' : 'local-only'
        }));
    } else {
      // viewMode === 'all': server emails + archived local-only emails.
      // Use serverUidSet to accurately classify even when emails array is partial.
      const loadedKeys = new Set(emails.map(e => uidKey(e)));
      const combinedEmails = emails.map(e => ({
        ...e,
        isLocal: savedEmailIds.has(e.uid),
        isArchived: archivedEmailIds.has(e.uid),
        source: 'server'
      }));

      // Add archived local emails not yet loaded as headers.
      // Use serverUidSet to distinguish: on server but not loaded yet ('local') vs truly local-only.
      for (const localEmail of localEmails) {
        if (!loadedKeys.has(uidKey(localEmail)) && archivedEmailIds.has(localEmail.uid)) {
          combinedEmails.push({
            ...localEmail,
            isLocal: true,
            isArchived: true,
            source: serverUidSet.has(localEmail.uid) ? 'local' : 'local-only'
          });
        }
      }

      result = combinedEmails;
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

  // Get email from cache (updates timestamp for LRU)
  getFromCache: (cacheKey) => {
    const { emailCache } = get();
    const entry = emailCache.get(cacheKey);

    if (entry) {
      // Update timestamp in place — no Map copy needed
      entry.timestamp = Date.now();
      return entry.email;
    }

    return null;
  },
  
  // Initialize
  init: async () => {
    try {
      console.log('[init] Starting db.initDB...');
      await db.initDB();
      console.log('[init] db.initDB done, getting accounts...');
      const accounts = await db.getAccounts();
      console.log('[init] Got', accounts.length, 'accounts');
      set({ accounts });

      // Backfill accounts.json so future quick-loads find accounts without keychain
      if (accounts.length > 0) {
        await db.ensureAccountsInFile(accounts);
        const { hiddenAccounts } = useSettingsStore.getState();
        const { activeAccountId: currentActiveId } = get();

        // Prefer the account that quick-load already activated (if it's valid and visible)
        const currentIsValid = currentActiveId && accounts.some(a => a.id === currentActiveId) && !hiddenAccounts[currentActiveId];
        const firstVisible = currentIsValid
          ? accounts.find(a => a.id === currentActiveId)
          : (accounts.find(a => !hiddenAccounts[a.id]) || accounts[0]);

        if (!firstVisible) {
          set({ loading: false });
          return;
        }

        // Check credentials before attempting server operations — if keychain
        // hasn't provided them yet, keep cached emails visible without error.
        const hasCredentials = firstVisible.password || (firstVisible.authType === 'oauth2' && firstVisible.oauth2AccessToken);

        if (!hasCredentials) {
          // No credentials yet — show cached data quietly, retry in background
          console.log('[init] Credentials not yet available for', firstVisible.email, '— will retry');
          set({ loading: false });
          const cachedMailboxEntry = await db.getCachedMailboxEntry(firstVisible.id);
          if (cachedMailboxEntry?.mailboxes) {
            set({ mailboxes: cachedMailboxEntry.mailboxes, mailboxesFetchedAt: cachedMailboxEntry.fetchedAt });
          }

          // Auto-retry: wait for keychain to resolve, then re-init
          setTimeout(async () => {
            const { connectionErrorType: currentErrorType } = get();
            if (currentErrorType === 'passwordMissing' || !get().accounts.find(a => a.id === firstVisible.id)?.password) {
              console.log('[init] Auto-retrying keychain access...');
              await get().retryKeychainAccess();
            }
          }, 3000);
        } else if (currentActiveId === firstVisible.id) {
          // Quick-load already started activateAccount — just ensure it's running.
          // activateAccount handles cached data display + server sync in parallel.
          console.log('[init] Account already active from quick-load via activateAccount');
          const { emails: currentEmails, loading: currentLoading, sortedEmails: currentSorted } = get();
          console.log('[init] Current state: emails=%d, sortedEmails=%d, loading=%s', currentEmails.length, currentSorted.length, currentLoading);
          // Safety: if activateAccount populated emails but loading is stuck, force it off
          if (currentEmails.length > 0 && currentLoading) {
            console.warn('[init] Loading stuck with %d emails — forcing loading=false', currentEmails.length);
            set({ loading: false });
            if (currentSorted.length === 0) get().updateSortedEmails();
          }
        } else {
          // Different account or no active — use activateAccount
          const lastMailbox = useSettingsStore.getState().getLastMailbox(firstVisible.id);
          await get().activateAccount(firstVisible.id, lastMailbox || 'INBOX');
        }
      }

      // Background: pre-warm account cache, then prefetch a small number of stale mailbox trees when idle.
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
      set({ error: error.message, loading: false });
    }
  },

  // Pre-fetch mailboxes for all visible accounts (background, non-blocking)
  _prefetchAllMailboxes: async ({ limit = MAILBOX_PREFETCH_LIMIT } = {}) => {
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
        await db.saveMailboxes(account.id, mailboxes);
        // Update in-memory account cache if entry exists
        const cached = _getFromAccountCache(account.id);
        if (cached) {
          cached.mailboxes = mailboxes;
          cached.mailboxesFetchedAt = Date.now();
        }
      } catch (e) {
        console.warn(`[prefetch] Mailbox fetch failed for ${account.email} (non-fatal):`, e.message);
      }
    }));
    console.log('[prefetch] Mailbox pre-fetch complete');
  },

  // Pre-warm account cache with headers.json for all non-active visible accounts
  // so that account switching and unified inbox are instant from first use
  _prewarmAccountCaches: async () => {
    const { accounts, activeAccountId } = get();
    const { hiddenAccounts } = useSettingsStore.getState();

    const otherAccounts = accounts.filter(a =>
      a.id !== activeAccountId && !hiddenAccounts[a.id]
    );

    if (otherAccounts.length === 0) return;
    console.log('[prewarm] Pre-warming account cache for', otherAccounts.length, 'background accounts');

    await Promise.allSettled(otherAccounts.map(async (account) => {
      // Skip if already in cache
      if (_getFromAccountCache(account.id)) return;

      try {
        // Load headers, saved/archived IDs, and mailboxes in parallel
        const [cachedHeaders, archivedEmailIds, savedEmailIds, cachedMailboxEntry] = await Promise.all([
          db.getEmailHeadersPartial(account.id, 'INBOX', 200),
          db.getArchivedEmailIds(account.id, 'INBOX'),
          db.getSavedEmailIds(account.id, 'INBOX'),
          db.getCachedMailboxEntry(account.id).catch(() => null),
        ]);
        if (!cachedHeaders || !cachedHeaders.emails || cachedHeaders.emails.length === 0) return;

        const cachedMailboxes = cachedMailboxEntry?.mailboxes || null;

        // Load archived emails — try local-index.json first (fast), fall back to .eml scanning
        let localEmails = [];
        if (archivedEmailIds.size > 0) {
          try {
            localEmails = await db.readLocalEmailIndex(account.id, 'INBOX') ||
              await db.getArchivedEmails(account.id, 'INBOX', archivedEmailIds);
          } catch (e) {
            console.warn(`[prewarm] Failed to load local emails for ${account.email}:`, e.message);
          }
        }

        _saveToAccountCache(account.id, {
          emails: cachedHeaders.emails,
          localEmails,
          emailsByIndex: new Map(),
          totalEmails: cachedHeaders.totalEmails || cachedHeaders.emails.length,
          savedEmailIds,
          archivedEmailIds,
          loadedRanges: [{ start: 0, end: cachedHeaders.emails.length }],
          currentPage: 1,
          hasMoreEmails: cachedHeaders.emails.length < (cachedHeaders.totalEmails || cachedHeaders.emails.length),
          sentEmails: [],
          mailboxes: cachedMailboxes || [],
          mailboxesFetchedAt: cachedMailboxEntry?.fetchedAt ?? null,
          connectionStatus: 'disconnected',
          activeMailbox: 'INBOX',
        });
        // Update unread count from cached headers (instant badge on launch)
        const unread = cachedHeaders.emails.filter(e => !e.flags?.includes('\\Seen')).length;
        useSettingsStore.getState().setUnreadForAccount(account.id, unread);

        console.log('[prewarm] Cached', cachedHeaders.emails.length, 'headers +', localEmails.length, 'local emails for', account.email);
      } catch (e) {
        console.warn(`[prewarm] Failed for ${account.email} (non-fatal):`, e.message);
      }
    }));
    console.log('[prewarm] Account cache pre-warm complete');
  },

  // Account management
  addAccount: async (accountData) => {
    console.log('[mailStore] addAccount called with:', { ...accountData, password: '***' });

    // Check for duplicate email address
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

    // Test connection first
    console.log('[mailStore] Testing connection...');
    try {
      if (isGraphAccount(account)) {
        // For Graph accounts, test by listing folders via Graph API
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

    // Save to Maildir
    console.log('[mailStore] Saving account to database...');
    try {
      await db.saveAccount(account);
      console.log('[mailStore] Account saved successfully');
    } catch (error) {
      console.error('[mailStore] Failed to save account:', error);
      throw error;
    }

    set(state => ({
      accounts: [...state.accounts, account]
    }));
    console.log('[mailStore] Account added to store');

    // Set as active if it's the first account
    if (get().accounts.length === 1) {
      await get().activateAccount(account.id, 'INBOX');
    }

    return account;
  },
  
  removeAccount: async (accountId) => {
    const account = get().accounts.find(a => a.id === accountId);
    if (account && !isGraphAccount(account)) {
      try {
        await api.disconnect(account);
      } catch (e) {
        // Ignore disconnect errors
      }
    }
    
    await db.deleteAccount(accountId);
    _invalidateAccountCache(accountId);
    _invalidateMailboxCache(accountId);
    _clearGraphIdMap(accountId);

    const newAccounts = get().accounts.filter(a => a.id !== accountId);
    const { [accountId]: _removed, ...remainingUnread } = useSettingsStore.getState().unreadPerAccount;
    useSettingsStore.getState().setUnreadPerAccount(remainingUnread);

    set({ accounts: newAccounts });
    
    if (get().activeAccountId === accountId) {
      const { hiddenAccounts } = useSettingsStore.getState();
      const nextVisible = newAccounts.find(a => !hiddenAccounts[a.id]);
      if (nextVisible) {
        const lastMailbox = useSettingsStore.getState().getLastMailbox(nextVisible.id);
        await get().activateAccount(nextVisible.id, lastMailbox || 'INBOX');
      } else {
        set({
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
  },
  
  // Legacy wrapper — delegates to activateAccount. Kept for backward compatibility
  // with internal callers (pipeline, refresh, etc.) that don't specify a mailbox.
  setActiveAccount: async (accountId) => {
    const lastMailbox = useSettingsStore.getState().getLastMailbox(accountId);
    await get().activateAccount(accountId, lastMailbox || 'INBOX');
  },

  // ── activateAccount — single entry point for account/mailbox activation ──
  //
  // Replaces the scattered quick-load + setActiveAccount + loadEmails chain.
  // Two streams (local + server) run in parallel via Promise.all, each calling
  // commitToStore() for progressive rendering. AbortController cancels previous
  // activation on rapid switching.

  activateAccount: async (accountId, mailbox, options = {}) => {
    const activationTrace = createPerfTrace('activateAccount', { accountId, mailbox });

    // Cancel any previous activation and progressive loading
    if (_activeController) _activeController.abort();
    if (_loadAbortController) _loadAbortController.abort();
    _activeController = new AbortController();
    const { signal } = _activeController;

    let account = get().accounts.find(a => a.id === accountId);
    if (!account) {
      activationTrace.end('missing-account');
      return;
    }

    const { activeAccountId: currentAccountId, emails: currentEmails, totalEmails: currentTotalEmails } = get();
    const isMailboxSwitch = currentAccountId === accountId;

    // Save current account state to cache before switching (if switching accounts)
    if (currentAccountId && currentAccountId !== accountId && (currentEmails.length > 0 || currentTotalEmails > 0)) {
      _saveToAccountCache(currentAccountId, get());
    }
    // Save current mailbox to LRU cache if switching mailbox within same account
    const previousMailbox = get().activeMailbox;
    if (isMailboxSwitch && previousMailbox && previousMailbox !== mailbox && previousMailbox !== 'UNIFIED') {
      _saveToMailboxCache(accountId, previousMailbox, get());
    }

    // ── Check account cache for instant restore (account switch only) ──
    if (!isMailboxSwitch) {
      const cachedAccount = _getFromAccountCache(accountId);
      if (cachedAccount) {
        console.log('[activateAccount] Account cache HIT for', accountId, '— restoring', cachedAccount.emails.length, 'emails instantly');
        _chatEmailsFingerprint = '';
        _threadsFingerprint = '';

        let cachedMailboxes = cachedAccount.mailboxes;
        if (!cachedMailboxes || cachedMailboxes.length === 0) {
          const cachedMailboxEntry = await db.getCachedMailboxEntry(accountId);
          cachedMailboxes = cachedMailboxEntry?.mailboxes || [{ name: 'INBOX', path: 'INBOX', specialUse: null, children: [] }];
        }

        set({
          activeAccountId: accountId,
          activeMailbox: cachedAccount.activeMailbox || mailbox,
          unifiedInbox: false,
          emails: cachedAccount.emails,
          localEmails: cachedAccount.localEmails,
          emailsByIndex: cachedAccount.emailsByIndex,
          totalEmails: cachedAccount.totalEmails,
          savedEmailIds: cachedAccount.savedEmailIds,
          archivedEmailIds: cachedAccount.archivedEmailIds,
          loadedRanges: cachedAccount.loadedRanges,
          currentPage: cachedAccount.currentPage,
          hasMoreEmails: cachedAccount.hasMoreEmails,
          sentEmails: cachedAccount.sentEmails,
          mailboxes: cachedMailboxes,
          mailboxesFetchedAt: cachedAccount.mailboxesFetchedAt ?? null,
          serverUidSet: new Set(),
          connectionStatus: cachedAccount.connectionStatus,
          selectedEmailId: null,
          selectedEmail: null,
          selectedEmailSource: null,
          selectedThread: null,
          selectedEmailIds: new Set(),
          loading: false,
          loadingMore: false,
          error: null,
        });
        get().updateSortedEmails();
        activationTrace.mark('cache-restored', { emailCount: cachedAccount.emails.length });

        // Fire-and-forget: silent email + folder refresh in background
        // loadMailboxes runs inside activateAccount, so this covers both
        get().activateAccount(accountId, cachedAccount.activeMailbox || mailbox, { _backgroundRefresh: true }).catch(() => {});
        get().loadSentHeaders(accountId);

        activationTrace.end('cache-hit-return');
        return;
      }
    }

    // ── Check mailbox LRU cache (mailbox switch within same account) ──
    if (isMailboxSwitch) {
      const cachedMailbox = _getFromMailboxCache(accountId, mailbox);
      if (cachedMailbox) {
        console.log('[activateAccount] Mailbox cache HIT for', mailbox, '— restoring', cachedMailbox.emails.length, 'emails');
        set({
          activeMailbox: mailbox,
          unifiedInbox: false,
          emails: cachedMailbox.emails,
          localEmails: cachedMailbox.localEmails,
          emailsByIndex: cachedMailbox.emailsByIndex,
          totalEmails: cachedMailbox.totalEmails,
          savedEmailIds: cachedMailbox.savedEmailIds,
          archivedEmailIds: cachedMailbox.archivedEmailIds,
          loadedRanges: cachedMailbox.loadedRanges,
          currentPage: cachedMailbox.currentPage,
          hasMoreEmails: cachedMailbox.hasMoreEmails,
          selectedEmailId: null,
          selectedEmail: null,
          selectedEmailSource: null,
          selectedThread: null,
          selectedEmailIds: new Set(),
          loading: false,
          loadingMore: false,
        });
        get().updateSortedEmails();
        useSettingsStore.getState().setLastMailbox(accountId, mailbox);

        // Fire-and-forget background refresh
        get().activateAccount(accountId, mailbox, { _backgroundRefresh: true }).catch(() => {});
        activationTrace.end('mailbox-cache-hit');
        return;
      }
    }

    // ── Reset state for fresh load ──
    _chatEmailsFingerprint = '';
    _threadsFingerprint = '';
    _loadEmailsRetried = false;

    const isBackgroundRefresh = options._backgroundRefresh === true;

    if (!isBackgroundRefresh) {
      set({
        activeAccountId: accountId,
        activeMailbox: mailbox,
        unifiedInbox: false,
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

    // Create UidMap for this activation
    const uidMap = new UidMap(null);

    // ── Load mailboxes (local + server in parallel) ──
    // Starts the server fetch as a background promise; local cache applied immediately.
    const mbResult = await loadMailboxes(accountId, account, mailbox, signal, { isBackgroundRefresh });
    if (!mbResult || signal.aborted) return;
    const { effectiveMailbox: resolvedMailbox, serverMailboxesPromise } = mbResult;

    // ── Stream 1: Local data (cache + disk) ──
    const loadLocalEmails = async () => {
      if (signal.aborted) return;
      const localTrace = createPerfTrace('loadLocal', { accountId, mailbox: resolvedMailbox });

      try {
        const effectiveMailbox = resolvedMailbox;

        // Load partial cached headers (200 most recent) + saved/archived IDs in parallel
        const [cachedHeaders, archivedEmailIds, savedEmailIds] = await Promise.all([
          db.getEmailHeadersPartial(accountId, effectiveMailbox, 200),
          db.getArchivedEmailIds(accountId, effectiveMailbox),
          db.getSavedEmailIds(accountId, effectiveMailbox),
        ]);
        if (signal.aborted) return;
        localTrace.mark('cache-loaded', {
          cachedCount: cachedHeaders?.emails?.length || 0,
          archivedCount: archivedEmailIds.size,
          savedCount: savedEmailIds.size,
        });

        set({ savedEmailIds, archivedEmailIds });

        // Merge cached headers into UidMap
        if (cachedHeaders && cachedHeaders.emails.length > 0) {
          const headersWithSource = cachedHeaders.emails.map(e => ({
            ...e,
            source: e.source || 'cache',
            isLocal: savedEmailIds.has(e.uid),
            isArchived: archivedEmailIds.has(e.uid),
          }));
          uidMap.merge(headersWithSource);

          // Store uidValidity from cache for server stream to validate
          if (cachedHeaders.uidValidity != null) {
            uidMap.checkUidValidity(cachedHeaders.uidValidity);
          }

          // First paint: show cached data immediately
          commitToStore(uidMap, signal, accountId, {
            loading: false,
            loadingMore: true,
            totalEmails: cachedHeaders.totalEmails || cachedHeaders.emails.length,
            hasMoreEmails: cachedHeaders.emails.length < (cachedHeaders.totalEmails || cachedHeaders.emails.length),
            currentPage: Math.ceil(cachedHeaders.emails.length / 200) || 1,
            ...(cachedHeaders.serverUids ? { serverUidSet: cachedHeaders.serverUids } : {}),
          });
          localTrace.mark('first-paint', { emailCount: cachedHeaders.emails.length });

          // Update unread count from cache for instant sidebar badge
          if (resolvedMailbox === 'INBOX') {
            const unread = cachedHeaders.emails.filter(e => !e.flags?.includes('\\Seen')).length;
            useSettingsStore.getState().setUnreadForAccount(accountId, unread);
          }
        } else if (!isBackgroundRefresh) {
          set({ loading: true });
        }

        // Load archived emails from disk (progressive batches)
        if (archivedEmailIds.size > 0) {
          const archivedAccount = accountId;
          db.getArchivedEmails(accountId, effectiveMailbox, archivedEmailIds, (batchEmails) => {
            if (signal.aborted || get().activeAccountId !== archivedAccount) return;
            set({ localEmails: batchEmails });
            get().updateSortedEmails();
          }).catch(e => console.warn('[activateAccount] getArchivedEmails failed:', e));
        }

        localTrace.end('done');
      } catch (e) {
        console.warn('[activateAccount] Local stream failed (non-fatal):', e);
      }
    };

    // ── Stream 2: Server data (IMAP or Graph) ──
    const loadServerEmails = async () => {
      if (signal.aborted) return;
      const serverTrace = createPerfTrace('loadServer', { accountId, mailbox });

      try {
        // Ensure fresh OAuth2 token
        account = await ensureFreshToken(account);
        if (signal.aborted) return;
        serverTrace.mark('token-ready');

        // Check credentials
        const hasCredentials = account.password || (account.authType === 'oauth2' && account.oauth2AccessToken);
        if (!hasCredentials) {
          // Try keychain
          try {
            const freshAccount = await db.getAccount(accountId);
            if (freshAccount && (freshAccount.password || (freshAccount.authType === 'oauth2' && freshAccount.oauth2AccessToken))) {
              account = freshAccount;
              const updatedAccounts = get().accounts.map(a => a.id === accountId ? { ...a, ...freshAccount } : a);
              set({ accounts: updatedAccounts });
            }
          } catch (e) {
            console.warn('[activateAccount] Keychain fetch failed:', e);
          }

          const hasCredsNow = account.password || (account.authType === 'oauth2' && account.oauth2AccessToken);
          if (!hasCredsNow) {
            if (!signal.aborted) {
              set({
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
        }

        // Check network connectivity
        const invoke = window.__TAURI__?.core?.invoke;
        if (invoke) {
          try {
            const isOnline = await invoke('check_network_connectivity');
            if (signal.aborted) return;
            if (isOnline === false) {
              set({
                connectionStatus: 'error',
                connectionError: 'No internet connection. Showing cached and locally archived emails.',
                connectionErrorType: 'offline',
                loading: false,
                loadingMore: false,
              });
              serverTrace.end('offline');
              return;
            }
          } catch (e) {
            if (signal.aborted) return;
            set({
              connectionStatus: 'error',
              connectionError: 'Could not check internet connection. Showing cached and locally archived emails.',
              connectionErrorType: 'offline',
              loading: false,
              loadingMore: false,
            });
            serverTrace.end('connectivity-check-failed');
            return;
          }
        } else if (!navigator.onLine) {
          set({
            connectionStatus: 'error',
            connectionError: 'No internet connection. Showing cached and locally archived emails.',
            connectionErrorType: 'offline',
            loading: false,
            loadingMore: false,
          });
          serverTrace.end('browser-offline');
          return;
        }

        const effectiveMailbox = get().activeMailbox;

        // ── Graph API path ──
        if (isGraphAccount(account)) {
          await _loadServerEmailsViaGraph(account, accountId, effectiveMailbox, uidMap, signal, serverTrace);
          return;
        }

        // ── IMAP path ──
        // Get cache metadata for delta-sync
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
          // Delta-sync: check mailbox status first
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

          // UIDVALIDITY changed — cache is invalid
          if (newUidValidity !== cachedUidValidity) {
            console.log('[activateAccount] UIDVALIDITY changed (%d → %d), full reload', cachedUidValidity, newUidValidity);
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
            // 2-tier CONDSTORE: nothing changed (modseq+uidNext same) → zero IMAP calls
            newHighestModseq != null && cachedHighestModseq != null &&
            newHighestModseq === cachedHighestModseq &&
            newUidNext === cachedUidNext
          ) {
            console.log('[activateAccount] CONDSTORE: nothing changed');
            set({
              connectionStatus: 'connected',
              connectionError: null,
              connectionErrorType: null,
              loading: false,
              loadingMore: false,
              totalEmails: serverTotal,
            });
            get().updateSortedEmails();

            // If store is partial, continue pagination
            if (uidMap.size < serverTotal) {
              set({ hasMoreEmails: true, totalEmails: serverTotal });
              if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
              _loadMoreTimer = setTimeout(() => { _loadMoreTimer = null; get().loadMoreEmails(); }, 200);
            }

            // Save to account cache
            if (!get().unifiedInbox) _saveToAccountCache(accountId, get());

            serverTrace.end('condstore-noop');
            return;
          } else if (newUidNext === cachedUidNext && serverTotal <= (cachedMeta?.totalCached ?? uidMap.size)) {
            // Non-CONDSTORE: nothing changed
            set({
              connectionStatus: 'connected',
              connectionError: null,
              connectionErrorType: null,
              loading: false,
              loadingMore: false,
              totalEmails: serverTotal,
            });
            get().updateSortedEmails();

            if (uidMap.size < serverTotal) {
              set({ hasMoreEmails: true });
              if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
              _loadMoreTimer = setTimeout(() => { _loadMoreTimer = null; get().loadMoreEmails(); }, 200);
            }

            if (!get().unifiedInbox) _saveToAccountCache(accountId, get());

            serverTrace.end('delta-noop');
            return;
          } else {
            // Something changed — full delta-sync: fetchChangedFlags + searchAllUids for new
            console.log('[activateAccount] Delta-sync: something changed');

            // Fetch changed flags if CONDSTORE available
            if (newHighestModseq != null && cachedHighestModseq != null && newHighestModseq !== cachedHighestModseq) {
              try {
                const changes = await api.fetchChangedFlags(account, effectiveMailbox, cachedHighestModseq);
                if (signal.aborted) return;
                if (changes.length > 0) {
                  const changeMap = new Map(changes.map(c => [c.uid, c.flags]));
                  // Update flags in UidMap
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

            // Search for new/deleted UIDs
            const serverUids = await api.searchAllUids(account, effectiveMailbox);
            if (signal.aborted) return;
            const serverUidSet = new Set(serverUids);
            set({ serverUidSet });

            // Find new UIDs (above cachedUidNext)
            const existingEmails = uidMap.toSortedArray();
            const storeUidSet = new Set(existingEmails.map(e => e.uid));
            const newUids = cachedUidNext
              ? serverUids.filter(uid => uid >= cachedUidNext)
              : serverUids.filter(uid => !storeUidSet.has(uid));

            // Remove deleted UIDs from UidMap
            for (const email of existingEmails) {
              if (!serverUidSet.has(email.uid)) {
                uidMap.delete(email.uid);
              }
            }

            // Fetch headers for new UIDs
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

            serverEmails = null; // Already merged into uidMap
            serverTotal = status.exists;
          }
        } else {
          // No cached sync metadata — fresh fetch
          console.log('[activateAccount] Fresh fetch: %s mailbox=%s', account.email, effectiveMailbox);
          const serverResult = await api.fetchEmails(account, effectiveMailbox, 1);
          if (signal.aborted) return;
          serverTotal = serverResult.total;

          // Get fresh status for caching
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

        // Merge server emails into UidMap (if not already merged via delta-sync)
        if (serverEmails) {
          uidMap.merge(serverEmails);
        }

        if (signal.aborted) return;

        // Merge loaded UIDs into serverUidSet
        const existingServerUidSet = get().serverUidSet;
        const sorted = uidMap.toSortedArray();
        const mergedServerUidSet = existingServerUidSet.size > 0
          ? new Set([...existingServerUidSet, ...sorted.map(e => e.uid)])
          : new Set(sorted.map(e => e.uid));

        // Second paint: update with server data
        _loadEmailsRetried = false;
        commitToStore(uidMap, signal, accountId, {
          connectionStatus: 'connected',
          connectionError: null,
          connectionErrorType: null,
          loading: false,
          loadingMore: false,
          totalEmails: serverTotal,
          hasMoreEmails: sorted.length < serverTotal,
          currentPage: Math.ceil(sorted.length / 200) || 1,
          serverUidSet: mergedServerUidSet,
        });
        serverTrace.mark('server-merged', { count: sorted.length, serverTotal });

        // Save to account cache
        if (!get().unifiedInbox) _saveToAccountCache(accountId, get());

        // Save headers to disk cache with sync metadata
        db.saveEmailHeaders(accountId, effectiveMailbox, sorted, serverTotal, {
          uidValidity: newUidValidity,
          uidNext: newUidNext,
          highestModseq: newHighestModseq ?? null,
          serverUids: get().serverUidSet,
        }).catch(e => console.warn('[activateAccount] Failed to cache headers:', e));

        // Continue loading more if partial
        if (sorted.length < serverTotal) {
          if (_loadMoreTimer) clearTimeout(_loadMoreTimer);
          _loadMoreTimer = setTimeout(() => { _loadMoreTimer = null; get().loadMoreEmails(); }, 200);
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
          errorMessage = 'OAuth2 authentication failed. Please reconnect your account in Settings.';
        } else if (error.message?.includes('password') || error.message?.includes('authentication') || error.message?.includes('No password') || error.message?.includes('Login failed') || error.message?.includes('auth failed')) {
          errorType = 'passwordMissing';
          errorMessage = 'Authentication failed. Please check your password in Settings.';
        } else if (error.message?.includes('network') || error.message?.includes('timeout') || error.message?.includes('ENOTFOUND') || error.message?.includes('ECONNREFUSED') || error.message?.includes('Server unreachable')) {
          errorType = 'offline';
          errorMessage = error.message;
        }

        if (!signal.aborted) {
          set({
            connectionStatus: 'error',
            connectionError: errorMessage,
            connectionErrorType: errorType,
          });
          get().updateSortedEmails();

          // Auto-retry once for transient errors
          const noRetry = errorType === 'passwordMissing' || errorType === 'oauthExpired' || errorType === 'outlookOAuth';
          if (!noRetry && !_loadEmailsRetried) {
            _loadEmailsRetried = true;
            setTimeout(() => {
              if (get().activeAccountId === accountId) {
                get().activateAccount(accountId, get().activeMailbox).catch(() => {});
              }
            }, 3000);
          }
        }
        serverTrace.end('error', { message: error.message });
      } finally {
        if (!signal.aborted) set({ loading: false, loadingMore: false });
      }
    };

    // Safety: clear stuck loading state after 20s
    const loadingGuard = setTimeout(() => {
      if (get().activeAccountId === accountId && get().loading) {
        console.warn('[activateAccount] Loading timeout — clearing stuck state after 20s');
        const hasEmails = get().emails.length > 0;
        set({
          loading: false,
          loadingMore: false,
          ...(!hasEmails ? {
            connectionStatus: 'error',
            connectionError: 'Loading timed out. Tap refresh to retry.',
            connectionErrorType: 'timeout',
          } : {}),
        });
      }
    }, 20000);

    try {
      // Run both streams in parallel
      await Promise.all([loadLocalEmails(), loadServerEmails()]);

      // Post-load: load sent headers + await mailbox server fetch
      if (!signal.aborted && get().activeAccountId === accountId) {
        get().loadSentHeaders(accountId);

        // Await the server mailbox fetch that loadMailboxes() started in parallel.
        // By this point it's likely already done (ran alongside email loading).
        if (serverMailboxesPromise) {
          await serverMailboxesPromise;
        }
      }
    } finally {
      clearTimeout(loadingGuard);
    }

    activationTrace.end('done', { emailCount: get().emails.length });
  },

  // ── Unified Inbox ─────────────────────────────────────────────────────────

  setUnifiedInbox: (enabled) => {
    if (enabled) {
      // Snapshot current account's INBOX emails before clearing state,
      // so loadUnifiedInbox can include them (activeMailbox will be 'UNIFIED' after set)
      const { activeAccountId, activeMailbox, emails: currentEmails } = get();
      const preUnifiedSnapshot = (activeMailbox === 'INBOX') ? { activeAccountId, emails: currentEmails } : null;

      // Save current account state to cache so loadUnifiedInbox can find it
      if (activeAccountId && activeMailbox && activeMailbox !== 'UNIFIED') {
        _saveToAccountCache(activeAccountId, get());
      }

      set({
        unifiedInbox: true,
        activeMailbox: 'UNIFIED',
        selectedEmailId: null,
        selectedEmail: null,
        selectedEmailSource: null,
        selectedThread: null,
        selectedEmailIds: new Set(),
      });
      get().loadUnifiedInbox(preUnifiedSnapshot);
    } else {
      // Abort any in-progress unified inbox loading
      if (_loadAbortController) _loadAbortController.abort();
      set({ unifiedInbox: false, loadingProgress: null });
    }
  },

  loadUnifiedInbox: async (preUnifiedSnapshot = null) => {
    const { accounts } = get();
    const { hiddenAccounts } = useSettingsStore.getState();

    // Abort any previous progressive loading
    if (_loadAbortController) _loadAbortController.abort();
    _loadAbortController = new AbortController();
    const signal = _loadAbortController.signal;

    const CHUNK_SIZE = 50;

    // Collect cached INBOX emails from all visible accounts
    // Try in-memory cache first, fall back to disk-cached headers.json
    const allEmails = [];
    const diskFetchPromises = [];

    for (const account of accounts) {
      if (hiddenAccounts[account.id]) continue;

      const cached = _getFromAccountCache(account.id);
      if (cached && cached.emails) {
        // Only include emails that were from INBOX
        if (cached.activeMailbox && cached.activeMailbox !== 'INBOX') continue;
        for (const email of cached.emails) {
          allEmails.push({
            ...email,
            _accountEmail: account.email,
            _accountId: account.id,
          });
        }
      } else {
        // No in-memory cache — read from disk (headers.json)
        diskFetchPromises.push(
          db.getEmailHeadersPartial(account.id, 'INBOX', 500).then(diskData => {
            if (!diskData || !diskData.emails) return [];
            return diskData.emails.map(email => ({
              ...email,
              _accountEmail: account.email,
              _accountId: account.id,
            }));
          }).catch(() => [])
        );
      }
    }

    // Await all disk reads in parallel
    if (diskFetchPromises.length > 0) {
      const diskResults = await Promise.all(diskFetchPromises);
      for (const emails of diskResults) {
        allEmails.push(...emails);
      }
    }

    if (signal.aborted) return;

    // Include the pre-switch snapshot (active account's INBOX emails captured before state change)
    if (preUnifiedSnapshot && !hiddenAccounts[preUnifiedSnapshot.activeAccountId]) {
      const activeAccount = accounts.find(a => a.id === preUnifiedSnapshot.activeAccountId);
      if (activeAccount) {
        const existingUids = new Set(allEmails.map(e => `${e._accountId}:${e.uid}`));
        for (const email of preUnifiedSnapshot.emails) {
          const key = `${preUnifiedSnapshot.activeAccountId}:${email.uid}`;
          if (!existingUids.has(key)) {
            allEmails.push({
              ...email,
              _accountEmail: activeAccount.email,
              _accountId: activeAccount.id,
            });
          }
        }
      }
    }

    // Sort by date descending
    allEmails.sort((a, b) => {
      const dateA = a.date ? new Date(a.date).getTime() : 0;
      const dateB = b.date ? new Date(b.date).getTime() : 0;
      return dateB - dateA;
    });

    // Progressive rendering: commit first chunk immediately, then background chunks
    const total = allEmails.length;
    const firstBatch = allEmails.slice(0, CHUNK_SIZE);

    // Build serverUidSet progressively
    const allServerUids = new Set();
    for (const e of firstBatch) allServerUids.add(e.uid);

    // First paint: show first chunk instantly
    set({
      emails: firstBatch,
      serverUidSet: allServerUids,
      _sortedEmailsFingerprint: '', // force updateSortedEmails to recompute
      activeMailbox: 'UNIFIED',
      totalEmails: total,
      selectedEmailId: null,
      selectedEmail: null,
      selectedEmailSource: null,
      selectedThread: null,
      selectedEmailIds: new Set(),
      hasMoreEmails: false,
      currentPage: 1,
      loading: false,
      loadingProgress: total > CHUNK_SIZE ? { loaded: Math.min(CHUNK_SIZE, total), total } : null,
    });
    get().updateSortedEmails();

    // Background: render remaining chunks progressively
    if (total > CHUNK_SIZE) {
      let offset = CHUNK_SIZE;
      while (offset < total) {
        if (signal.aborted) break;
        await new Promise(r => setTimeout(r, 0)); // yield to render

        offset += CHUNK_SIZE;
        const chunk = allEmails.slice(0, Math.min(offset, total));
        const chunkServerUids = new Set();
        for (const e of chunk) chunkServerUids.add(e.uid);

        if (signal.aborted) break;

        set({
          emails: chunk,
          serverUidSet: chunkServerUids,
          totalEmails: total,
          _sortedEmailsFingerprint: '',
          loadingProgress: { loaded: Math.min(offset, total), total },
        });
        get().updateSortedEmails();
      }
      if (!signal.aborted) set({ loadingProgress: null });
    }

    if (signal.aborted) return;

    // Load local email data for all accounts (fire-and-forget for speed)
    const allLocalEmails = [];
    const allSavedIds = new Set();
    const allArchivedIds = new Set();
    const localPromises = accounts
      .filter(a => !hiddenAccounts[a.id])
      .map(async (account) => {
        try {
          const [saved, archived] = await Promise.all([
            db.getSavedEmailIds(account.id, 'INBOX'),
            db.getArchivedEmailIds(account.id, 'INBOX'),
          ]);
          let locals = await db.readLocalEmailIndex(account.id, 'INBOX');
          if (!locals) locals = await db.getLocalEmails(account.id, 'INBOX');
          for (const uid of saved) allSavedIds.add(uid);
          for (const uid of archived) allArchivedIds.add(uid);
          for (const e of locals) {
            allLocalEmails.push({ ...e, _accountEmail: account.email, _accountId: account.id });
          }
        } catch {}
      });
    await Promise.all(localPromises);

    if (signal.aborted) return;
    set({
      localEmails: allLocalEmails,
      savedEmailIds: allSavedIds,
      archivedEmailIds: allArchivedIds,
    });
    get().updateSortedEmails();
  },

  // View mode — refresh local state from disk when switching to local view
  // so that in-progress bulk saves are reflected immediately
  setViewMode: (mode) => {
    set({ viewMode: mode });
    get().updateSortedEmails();
    if (mode === 'server') {
      // If emails array is empty (account just switched, IMAP not yet synced), trigger load
      if (get().emails.length === 0) {
        get().loadEmails();
      }
    } else if (mode === 'local' || mode === 'all') {
      // Refresh local state in background for up-to-date archive data
      if (get().unifiedInbox) {
        // Unified mode: refresh local data for all accounts
        const { accounts } = get();
        const { hiddenAccounts } = useSettingsStore.getState();
        const allLocalEmails = [];
        const allSavedIds = new Set();
        const allArchivedIds = new Set();
        Promise.all(
          accounts.filter(a => !hiddenAccounts[a.id]).map(async (account) => {
            try {
              const [saved, archived] = await Promise.all([
                db.getSavedEmailIds(account.id, 'INBOX'),
                db.getArchivedEmailIds(account.id, 'INBOX'),
              ]);
              let locals = await db.readLocalEmailIndex(account.id, 'INBOX');
              if (!locals) locals = await db.getLocalEmails(account.id, 'INBOX');
              for (const uid of saved) allSavedIds.add(uid);
              for (const uid of archived) allArchivedIds.add(uid);
              for (const e of locals) {
                allLocalEmails.push({ ...e, _accountEmail: account.email, _accountId: account.id });
              }
            } catch {}
          })
        ).then(() => {
          set({ savedEmailIds: allSavedIds, archivedEmailIds: allArchivedIds, localEmails: allLocalEmails });
          get().updateSortedEmails();
        });
      } else {
        const { activeAccountId, activeMailbox } = get();
        if (activeAccountId && activeMailbox) {
          (async () => {
            const [savedEmailIds, archivedEmailIds] = await Promise.all([
              db.getSavedEmailIds(activeAccountId, activeMailbox),
              db.getArchivedEmailIds(activeAccountId, activeMailbox),
            ]);
            let localEmails = await db.readLocalEmailIndex(activeAccountId, activeMailbox);
            if (!localEmails) localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);
            set({ savedEmailIds, archivedEmailIds, localEmails });
            get().updateSortedEmails();
          })();
        }
      }
    }
  },
  
  // Load emails
  loadEmails: async () => {
    const { activeAccountId, accounts, activeMailbox } = get();
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;
    const loadTrace = createPerfTrace('loadEmails', { accountId: activeAccountId, mailbox: activeMailbox });

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

    // CONDSTORE fast-path: if account cache is recent and has savedEmailIds, skip disk reads
    const recentCache = _getFromAccountCache(activeAccountId);
    const cacheIsFresh = recentCache && recentCache.lastSyncTimestamp && (Date.now() - recentCache.lastSyncTimestamp < 5 * 60 * 1000);
    const storeHasIds = get().savedEmailIds.size > 0;

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
      const partialHeaders = await db.getEmailHeadersPartial(activeAccountId, activeMailbox, 200);
      if (isStale()) return;

      if (partialHeaders && partialHeaders.emails.length > 0) {
        const emailsByIndex = new Map();
        partialHeaders.emails.forEach((email, idx) => {
          emailsByIndex.set(idx, {
            ...email,
            isLocal: savedEmailIds.has(email.uid),
            source: email.source || 'server'
          });
        });
        set({
          emails: partialHeaders.emails,
          emailsByIndex,
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
        emailsByIndex: new Map(),
        loadedRanges: [],
        loadingRanges: new Set(),
        emails: []
      });
      get().updateSortedEmails();
      loadTrace.mark('fresh-empty-state-rendered');
    }

    // Keep previous/cached emails for degraded modes (password missing, offline)
    const previousEmails = get().emails;

    // Check if credentials are missing — try keychain before showing error
    let hasCredentials = account.password || (account.authType === 'oauth2' && account.oauth2AccessToken);
    if (!hasCredentials) {
      console.log('[loadEmails] Credentials not in store, trying keychain for', account.email);
      try {
        const freshAccount = await db.getAccount(activeAccountId);
        if (freshAccount && (freshAccount.password || (freshAccount.authType === 'oauth2' && freshAccount.oauth2AccessToken))) {
          account = freshAccount;
          hasCredentials = true;
          const updatedAccounts = get().accounts.map(a => a.id === activeAccountId ? { ...a, ...freshAccount } : a);
          set({ accounts: updatedAccounts });
        }
      } catch (e) {
        console.warn('[loadEmails] Keychain fetch failed:', e);
      }
    }
    if (!hasCredentials) {
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
          console.log('[loadEmails] UIDVALIDITY changed (%d → %d), full reload', cachedUidValidity, newUidValidity);
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
          newHighestModseq != null && cachedHighestModseq != null &&
          newHighestModseq === cachedHighestModseq &&
          newUidNext === cachedUidNext
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
          // CONDSTORE flag-only sync: uidNext same but modseq changed → only flags changed
          // No serverTotal check needed — uidNext unchanged guarantees no new messages
          newHighestModseq != null && cachedHighestModseq != null &&
          newHighestModseq !== cachedHighestModseq &&
          newUidNext === cachedUidNext
        ) {
          console.log('[loadEmails] CONDSTORE: flag-only sync (modseq %s → %s)', cachedHighestModseq, newHighestModseq);
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
        } else if (newUidNext === cachedUidNext && serverTotal <= (cachedHeaders?.totalCached ?? existingEmails.length)) {
          // Nothing changed (non-CONDSTORE path) — skip all IMAP fetching
          // Compare against totalCached (not store length) since store may only have partial data from QuickLoad
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

      // Build sparse index
      const emailsByIndex = new Map();
      mergedEmails.forEach((email, idx) => {
        emailsByIndex.set(idx, email);
      });

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
        emailsByIndex,
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
        _saveToAccountCache(activeAccountId, get());
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
        errorMessage = 'OAuth2 authentication failed. Please reconnect your account in Settings.';
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

        // Auto-retry once for transient errors (not auth/credential issues)
        const noRetry = errorType === 'passwordMissing' || errorType === 'oauthExpired' || errorType === 'outlookOAuth';
        if (!noRetry && !_loadEmailsRetried) {
          console.log('[loadEmails] Auto-retrying after transient error in 3s...');
          _loadEmailsRetried = true;
          setTimeout(() => {
            if (get().activeAccountId === activeAccountId) {
              get().loadEmails().catch(() => {});
            }
          }, 3000);
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
      const shouldRefreshMailboxes = !shouldUseFreshMailboxCache(cachedMailboxEntry) || !cachedTarget;

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

      // 4. Build UID → Graph message ID mapping
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

      // 6. Build sparse index
      const emailsByIndex = new Map();
      mergedEmails.forEach((email, idx) => {
        emailsByIndex.set(idx, email);
      });

      const serverTotal = mergedEmails.length; // Graph doesn't give a total independent of results
      const hasMoreEmails = !!result.nextLink;

      set({
        emails: mergedEmails,
        emailsByIndex,
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
        _saveToAccountCache(activeAccountId, get());
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
  _loadMoreRetryDelay: 0,
  _loadMorePausedOffline: false,

  loadMoreEmails: async () => {
    const { activeAccountId, accounts, activeMailbox, emails, currentPage, hasMoreEmails, loadingMore } = get();
    let account = accounts.find(a => a.id === activeAccountId);

    // Don't load if already loading, no more emails, or no account
    if (!account || loadingMore || !hasMoreEmails) return;

    account = await ensureFreshToken(account);

    // Don't load more if credentials are missing (support both password and OAuth2)
    const hasCredentials = account.password || (account.authType === 'oauth2' && account.oauth2AccessToken);
    if (!hasCredentials) return;

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
        console.warn(`[loadMoreEmails] Mailbox total changed (${previousTotal} → ${serverResult.total}), restarting pagination`);
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
          _saveToAccountCache(activeAccountId, get());
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
    const { activeAccountId, accounts, activeMailbox, emailsByIndex, loadedRanges, loadingRanges, savedEmailIds } = get();
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
        console.warn(`[loadEmailRange] Mailbox total changed (${previousTotal} → ${result.total}), restarting`);
        const loadingRangesAfter = new Set(get().loadingRanges);
        loadingRangesAfter.delete(rangeKey);
        set({ loadingRanges: loadingRangesAfter });
        get().loadEmails();
        return;
      }

      if (result.emails && result.emails.length > 0) {
        const newEmailsByIndex = new Map(get().emailsByIndex);

        for (const email of result.emails) {
          newEmailsByIndex.set(email.displayIndex, {
            ...email,
            isLocal: savedEmailIds.has(email.uid),
            source: 'server'
          });
        }

        // Merge loaded range with existing ranges
        const newLoadedRanges = [...get().loadedRanges, { start: startIndex, end: endIndex }];
        // Sort and merge overlapping ranges
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

        // Update emails array from sparse map for compatibility — O(loaded) not O(total)
        const emailsArray = Array.from(newEmailsByIndex.entries())
          .sort(([a], [b]) => a - b)
          .map(([, v]) => v);

        const loadingRangesAfter = new Set(get().loadingRanges);
        loadingRangesAfter.delete(rangeKey);
        // Expand serverUidSet with newly loaded range UIDs
        const rangeServerUidSet = new Set(get().serverUidSet);
        for (const e of result.emails) rangeServerUidSet.add(e.uid);

        set({
          emailsByIndex: newEmailsByIndex,
          loadedRanges: mergedRanges,
          loadingRanges: loadingRangesAfter,
          emails: emailsArray,
          totalEmails: result.total,
          serverUidSet: rangeServerUidSet
        });

        get().updateSortedEmails();

        // Cache the updated emails
        db.saveEmailHeaders(activeAccountId, activeMailbox, emailsArray, result.total)
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

  // Get email at specific index (returns null if not loaded)
  getEmailAtIndex: (index) => {
    const { emailsByIndex } = get();
    return emailsByIndex.get(index) || null;
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
    const fp = `${viewMode}-${sortedEmails.length}-${sortedEmails[0]?.uid || 0}-${sortedEmails[sortedEmails.length - 1]?.uid || 0}-${sentEmails.length}-${sentEmails[0]?.uid || 0}-${_flagChangeCounter}-${archivedEmailIds.size}`;
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
      merged.push({ ...email, _fromSentFolder: true });
    }

    for (const e of merged) {
      if (e._ts === undefined) e._ts = new Date(e.date || e.internalDate || 0).getTime();
    }
    merged.sort((a, b) => b._ts - a._ts);

    _chatEmailsCache = merged;
    _chatEmailsFingerprint = fp;
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

  // Select a thread (shows all emails in the thread in the viewer)
  selectThread: (thread) => {
    set({
      selectedThread: thread,
      selectedEmailId: thread.lastEmail.uid,
      selectedEmail: null,
      selectedEmailSource: null,
      loadingEmail: false,
    });
  },

  // Pre-fetch adjacent email bodies for instant navigation
  _prefetchAdjacentEmails: async (currentUid) => {
    const { sortedEmails, activeAccountId, activeMailbox, emailCache } = get();
    const isUnified = activeMailbox === 'UNIFIED';
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;
    const currentIndex = sortedEmails.findIndex(e => e.uid === currentUid);
    if (currentIndex < 0) return;

    // Pre-fetch next 3 emails
    for (let i = 1; i <= 3; i++) {
      const nextEmail = sortedEmails[currentIndex + i];
      if (!nextEmail) break;

      // In unified mode, resolve per-email account context
      const prefetchAccountId = (isUnified && nextEmail._accountId) ? nextEmail._accountId : activeAccountId;
      const prefetchMailbox = isUnified ? 'INBOX' : activeMailbox;
      const cacheKey = `${prefetchAccountId}-${prefetchMailbox}-${nextEmail.uid}`;
      if (emailCache.has(cacheKey)) continue; // Already cached

      try {
        // Try Maildir first (fast, local disk)
        const localEmail = await db.getLocalEmailLight(prefetchAccountId, prefetchMailbox, nextEmail.uid);
        if (localEmail && localEmail.html !== undefined) {
          get().addToCache(cacheKey, localEmail, cacheLimitMB);
          continue;
        }

        // Fallback to server fetch
        const account = get().accounts.find(a => a.id === prefetchAccountId);
        if (!account) break;

        if (isGraphAccount(account)) {
          // Graph API: fetch full message
          const graphId = getGraphMessageId(prefetchAccountId, prefetchMailbox, nextEmail.uid);
          if (!graphId) continue;
          const freshAccount = await ensureFreshToken(account);
          const graphMsg = await api.graphGetMessage(freshAccount.oauth2AccessToken, graphId);
          const email = graphMessageToEmail(graphMsg, nextEmail.uid);
          get().addToCache(cacheKey, email, cacheLimitMB);
        } else {
          // IMAP (auto-persists .eml)
          const email = await api.fetchEmailLight(account, nextEmail.uid, prefetchMailbox, prefetchAccountId);
          get().addToCache(cacheKey, email, cacheLimitMB);
        }
      } catch (e) {
        // Stop prefetch on network errors — don't waste bandwidth
        break;
      }
    }
  },

  // Select email
  selectEmail: async (uid, source = 'server', mailboxOverride = null) => {
    const state = get();
    const isUnified = state.activeMailbox === 'UNIFIED';
    const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
    const accountId = unified?.accountId || state.activeAccountId;
    const mailbox = mailboxOverride || unified?.mailbox || state.activeMailbox;
    let account = unified?.account || state.accounts.find(a => a.id === accountId);
    account = await ensureFreshToken(account);
    const cacheKey = `${accountId}-${mailbox}-${uid}`;
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;

    // Cancel any pending delayed mark-as-read from previous email
    if (_markAsReadTimer) { clearTimeout(_markAsReadTimer); _markAsReadTimer = null; }

    set({ selectedThread: null, selectedEmailId: uid, loadingEmail: true, selectedEmail: null, selectedEmailSource: source });

    try {
      let email;
      let actualSource = source;

      // 1. Check in-memory cache first (also updates LRU timestamp)
      const cachedEmail = get().getFromCache(cacheKey);
      if (cachedEmail) {
        set({ selectedEmail: cachedEmail, selectedEmailSource: source, loadingEmail: false });
        return;
      }

      // 2. Check Maildir for cached .eml file (light — no attachment binaries or rawSource)
      const localEmail = await db.getLocalEmailLight(accountId, mailbox, uid);

      if (source === 'local-only' || (localEmail && localEmail.html !== undefined)) {
        email = localEmail;
        actualSource = source === 'local-only' ? 'local-only' : 'local';
        get().addToCache(cacheKey, email, cacheLimitMB);
      } else if (account && isGraphAccount(account)) {
        // 3a. Graph API: fetch full message by Graph message ID
        const freshAccount = await ensureFreshToken(account);
        const token = freshAccount.oauth2AccessToken;
        let graphId = getGraphMessageId(accountId, mailbox, uid);

        // If graphIdMap is stale (e.g. after app restart), rebuild it by re-fetching headers
        if (!graphId) {
          console.log('[selectEmail] Graph ID not found for UID', uid, '— rebuilding map');
          try {
            const folders = await api.graphListFolders(token);
            const folder = folders.find(f => {
              const normalized = normalizeGraphFolderName(f.displayName);
              return normalized === mailbox || f.displayName === mailbox;
            });
            if (folder) {
              const { graphMessageIds } = await api.graphListMessages(token, folder.id, 200, 0);
              const uidMap = new Map();
              graphMessageIds.forEach((gid, i) => uidMap.set(i + 1, gid));
              _setGraphIdMap(accountId, mailbox, uidMap);
              graphId = uidMap.get(uid);
            }
          } catch (e) {
            console.warn('[selectEmail] Failed to rebuild Graph ID map:', e);
          }
        }

        if (graphId) {
          // Fast path: fetch JSON body from Graph API (instant display)
          const graphMsg = await api.graphGetMessage(token, graphId);
          email = graphMessageToEmail(graphMsg, uid);
          actualSource = 'server';
          get().addToCache(cacheKey, email, cacheLimitMB);

          // Background: download full MIME and save .eml to disk for offline access
          api.graphCacheMime(token, graphId, accountId, mailbox, uid)
            .catch(e => console.warn('[selectEmail] Background MIME cache failed:', e));

          // Mark as read on server
          const markAsReadMode = useSettingsStore.getState().markAsReadMode;
          if (markAsReadMode !== 'manual' && !email.flags?.includes('\\Seen')) {
            const doMark = async () => {
              try {
                await api.graphSetRead(token, graphId, true);
                // Update the selected email's flags in state
                set(state => {
                  const sel = state.selectedEmail;
                  if (sel && sel.uid === uid && !sel.flags?.includes('\\Seen')) {
                    return { selectedEmail: { ...sel, flags: [...(sel.flags || []), '\\Seen'] } };
                  }
                  return {};
                });
              } catch (e) {
                console.warn('[selectEmail] Graph mark as read failed:', e);
              }
            };
            if (markAsReadMode === 'delay') {
              const delay = useSettingsStore.getState().markAsReadDelay || 3;
              if (_markAsReadTimer) clearTimeout(_markAsReadTimer);
              _markAsReadTimer = setTimeout(doMark, delay * 1000);
            } else {
              await doMark();
              email = { ...email, flags: [...(email.flags || []), '\\Seen'] };
            }
          }
        } else {
          console.warn('[selectEmail] No Graph message ID found for UID', uid);
        }
      } else if (account) {
        // 3b. IMAP: Fetch from server (light — saves full .eml to Maildir in Rust background)
        email = await api.fetchEmailLight(account, uid, mailbox, accountId);
        actualSource = 'server';
        get().addToCache(cacheKey, email, cacheLimitMB);

        // Update saved IDs (the light IMAP fetch auto-persists to Maildir in Rust)
        try {
          const savedEmailIds = await db.getSavedEmailIds(accountId, mailbox);
          set({ savedEmailIds });
        } catch (e) {
          console.warn('[selectEmail] Failed to update saved IDs:', e);
        }

        // Mark as read on server
        const markAsReadMode = useSettingsStore.getState().markAsReadMode;
        if (markAsReadMode !== 'manual' && !email.flags?.includes('\\Seen')) {
          const doMark = async () => {
            try {
              await api.updateEmailFlags(account, uid, ['\\Seen'], 'add', mailbox);
              // Update the selected email's flags in state
              set(state => {
                const sel = state.selectedEmail;
                if (sel && sel.uid === uid && !sel.flags?.includes('\\Seen')) {
                  return { selectedEmail: { ...sel, flags: [...(sel.flags || []), '\\Seen'] } };
                }
                return {};
              });
            } catch (e) {
              console.warn('Failed to mark as read:', e);
            }
          };
          if (markAsReadMode === 'delay') {
            const delay = useSettingsStore.getState().markAsReadDelay || 3;
            if (_markAsReadTimer) clearTimeout(_markAsReadTimer);
            _markAsReadTimer = setTimeout(doMark, delay * 1000);
          } else {
            await doMark();
            email = { ...email, flags: [...(email.flags || []), '\\Seen'] };
          }
        }
      }

      // Update hasAttachments on the list item based on real (non-inline) attachments
      const hasReal = hasRealAttachments(email);
      set(state => {
        const newEmailsByIndex = new Map(state.emailsByIndex);
        for (const [idx, e] of newEmailsByIndex) {
          if (e.uid === uid) {
            newEmailsByIndex.set(idx, { ...e, hasAttachments: hasReal });
            break;
          }
        }
        return {
          selectedEmail: email,
          selectedEmailSource: actualSource,
          emails: state.emails.map(e => e.uid === uid ? { ...e, hasAttachments: hasReal } : e),
          emailsByIndex: newEmailsByIndex,
        };
      });
    } catch (error) {
      console.error('[selectEmail] Failed to load email:', error);
      console.error('[selectEmail] Error details:', { name: error.name, message: error.message, status: error.status, stack: error.stack });
      // Fallback to Maildir if server fails
      try {
        const localEmail = await db.getLocalEmailLight(accountId, mailbox, uid);
        if (localEmail) {
          set({ selectedEmail: localEmail, selectedEmailSource: 'local-only' });
        } else {
          // Final fallback: show the header-only email so user sees something
          const headerEmail = get().emails.find(e => e.uid === uid);
          if (headerEmail) {
            set({ selectedEmail: { ...headerEmail, text: headerEmail.snippet || headerEmail.subject || '' }, selectedEmailSource: 'header-only' });
          } else {
            const detail = error.message || String(error);
            set({ error: `Failed to load email (UID ${uid}, ${mailbox}): ${detail}` });
          }
        }
      } catch (fallbackError) {
        console.error('[selectEmail] Fallback also failed:', fallbackError);
        // Final fallback: show header data
        const headerEmail = get().emails.find(e => e.uid === uid);
        if (headerEmail) {
          set({ selectedEmail: { ...headerEmail, text: headerEmail.snippet || headerEmail.subject || '' }, selectedEmailSource: 'header-only' });
        } else {
          const detail = error.message || String(error);
          set({ error: `Failed to load email (UID ${uid}, ${mailbox}): ${detail}` });
        }
      }
    } finally {
      set({ loadingEmail: false });
      // Pre-fetch next 3 email bodies in background for instant navigation
      get()._prefetchAdjacentEmails(uid);
    }
  },

  // Archive email locally (save .eml with 'A' flag)
  saveEmailLocally: async (uid) => {
    const state = get();
    const isUnified = state.activeMailbox === 'UNIFIED';
    const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
    const accountId = unified?.accountId || state.activeAccountId;
    const mailbox = unified?.mailbox || state.activeMailbox;
    const account = unified?.account || state.accounts.find(a => a.id === accountId);
    if (!account) return;

    const cacheKey = `${accountId}-${mailbox}-${uid}`;
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;

    try {
      // Check if already cached in Maildir — just set archive flag
      const alreadyCached = await db.isEmailSaved(accountId, mailbox, uid);
      if (alreadyCached) {
        await db.archiveEmail(accountId, mailbox, uid);
      } else {
        // Need full email content (with rawSource) to save .eml
        const email = await api.fetchEmail(account, uid, mailbox);

        if (!email.rawSource) {
          throw new Error('Email has no raw source data');
        }

        // Store .eml with archived + seen flags
        const invoke = window.__TAURI__?.core?.invoke;
        await invoke('maildir_store', {
          accountId: accountId,
          mailbox: mailbox,
          uid: email.uid,
          rawSourceBase64: email.rawSource,
          flags: ['archived', 'seen'],
        });
      }

      // Append to local-index.json
      try {
        const emailData = get().emails?.find(e => e.uid === uid) || get().sortedEmails?.find(e => e.uid === uid);
        if (emailData) {
          const indexEntry = {
            uid: emailData.uid,
            from: emailData.from,
            to: emailData.to,
            subject: emailData.subject,
            date: emailData.date,
            flags: emailData.flags || [],
            has_attachments: emailData.hasAttachments || emailData.has_attachments || false,
            message_id: emailData.messageId || emailData.message_id || null,
            in_reply_to: emailData.inReplyTo || emailData.in_reply_to || null,
            references: emailData.references || null,
            snippet: emailData.snippet || '',
            source: 'local',
          };
          await api.appendLocalIndex(accountId, mailbox, [indexEntry]);
        }
      } catch (e) {
        console.warn('[mailStore] Failed to update local-index.json:', e);
      }

      // Update state (skip if unified — IDs are per-account, not global)
      if (!isUnified) {
        const savedEmailIds = await db.getSavedEmailIds(accountId, mailbox);
        const archivedEmailIds = await db.getArchivedEmailIds(accountId, mailbox);
        const localEmails = await db.getLocalEmails(accountId, mailbox);
        set({ savedEmailIds, archivedEmailIds, localEmails });
      }
      get().updateSortedEmails();
    } catch (error) {
      set({ error: `Failed to archive email: ${error.message}` });
      throw error;
    }
  },

  // Archive multiple emails via Rust thread (concurrent fetch + write with progress)
  saveEmailsLocally: async (uids) => {
    const { activeAccountId, accounts, activeMailbox } = get();
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;
    account = await ensureFreshToken(account);

    const invoke = window.__TAURI__?.core?.invoke;

    // Tauri available — use Rust async archive (runs on Tokio thread pool)
    if (invoke) {
      console.log('[saveEmailsLocally] Starting Tauri archive for', uids.length, 'UIDs');
      set({ bulkSaveProgress: { total: uids.length, completed: 0, errors: 0, active: true } });

      // Use module import for reliable event listening (global can be unavailable)
      let unlisten;
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen('archive-progress', (event) => {
          const p = event.payload;
          // Don't let late events overwrite final complete state
          const current = get().bulkSaveProgress;
          if (current && !current.active) return;

          set({ bulkSaveProgress: { total: p.total, completed: p.completed, errors: p.errors, active: p.active } });

          // Incrementally update archive icon as each email is archived
          if (p.lastUid) {
            const { archivedEmailIds } = get();
            if (!archivedEmailIds.has(p.lastUid)) {
              const updated = new Set(archivedEmailIds);
              updated.add(p.lastUid);
              set({ archivedEmailIds: updated });
              get().updateSortedEmails();
            }
          }
        });
      } catch (e) {
        console.warn('[saveEmailsLocally] Failed to register event listener:', e);
      }

      try {
        const result = await invoke('archive_emails', {
          accountId: activeAccountId,
          accountJson: JSON.stringify(account),
          mailbox: activeMailbox,
          uids,
        });

        // Stop listening BEFORE setting final state — prevents late-delivered
        // Tauri events from overwriting active:false back to active:true
        if (unlisten) { unlisten(); unlisten = null; }

        // Set final progress from invoke return value (don't rely on async event delivery)
        console.log('[saveEmailsLocally] invoke result:', JSON.stringify(result));
        const finalProgress = { total: result?.total ?? uids.length, completed: result?.completed ?? uids.length, errors: result?.errors ?? 0, active: false };
        console.log('[saveEmailsLocally] Setting final progress:', JSON.stringify(finalProgress));
        set({ bulkSaveProgress: finalProgress });

        // Refresh local state after all writes complete
        const savedEmailIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);
        const archivedEmailIds = await db.getArchivedEmailIds(activeAccountId, activeMailbox);
        let localEmails = await db.readLocalEmailIndex(activeAccountId, activeMailbox);
        if (!localEmails) localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);
        set({ savedEmailIds, archivedEmailIds, localEmails });
        get().updateSortedEmails();
      } catch (err) {
        console.error('[saveEmailsLocally] archive_emails failed:', err);
        // Ensure toast shows error state even on failure
        set({ bulkSaveProgress: { total: uids.length, completed: 0, errors: uids.length, active: false } });
      } finally {
        if (unlisten) unlisten();
      }
      return;
    }

    // Fallback for dev mode (no Tauri) — serial JS fetch + save
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;
    set({ bulkSaveProgress: { total: uids.length, completed: 0, errors: 0, active: true } });

    const emails = [];
    let completed = 0;
    let errors = 0;

    for (const uid of uids) {
      // Check if cancelled (cancelArchive sets bulkSaveProgress to null)
      if (!get().bulkSaveProgress) break;

      const cacheKey = `${activeAccountId}-${activeMailbox}-${uid}`;
      try {
        let email;
        // Cache may not have rawSource (stripped for memory), always fetch fresh for save
        email = await api.fetchEmail(account, uid, activeMailbox);
        get().addToCache(cacheKey, email, cacheLimitMB);
        emails.push(email);
        completed++;
      } catch (error) {
        console.error(`Failed to fetch email ${uid}:`, error);
        errors++;
      }
      set({ bulkSaveProgress: { total: uids.length, completed, errors, active: true } });
    }

    // Don't update state if cancelled
    if (!get().bulkSaveProgress) return;

    if (emails.length > 0) {
      await db.saveEmails(emails, activeAccountId, activeMailbox);
      const savedEmailIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);
      const archivedEmailIds = await db.getArchivedEmailIds(activeAccountId, activeMailbox);
      const localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);
      set({ savedEmailIds, archivedEmailIds, localEmails });
      get().updateSortedEmails();
    }

    set({ bulkSaveProgress: { total: uids.length, completed, errors, active: false } });
    setTimeout(() => set({ bulkSaveProgress: null }), 3000);
  },
  
  // Cancel in-progress bulk archive (Rust side) and dismiss progress
  cancelArchive: () => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) invoke('cancel_archive').catch(() => {});
    set({ bulkSaveProgress: null });
  },

  // Cancel/dismiss bulk save progress
  dismissBulkProgress: () => {
    set({ bulkSaveProgress: null });
  },
  setExportProgress: (progress) => {
    set({ exportProgress: progress });
  },
  dismissExportProgress: () => {
    set({ exportProgress: null });
  },
  
  // Remove local email
  removeLocalEmail: async (uid) => {
    const state = get();
    const isUnified = state.activeMailbox === 'UNIFIED';
    const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
    const accountId = unified?.accountId || state.activeAccountId;
    const mailbox = unified?.mailbox || state.activeMailbox;
    const selectedEmailId = state.selectedEmailId;
    const localId = `${accountId}-${mailbox}-${uid}`;

    await db.deleteLocalEmail(localId);

    // Remove from local-index.json
    try {
      await api.removeFromLocalIndex(accountId, mailbox, uid);
    } catch (e) {
      console.warn('[mailStore] Failed to remove from local-index.json:', e);
    }

    const savedEmailIds = await db.getSavedEmailIds(accountId, mailbox);
    const archivedEmailIds = await db.getArchivedEmailIds(accountId, mailbox);
    const localEmails = await db.getLocalEmails(accountId, mailbox);

    // Clear selection if we deleted the selected email
    if (selectedEmailId === uid) {
      set({ savedEmailIds, archivedEmailIds, localEmails, selectedEmailId: null, selectedEmail: null, selectedEmailSource: null, selectedThread: null });
    } else {
      set({ savedEmailIds, archivedEmailIds, localEmails });
    }
    get().updateSortedEmails();
  },
  
  // Delete email from server
  deleteEmailFromServer: async (uid, { skipRefresh = false } = {}) => {
    const state = get();
    const isUnified = state.activeMailbox === 'UNIFIED';
    const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
    const accountId = unified?.accountId || state.activeAccountId;
    const mailbox = unified?.mailbox || state.activeMailbox;
    let account = unified?.account || state.accounts.find(a => a.id === accountId);
    const selectedEmailId = state.selectedEmailId;
    if (!account) return;
    account = await ensureFreshToken(account);

    if (isGraphAccount(account)) {
      const graphId = getGraphMessageId(accountId, mailbox, uid);
      if (!graphId) throw new Error('Cannot delete: no Graph message ID found for this email.');
      await api.graphDeleteMessage(account.oauth2AccessToken, graphId);
    } else {
      await api.deleteEmail(account, uid, mailbox);
    }

    // Immediately remove from emails and sentEmails arrays
    const filteredEmails = get().emails.filter(e => e.uid !== uid);
    const filteredSent = get().sentEmails.filter(e => e.uid !== uid);
    const newTotal = Math.max(0, (get().totalEmails || 0) - 1);
    const updates = {
      emails: filteredEmails,
      sentEmails: filteredSent,
      totalEmails: newTotal,
    };
    if (selectedEmailId === uid) {
      updates.selectedEmailId = null;
      updates.selectedEmail = null;
      updates.selectedEmailSource = null;
      updates.selectedThread = null;
    }
    set(updates);
    get().updateSortedEmails();

    // Update cached headers on disk so loadEmails doesn't restore the deleted email
    if (!isUnified) {
      await db.saveEmailHeaders(accountId, mailbox, filteredEmails, newTotal);
    }

    // Background refresh to sync with server (skip during batch operations)
    if (!skipRefresh && !isUnified) get().loadEmails();
  },
  
  // Move emails to a different mailbox/folder
  moveEmails: async (uids, targetMailbox) => {
    const state = get();
    const isUnified = state.activeMailbox === 'UNIFIED';
    const selectedEmailId = state.selectedEmailId;

    if (isUnified) {
      // In unified mode, group UIDs by account and move each group separately
      const groups = new Map(); // accountId → { account, uids, mailbox }
      for (const uid of uids) {
        const ctx = _resolveUnifiedContext(uid, state);
        if (!ctx) continue;
        if (!groups.has(ctx.accountId)) groups.set(ctx.accountId, { account: ctx.account, mailbox: ctx.mailbox, uids: [] });
        groups.get(ctx.accountId).uids.push(uid);
      }
      for (const [, group] of groups) {
        const freshAccount = await ensureFreshToken(group.account);
        await api.moveEmails(freshAccount, group.uids, group.mailbox, targetMailbox);
      }
    } else {
      const { activeAccountId, accounts, activeMailbox, mailboxes } = state;
      let account = accounts.find(a => a.id === activeAccountId);
      if (!account) return;
      account = await ensureFreshToken(account);

      if (isGraphAccount(account)) {
        const messageIds = uids
          .map(uid => getGraphMessageId(activeAccountId, activeMailbox, uid))
          .filter(Boolean);
        if (messageIds.length === 0) throw new Error('Cannot move: no Graph message IDs found for selected emails.');

        const targetFolder = mailboxes.find(m => m.path === targetMailbox || m.name === targetMailbox);
        if (!targetFolder || !targetFolder._graphFolderId) {
          throw new Error(`Cannot move: target folder "${targetMailbox}" not found.`);
        }

        await api.graphMoveEmails(account.oauth2AccessToken, messageIds, targetFolder._graphFolderId);
      } else {
        await api.moveEmails(account, uids, activeMailbox, targetMailbox);
      }
    }

    // Remove moved emails from current view
    const uidSet = new Set(uids);
    const filteredEmails = get().emails.filter(e => !uidSet.has(e.uid));
    const newTotal = Math.max(0, (get().totalEmails || 0) - uids.length);
    const updates = {
      emails: filteredEmails,
      totalEmails: newTotal,
      selectedEmailIds: new Set(), // clear multi-selection
    };

    // Clear single-selection if the selected email was moved
    if (uidSet.has(selectedEmailId)) {
      updates.selectedEmailId = null;
      updates.selectedEmail = null;
      updates.selectedEmailSource = null;
      updates.selectedThread = null;
    }
    set(updates);

    // Update cached headers on disk
    await db.saveEmailHeaders(activeAccountId, activeMailbox, filteredEmails, newTotal);

    // Invalidate caches for both source and target mailboxes
    _invalidateMailboxCache(activeAccountId);

    // Background refresh to sync with server
    get().loadEmails();
  },

  // Mark email as read/unread
  markEmailReadStatus: async (uid, read) => {
    const state = get();
    const isUnified = state.activeMailbox === 'UNIFIED';
    const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
    const accountId = unified?.accountId || state.activeAccountId;
    const mailbox = unified?.mailbox || state.activeMailbox;
    let account = unified?.account || state.accounts.find(a => a.id === accountId);
    if (!account) return;
    account = await ensureFreshToken(account);

    try {
      // Route through Graph API or IMAP depending on account transport
      if (isGraphAccount(account)) {
        const graphId = getGraphMessageId(accountId, mailbox, uid);
        if (graphId) {
          await api.graphSetRead(account.oauth2AccessToken, graphId, read);
        } else {
          console.warn('[markEmailReadStatus] No Graph message ID for UID', uid);
        }
      } else {
        await api.updateEmailFlags(
          account,
          uid,
          ['\\Seen'],
          read ? 'add' : 'remove',
          mailbox
        );
      }

      // Bump flag change counter so updateSortedEmails and thread caches detect the change
      _flagChangeCounter++;

      // Update local state
      set(state => {
        // Update in emails list
        const emails = state.emails.map(e => {
          if (e.uid === uid) {
            const newFlags = read
              ? [...(e.flags || []), '\\Seen'].filter((f, i, a) => a.indexOf(f) === i)
              : (e.flags || []).filter(f => f !== '\\Seen');
            return { ...e, flags: newFlags };
          }
          return e;
        });

        // Update selected email if it's the same
        let updatedSelectedEmail = state.selectedEmail;
        if (state.selectedEmail?.uid === uid) {
          const newFlags = read
            ? [...(state.selectedEmail.flags || []), '\\Seen'].filter((f, i, a) => a.indexOf(f) === i)
            : (state.selectedEmail.flags || []).filter(f => f !== '\\Seen');
          updatedSelectedEmail = { ...state.selectedEmail, flags: newFlags };
        }

        return { emails, selectedEmail: updatedSelectedEmail, _flagSeq: state._flagSeq + 1 };
      });
      get().updateSortedEmails();
      // Update per-account unread count (persisted in settingsStore)
      if (mailbox === 'INBOX') {
        const unread = get().emails.filter(e => !e.flags?.includes('\\Seen')).length;
        useSettingsStore.getState().setUnreadForAccount(accountId, unread);
      }
    } catch (error) {
      set({ error: `Failed to update read status: ${error.message}` });
    }
  },

  // Selection management
  toggleEmailSelection: (uid) => {
    set(state => {
      const newSelection = new Set(state.selectedEmailIds);
      if (newSelection.has(uid)) {
        newSelection.delete(uid);
      } else {
        newSelection.add(uid);
      }
      return { selectedEmailIds: newSelection };
    });
  },
  
  selectAllEmails: () => {
    const { sortedEmails } = get();
    set({ selectedEmailIds: new Set(sortedEmails.map(e => e.uid)) });
  },
  
  clearSelection: () => {
    set({ selectedEmailIds: new Set() });
  },

  // Get selection summary — thread-aware counts
  getSelectionSummary: () => {
    const { selectedEmailIds, sortedEmails } = get();
    if (selectedEmailIds.size === 0) return { threads: 0, emails: 0 };

    const threads = buildThreads(sortedEmails);
    let threadCount = 0;

    for (const [, thread] of threads) {
      const hasSelected = thread.emails.some(e => selectedEmailIds.has(e.uid));
      if (hasSelected) threadCount++;
    }

    return { threads: threadCount, emails: selectedEmailIds.size };
  },
  
  // Bulk save — clears selection immediately, archive runs in background
  saveSelectedLocally: async () => {
    const { selectedEmailIds } = get();
    if (selectedEmailIds.size === 0) return;
    const uids = Array.from(selectedEmailIds);
    set({ selectedEmailIds: new Set() });
    await get().saveEmailsLocally(uids);
  },

  // Bulk mark as read — clears selection immediately, optimistic UI update
  markSelectedAsRead: async () => {
    const state = get();
    const { selectedEmailIds, accounts } = state;
    const isUnified = state.activeMailbox === 'UNIFIED';
    if (selectedEmailIds.size === 0) return;

    const uids = Array.from(selectedEmailIds);
    // Optimistic: update UI immediately + clear selection
    set(state => ({
      emails: state.emails.map(e =>
        selectedEmailIds.has(e.uid)
          ? { ...e, flags: [...(e.flags || []), '\\Seen'].filter((f, i, a) => a.indexOf(f) === i) }
          : e
      ),
      selectedEmailIds: new Set()
    }));

    for (const uid of uids) {
      try {
        const ctx = isUnified ? _resolveUnifiedContext(uid, state) : null;
        const accountId = ctx?.accountId || state.activeAccountId;
        const mailbox = ctx?.mailbox || state.activeMailbox;
        let account = ctx?.account || accounts.find(a => a.id === accountId);
        account = await ensureFreshToken(account);
        await api.updateEmailFlags(account, uid, ['\\Seen'], 'add', mailbox);
      } catch (e) {
        console.error(`Failed to mark email ${uid} as read:`, e);
      }
    }
  },

  // Bulk mark as unread — clears selection immediately, optimistic UI update
  markSelectedAsUnread: async () => {
    const state = get();
    const { selectedEmailIds, accounts } = state;
    const isUnified = state.activeMailbox === 'UNIFIED';
    if (selectedEmailIds.size === 0) return;

    const uids = Array.from(selectedEmailIds);
    // Optimistic: update UI immediately + clear selection
    set(state => ({
      emails: state.emails.map(e =>
        selectedEmailIds.has(e.uid)
          ? { ...e, flags: (e.flags || []).filter(f => f !== '\\Seen') }
          : e
      ),
      selectedEmailIds: new Set()
    }));

    for (const uid of uids) {
      try {
        const ctx = isUnified ? _resolveUnifiedContext(uid, state) : null;
        const accountId = ctx?.accountId || state.activeAccountId;
        const mailbox = ctx?.mailbox || state.activeMailbox;
        let account = ctx?.account || accounts.find(a => a.id === accountId);
        account = await ensureFreshToken(account);
        await api.updateEmailFlags(account, uid, ['\\Seen'], 'remove', mailbox);
      } catch (e) {
        console.error(`Failed to mark email ${uid} as unread:`, e);
      }
    }
  },

  // Bulk delete from server — clears selection immediately
  deleteSelectedFromServer: async () => {
    const state = get();
    const { selectedEmailIds, accounts } = state;
    const isUnified = state.activeMailbox === 'UNIFIED';
    if (selectedEmailIds.size === 0) return;

    const uids = Array.from(selectedEmailIds);
    set({ selectedEmailIds: new Set() });

    for (const uid of uids) {
      try {
        const ctx = isUnified ? _resolveUnifiedContext(uid, state) : null;
        const accountId = ctx?.accountId || state.activeAccountId;
        const mailbox = ctx?.mailbox || state.activeMailbox;
        let account = ctx?.account || accounts.find(a => a.id === accountId);
        account = await ensureFreshToken(account);

        if (isGraphAccount(account)) {
          const graphId = getGraphMessageId(accountId, mailbox, uid);
          if (graphId) {
            await api.graphDeleteMessage(account.oauth2AccessToken, graphId);
          } else {
            console.warn(`[deleteSelectedFromServer] No Graph ID for UID ${uid}, skipping`);
          }
        } else {
          await api.deleteEmail(account, uid, mailbox);
        }
      } catch (e) {
        console.error(`Failed to delete email ${uid}:`, e);
      }
    }

    // Immediately remove deleted emails from the list so UI updates
    const deletedSet = new Set(uids);
    const filteredEmails = get().emails.filter(e => !deletedSet.has(e.uid));
    const filteredSent = get().sentEmails.filter(e => !deletedSet.has(e.uid));
    set({
      emails: filteredEmails,
      sentEmails: filteredSent,
      totalEmails: Math.max(0, (get().totalEmails || 0) - uids.length),
      selectedEmailId: deletedSet.has(get().selectedEmailId) ? null : get().selectedEmailId,
      selectedEmail: deletedSet.has(get().selectedEmailId) ? null : get().selectedEmail,
    });
    get().updateSortedEmails();

    // Background refresh to sync with server
    if (!isUnified) get().loadEmails();
  },

  // Export email
  exportEmail: async (uid) => {
    const state = get();
    const isUnified = state.activeMailbox === 'UNIFIED';
    const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
    const accountId = unified?.accountId || state.activeAccountId;
    const mailbox = unified?.mailbox || state.activeMailbox;
    const localId = `${accountId}-${mailbox}-${uid}`;
    return db.exportEmail(localId);
  },

  // Update total unread count
  setTotalUnreadCount: (count) => set({ totalUnreadCount: count }),

  // Calculate total unread count from current emails
  calculateUnreadCount: () => {
    const { emails } = get();
    const unreadCount = emails.filter(e => !e.flags?.includes('\\Seen')).length;
    set({ totalUnreadCount: unreadCount });
    return unreadCount;
  },

  // Refresh all accounts (for scheduled sync)
  refreshAllAccounts: async () => {
    const { accounts, activeAccountId } = get();
    if (accounts.length === 0) return { newEmails: 0, totalUnread: 0 };

    // Invalidate LRU caches — full refresh
    for (const account of accounts) {
      _invalidateMailboxCache(account.id);
      _invalidateAccountCache(account.id);
    }

    console.log('[mailStore] Refreshing all accounts...');

    let totalUnread = 0;
    const updatedUnreadPerAccount = { ...useSettingsStore.getState().unreadPerAccount };
    let previousEmailCount = get().emails.length;
    const perAccountResults = []; // Per-account new-email details for notification dispatch

    for (let account of accounts) {
      // Skip hidden accounts
      if (useSettingsStore.getState().isAccountHidden(account.id)) {
        console.log(`[mailStore] Skipping hidden account ${account.email}`);
        continue;
      }
      // Skip if credentials are missing (support both password and OAuth2)
      if (!hasValidCredentials(account)) {
        console.warn(`[mailStore] Skipping account ${account.email} - no credentials`);
        continue;
      }
      account = await ensureFreshToken(account);

      try {
        // If this is the active account, refresh the current mailbox
        if (account.id === activeAccountId) {
          const beforeCount = get().emails.length;
          const beforeUids = new Set(get().emails.map(e => e.uid));
          await get().loadEmails();
          // Count unread in current view
          const currentEmails = get().emails;
          const accountUnread = currentEmails.filter(e => !e.flags?.includes('\\Seen')).length;
          totalUnread += accountUnread;
          updatedUnreadPerAccount[account.id] = accountUnread;
          // Detect new emails for this account
          const afterEmails = get().emails;
          const newForAccount = afterEmails.filter(e => !beforeUids.has(e.uid));
          if (newForAccount.length > 0) {
            const newest = newForAccount[0]; // First = highest UID = newest
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
          // Graph: use Graph API for non-active account header refresh
          try {
            const token = account.oauth2AccessToken;
            const folders = await api.graphListFolders(token);
            const inbox = folders.find(f => f.displayName === 'Inbox');
            if (inbox) {
              // Load existing cached UIDs before fetching
              const cached = await db.getEmailHeaders(account.id, 'INBOX').catch(() => null);
              const cachedUids = new Set(cached?.emails?.map(e => e.uid) || []);

              const { headers } = await api.graphListMessages(token, inbox.id, 200, 0);
              if (headers.length > 0) {
                await db.saveEmailHeaders(account.id, 'INBOX', headers, inbox.totalItemCount);
                console.log(`[mailStore] Graph: cached ${headers.length} headers for ${account.email}`);
              }
              const graphUnread = headers.filter(e => !e.flags?.includes('\\Seen')).length;
              totalUnread += graphUnread;
              updatedUnreadPerAccount[account.id] = graphUnread;

              // Detect new emails
              const newHeaders = headers.filter(e => !cachedUids.has(e.uid));
              if (newHeaders.length > 0 && cachedUids.size > 0) {
                const newest = newHeaders[0];
                perAccountResults.push({
                  accountId: account.id,
                  accountEmail: account.email,
                  folder: 'INBOX',
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
          // IMAP: load full headers into cache and count unread
          try {
            // Load existing cached UIDs before fetching
            const cached = await db.getEmailHeaders(account.id, 'INBOX').catch(() => null);
            const cachedUids = new Set(cached?.emails?.map(e => e.uid) || []);

            const allEmails = [];
            let page = 1;
            let hasMore = true;
            let total = 0;

            while (hasMore) {
              const result = await api.fetchEmails(account, 'INBOX', page);
              allEmails.push(...result.emails);
              total = result.total;
              hasMore = result.hasMore;
              page++;
              if (hasMore) await new Promise(r => setTimeout(r, 1000));
            }

            if (allEmails.length > 0) {
              await db.saveEmailHeaders(account.id, 'INBOX', allEmails, total);
              console.log(`[mailStore] Cached ${allEmails.length} headers for ${account.email}`);
            }

            const imapUnread = allEmails.filter(e => !e.flags?.includes('\\Seen')).length;
            totalUnread += imapUnread;
            updatedUnreadPerAccount[account.id] = imapUnread;

            // Detect new emails
            const newHeaders = allEmails.filter(e => !cachedUids.has(e.uid));
            if (newHeaders.length > 0 && cachedUids.size > 0) {
              const newest = newHeaders[0];
              perAccountResults.push({
                accountId: account.id,
                accountEmail: account.email,
                folder: 'INBOX',
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
        // Continue with other accounts even if one fails
      }
    }

    set({ totalUnreadCount: totalUnread });
    useSettingsStore.getState().setUnreadPerAccount(updatedUnreadPerAccount);

    const newEmailCount = get().emails.length;
    const newEmails = Math.max(0, newEmailCount - previousEmailCount);

    console.log(`[mailStore] All accounts refreshed. Total unread: ${totalUnread}, New emails: ${newEmails}`);

    return { newEmails, totalUnread, perAccountResults };
  },

  // Clear error
  clearError: () => set({ error: null }),

  // Retry keychain access - attempts to fetch password from keychain again
  retryKeychainAccess: async () => {
    const { activeAccountId } = get();

    console.log('[mailStore] Retrying keychain access...');

    try {
      // Clear the locked credentials cache so loadKeychain() re-reads from OS keychain
      db.clearCredentialsCache();

      // Re-fetch all accounts with fresh credentials
      const freshAccounts = await db.getAccounts();

      if (freshAccounts.length === 0) {
        console.warn('[mailStore] No accounts found after keychain retry');
        set({
          connectionError: 'No accounts found. Please add your account in Settings.',
          connectionErrorType: 'passwordMissing'
        });
        return false;
      }

      // Check if the active account now has credentials
      const activeAccount = freshAccounts.find(a => a.id === activeAccountId);
      const hasCredentials = activeAccount && (activeAccount.password || (activeAccount.authType === 'oauth2' && activeAccount.oauth2AccessToken));

      if (!hasCredentials) {
        console.warn('[mailStore] Active account still has no credentials after keychain retry');
        set({
          accounts: freshAccounts,
          connectionError: 'Password not found. Please re-enter your password in Settings.',
          connectionErrorType: 'passwordMissing'
        });
        return false;
      }

      // Update store with credentialed accounts and clear error
      console.log('[mailStore] Keychain retry successful, reloading...');
      set({
        accounts: freshAccounts,
        connectionStatus: 'connecting',
        connectionError: null,
        connectionErrorType: null
      });

      // Reload emails with the fresh credentials via activateAccount
      const { activeMailbox } = get();
      await get().activateAccount(activeAccountId, activeMailbox || 'INBOX');
      return true;
    } catch (error) {
      console.error('[mailStore] Keychain retry failed:', error);
      set({
        connectionError: 'Could not access Keychain. Please re-enter your password in Settings.',
        connectionErrorType: 'passwordMissing'
      });
      return false;
    }
  },

}));

// Online/offline listeners for header loading pipeline
// When going offline: header loading pauses naturally (API calls will fail, backoff kicks in)
// When coming back online: resume header loading if it was in progress
window.addEventListener('online', () => {
  const state = useMailStore.getState();
  if (state._loadMorePausedOffline && state.hasMoreEmails && state.emails.length < state.totalEmails) {
    console.log('[mailStore] Back online — resuming header loading');
    useMailStore.setState({ _loadMorePausedOffline: false, _loadMoreRetryDelay: 0 });
    state.loadMoreEmails();
  }
});

window.addEventListener('offline', () => {
  console.log('[mailStore] Went offline — header loading will pause');
  useMailStore.setState({ _loadMorePausedOffline: true });
});
