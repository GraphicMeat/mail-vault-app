import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../services/db';
import * as api from '../services/api';
import { useSettingsStore } from './settingsStore';
import { hasValidCredentials, ensureFreshToken } from '../services/authUtils';
import { hasRealAttachments } from '../services/attachmentUtils';
import { buildThreads } from '../utils/emailParser';

// ── Graph transport helpers ─────────────────────────────────────────────────

function isGraphAccount(account) {
  return account?.oauth2Transport === 'graph';
}

// Module-level map: UID → Graph message ID (per account+mailbox)
// Key format: "accountId:mailbox", value: Map<uid, graphMessageId>
const _graphIdMap = new Map();

function _setGraphIdMap(accountId, mailbox, uidToGraphId) {
  _graphIdMap.set(`${accountId}:${mailbox}`, uidToGraphId);
}

export function getGraphMessageId(accountId, mailbox, uid) {
  const map = _graphIdMap.get(`${accountId}:${mailbox}`);
  return map?.get(uid) || null;
}

function _clearGraphIdMap(accountId) {
  for (const key of _graphIdMap.keys()) {
    if (key.startsWith(`${accountId}:`)) {
      _graphIdMap.delete(key);
    }
  }
}

// Map Graph API folder display names to IMAP-style names used by the app
const GRAPH_FOLDER_NAME_MAP = {
  'Inbox': 'INBOX',
  'Sent Items': 'Sent',
  'Drafts': 'Drafts',
  'Deleted Items': 'Trash',
  'Junk Email': 'Junk',
  'Archive': 'Archive',
};

function normalizeGraphFolderName(displayName) {
  return GRAPH_FOLDER_NAME_MAP[displayName] || displayName;
}

// Reverse map: app mailbox name → Graph display name (for folder ID lookup)
const APP_TO_GRAPH_FOLDER_MAP = Object.fromEntries(
  Object.entries(GRAPH_FOLDER_NAME_MAP).map(([k, v]) => [v, k])
);

// Convert Graph folder objects to MailboxInfo format matching IMAP mailbox shape
function graphFoldersToMailboxes(graphFolders) {
  return graphFolders.map(f => ({
    name: normalizeGraphFolderName(f.displayName),
    path: normalizeGraphFolderName(f.displayName),
    specialUse: inferSpecialUse(f.displayName),
    flags: [],
    delimiter: '/',
    noselect: false,
    children: [],
    _graphFolderId: f.id, // stash Graph folder ID for message fetching
  }));
}

function inferSpecialUse(displayName) {
  switch (displayName) {
    case 'Inbox': return '\\Inbox';
    case 'Sent Items': return '\\Sent';
    case 'Drafts': return '\\Drafts';
    case 'Deleted Items': return '\\Trash';
    case 'Junk Email': return '\\Junk';
    case 'Archive': return '\\Archive';
    default: return null;
  }
}

// Convert a GraphMessage (from graphGetMessage) to the email object format the UI expects
export function graphMessageToEmail(graphMsg, uid) {
  const from = graphMsg.from
    ? { name: graphMsg.from.emailAddress?.name || null, address: graphMsg.from.emailAddress?.address || '' }
    : { name: 'Unknown', address: 'unknown@unknown.com' };

  const to = (graphMsg.toRecipients || []).map(r => ({
    name: r.emailAddress?.name || null,
    address: r.emailAddress?.address || '',
  }));

  const cc = (graphMsg.ccRecipients || []).map(r => ({
    name: r.emailAddress?.name || null,
    address: r.emailAddress?.address || '',
  }));

  const flags = [];
  if (graphMsg.isRead) flags.push('\\Seen');

  const bodyType = graphMsg.body?.contentType?.toLowerCase();
  const bodyContent = graphMsg.body?.content || '';

  return {
    uid,
    seq: uid,
    subject: graphMsg.subject || '',
    from,
    to,
    cc,
    bcc: [],
    date: graphMsg.receivedDateTime || null,
    flags,
    messageId: graphMsg.internetMessageId || null,
    hasAttachments: graphMsg.hasAttachments || false,
    html: bodyType === 'html' ? bodyContent : null,
    text: bodyType === 'text' ? bodyContent : (bodyType === 'html' ? null : bodyContent),
    attachments: [],
    source: 'server',
  };
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

// Module-level loadEmails generation counter — prevents stale concurrent calls
let _loadEmailsGeneration = 0;

// Module-level range retry state — avoids polluting Zustand store with dynamic keys
const _rangeRetryDelays = new Map();

// ── Mailbox LRU cache (max 3 entries) ─────────────────────────────────
const _mailboxCache = new Map();
const MAILBOX_CACHE_MAX = 2;

function _saveToMailboxCache(accountId, mailbox, state) {
  const key = `${accountId}:${mailbox}`;
  _mailboxCache.set(key, {
    emails: state.emails,
    // sortedEmails excluded — recomputed via updateSortedEmails() on restore
    localEmails: state.localEmails,
    emailsByIndex: state.emailsByIndex,
    totalEmails: state.totalEmails,
    savedEmailIds: state.savedEmailIds,
    archivedEmailIds: state.archivedEmailIds,
    loadedRanges: state.loadedRanges,
    currentPage: state.currentPage,
    hasMoreEmails: state.hasMoreEmails,
    timestamp: Date.now(),
  });

  // LRU eviction
  if (_mailboxCache.size > MAILBOX_CACHE_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of _mailboxCache) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) _mailboxCache.delete(oldestKey);
  }
}

function _getFromMailboxCache(accountId, mailbox) {
  const key = `${accountId}:${mailbox}`;
  const cached = _mailboxCache.get(key);
  if (cached) {
    cached.timestamp = Date.now(); // Touch for LRU
  }
  return cached || null;
}

function _invalidateMailboxCache(accountId) {
  for (const key of _mailboxCache.keys()) {
    if (key.startsWith(`${accountId}:`)) {
      _mailboxCache.delete(key);
    }
  }
}

// ── Account LRU cache (max 5 entries) — instant account switching ────
const _accountCache = new Map();
const ACCOUNT_CACHE_MAX = 2;

function _saveToAccountCache(accountId, state) {
  _accountCache.set(accountId, {
    emails: state.emails,
    // sortedEmails excluded — recomputed via updateSortedEmails() on restore
    // serverUidSet excluded — re-fetched via CONDSTORE delta sync on restore
    localEmails: state.localEmails,
    emailsByIndex: state.emailsByIndex,
    totalEmails: state.totalEmails,
    savedEmailIds: state.savedEmailIds,
    archivedEmailIds: state.archivedEmailIds,
    loadedRanges: state.loadedRanges,
    currentPage: state.currentPage,
    hasMoreEmails: state.hasMoreEmails,
    sentEmails: state.sentEmails,
    mailboxes: state.mailboxes,
    connectionStatus: state.connectionStatus,
    activeMailbox: state.activeMailbox,
    lastSyncTimestamp: Date.now(),
    timestamp: Date.now(),
  });

  // LRU eviction
  if (_accountCache.size > ACCOUNT_CACHE_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of _accountCache) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) _accountCache.delete(oldestKey);
  }
}

function _getFromAccountCache(accountId) {
  const cached = _accountCache.get(accountId);
  if (cached) cached.timestamp = Date.now();
  return cached || null;
}

function _invalidateAccountCache(accountId) {
  _accountCache.delete(accountId);
}

/**
 * Returns cached emails across all accounts (for cross-account analytics).
 * Includes both the active account and any LRU-cached accounts.
 */
export function getAccountCacheEmails() {
  const result = [];
  const seen = new Set();

  for (const [accountEmail, cached] of _accountCache.entries()) {
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

  // Unified inbox mode
  unifiedInbox: false,

  // Unread counts across all accounts
  totalUnreadCount: 0,

  // Search state
  searchActive: false,
  searchQuery: '',
  searchFilters: {
    location: 'all', // 'all' | 'server' | 'local'
    folder: 'current', // 'current' | 'all' | specific folder path
    sender: '',
    dateFrom: null,
    dateTo: null,
    hasAttachments: false,
  },
  searchResults: [],
  isSearching: false,

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
    const { emails, localEmails, viewMode, savedEmailIds, archivedEmailIds, serverUidSet, _sortedEmailsFingerprint } = get();

    // Fingerprint check: skip if the input set hasn't materially changed
    const fp = `${viewMode}-${emails.length}-${emails[0]?.uid || 0}-${emails[emails.length - 1]?.uid || 0}-${localEmails.length}-${archivedEmailIds.size}-${savedEmailIds.size}-${serverUidSet.size}-${_flagChangeCounter}`;
    if (fp === _sortedEmailsFingerprint) return;

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
      const loadedUids = new Set(emails.map(e => e.uid));
      const combinedEmails = emails.map(e => ({
        ...e,
        isLocal: savedEmailIds.has(e.uid),
        isArchived: archivedEmailIds.has(e.uid),
        source: 'server'
      }));

      // Add archived local emails not yet loaded as headers.
      // Use serverUidSet to distinguish: on server but not loaded yet ('local') vs truly local-only.
      for (const localEmail of localEmails) {
        if (!loadedUids.has(localEmail.uid) && archivedEmailIds.has(localEmail.uid)) {
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
          const cachedMailboxes = await db.getCachedMailboxes(firstVisible.id);
          if (cachedMailboxes) set({ mailboxes: cachedMailboxes });

          // Auto-retry: wait for keychain to resolve, then re-init
          setTimeout(async () => {
            const { connectionErrorType: currentErrorType } = get();
            if (currentErrorType === 'passwordMissing' || !get().accounts.find(a => a.id === firstVisible.id)?.password) {
              console.log('[init] Auto-retrying keychain access...');
              await get().retryKeychainAccess();
            }
          }, 3000);
        } else if (currentActiveId === firstVisible.id) {
          // Quick-load already set this account — just refresh without resetting state
          console.log('[init] Account already active from quick-load, refreshing...');
          // Safety: if quick-load populated emails but loading is stuck, force it off
          const { emails: currentEmails, loading: currentLoading, sortedEmails: currentSorted } = get();
          console.log('[init] Current state: emails=%d, sortedEmails=%d, loading=%s', currentEmails.length, currentSorted.length, currentLoading);
          if (currentEmails.length > 0 && currentLoading) {
            console.warn('[init] Loading stuck with %d emails — forcing loading=false', currentEmails.length);
            set({ loading: false });
            if (currentSorted.length === 0) get().updateSortedEmails();
          }
          // Load cached mailboxes first (quick-load only sets placeholders)
          const cachedMailboxes = await db.getCachedMailboxes(firstVisible.id);
          console.log('[init] Cached mailboxes:', cachedMailboxes ? cachedMailboxes.length + ' folders' : 'null');
          if (cachedMailboxes) {
            set({ mailboxes: cachedMailboxes });
          }
          // Fire-and-forget: IMAP sync runs in background so init() completes promptly.
          // Quick-load already displayed cached data — this just refreshes from server.
          get().loadEmails().catch(e => console.warn('[init] loadEmails failed (non-fatal):', e.message));
          get().loadSentHeaders(firstVisible.id);
          // Fetch real mailboxes from server in parallel (non-blocking)
          ensureFreshToken(firstVisible).then(freshAccount =>
            api.fetchMailboxes(freshAccount).then(mailboxes => {
              console.log('[init] Server mailbox fetch: %d folders', mailboxes.length);
              set({ mailboxes, connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
              db.saveMailboxes(firstVisible.id, mailboxes);
            })
          ).catch(e => console.warn('[init] Mailbox fetch failed (non-fatal):', e.message));
        } else {
          await get().setActiveAccount(firstVisible.id);
        }
      }

      // Background: pre-fetch mailboxes for all other visible accounts
      get()._prefetchAllMailboxes().catch(() => {});
    } catch (error) {
      console.error('Failed to initialize:', error);
      set({ error: error.message, loading: false });
    }
  },

  // Pre-fetch mailboxes for all visible accounts (background, non-blocking)
  _prefetchAllMailboxes: async () => {
    const { accounts, activeAccountId } = get();
    const { hiddenAccounts } = useSettingsStore.getState();

    const otherAccounts = accounts.filter(a =>
      a.id !== activeAccountId && !hiddenAccounts[a.id]
    );

    if (otherAccounts.length === 0) return;
    console.log('[prefetch] Pre-fetching mailboxes for', otherAccounts.length, 'background accounts');

    await Promise.allSettled(otherAccounts.map(async (account) => {
      try {
        const freshAccount = await ensureFreshToken(account);
        let mailboxes;
        if (isGraphAccount(freshAccount)) {
          const graphFolders = await api.graphListFolders(freshAccount.oauth2AccessToken);
          mailboxes = graphFolders.map(f => ({
            name: f.displayName,
            path: f.displayName,
            specialUse: null,
            children: [],
            noselect: false,
          }));
        } else {
          mailboxes = await api.fetchMailboxes(freshAccount);
        }
        await db.saveMailboxes(account.id, mailboxes);
      } catch (e) {
        console.warn(`[prefetch] Mailbox fetch failed for ${account.email} (non-fatal):`, e.message);
      }
    }));
    console.log('[prefetch] Mailbox pre-fetch complete');
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
      throw error;
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
      await get().setActiveAccount(account.id);
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

    set({ accounts: newAccounts });
    
    if (get().activeAccountId === accountId) {
      const { hiddenAccounts } = useSettingsStore.getState();
      const nextVisible = newAccounts.find(a => !hiddenAccounts[a.id]);
      if (nextVisible) {
        await get().setActiveAccount(nextVisible.id);
      } else {
        set({
          activeAccountId: null,
          mailboxes: [],
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
  
  setActiveAccount: async (accountId) => {
    let account = get().accounts.find(a => a.id === accountId);
    if (!account) return;
    account = await ensureFreshToken(account);

    const invoke = window.__TAURI__?.core?.invoke;
    const { activeAccountId: currentAccountId, emails: currentEmails, totalEmails: currentTotalEmails } = get();

    // Check if we're switching to the same account that already has data loaded
    const isSameAccount = currentAccountId === accountId;
    const hasExistingData = currentEmails.length > 0 || currentTotalEmails > 0;

    if (isSameAccount && hasExistingData) {
      console.log('[setActiveAccount] Same account with existing data, calling loadEmails');
      await get().loadEmails();
      return;
    }

    // Save current account state to cache before switching
    if (currentAccountId && currentAccountId !== accountId && (currentEmails.length > 0 || currentTotalEmails > 0)) {
      _saveToAccountCache(currentAccountId, get());
    }

    // Check account cache for instant restore
    const cachedAccount = _getFromAccountCache(accountId);
    if (cachedAccount) {
      console.log('[setActiveAccount] Account cache HIT for', accountId, '— restoring', cachedAccount.emails.length, 'emails instantly');
      _chatEmailsFingerprint = '';
      _threadsFingerprint = '';
      set({
        activeAccountId: accountId,
        activeMailbox: cachedAccount.activeMailbox,
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
        mailboxes: cachedAccount.mailboxes,
        serverUidSet: new Set(), // Re-fetched via CONDSTORE delta sync
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

      // Fire-and-forget: silent CONDSTORE refresh in background
      get().loadEmails().catch(() => {});
      get().loadSentHeaders(accountId);
      return;
    }

    // Different account or no data - need to reset and load
    const lastMailbox = useSettingsStore.getState().getLastMailbox(accountId);
    console.log('[setActiveAccount] Switching to account:', accountId, 'mailbox:', lastMailbox);

    // Reset all email state immediately to prevent stale data from rendering
    _chatEmailsFingerprint = ''; // Invalidate module-level chat cache
    _threadsFingerprint = ''; // Invalidate module-level threads cache
    set({
      activeAccountId: accountId,
      activeMailbox: lastMailbox,
      unifiedInbox: false,
      emails: [],
      localEmails: [],
      sentEmails: [],
      sortedEmails: [],
      _sortedEmailsFingerprint: '', // Must reset alongside sortedEmails
      totalEmails: 0,
      emailsByIndex: new Map(),
      loadedRanges: [],
      loadingRanges: new Set(),
      currentPage: 1,
      hasMoreEmails: true,
      selectedEmailId: null,
      selectedEmail: null,
      selectedEmailSource: null,
      selectedThread: null,
      selectedEmailIds: new Set(),
      savedEmailIds: new Set(),
      archivedEmailIds: new Set(),
      serverUidSet: new Set(),
      connectionStatus: 'disconnected',
      connectionError: null,
      connectionErrorType: null,
      error: null
    });

    // Helper: check if this setActiveAccount call is still current
    const isStale = () => get().activeAccountId !== accountId;

    // Fast partial load: only first 200 headers from cache (~200KB instead of 16MB for large accounts).
    // Full cache loads later during loadEmails() network sync.
    const cachedHeaders = await db.getEmailHeadersPartial(accountId, lastMailbox, 200);
    if (isStale()) { console.log('[setActiveAccount] Stale after cache load, aborting'); return; }

    if (cachedHeaders && cachedHeaders.emails.length > 0) {
      console.log('[setActiveAccount] Found cached data:', cachedHeaders.emails.length, 'of', cachedHeaders.totalCached, 'emails (partial load)');
      const emailsByIndex = new Map();
      cachedHeaders.emails.forEach((email, idx) => {
        const index = email.displayIndex !== undefined ? email.displayIndex : idx;
        emailsByIndex.set(index, {
          ...email,
          source: email.source || 'server'
        });
      });

      set({
        emails: cachedHeaders.emails,
        emailsByIndex,
        loadedRanges: [{ start: 0, end: cachedHeaders.emails.length }],
        loadingRanges: new Set(),
        totalEmails: cachedHeaders.totalEmails,
        loading: false,
        loadingMore: true,
        currentPage: Math.ceil(cachedHeaders.emails.length / 200) || 1,
        hasMoreEmails: cachedHeaders.emails.length < cachedHeaders.totalEmails,
        ...(cachedHeaders.serverUids ? { serverUidSet: cachedHeaders.serverUids } : {})
      });
      get().updateSortedEmails();
      console.log('[setActiveAccount] Showing cached data, will refresh from server...');
    } else {
      set({ loading: true });
    }

    // Fire-and-forget: load saved/archived IDs, then archived email headers from disk.
    // maildir_read_light_batch is now async (tokio thread pool) so it won't freeze the UI.
    Promise.all([
      db.getSavedEmailIds(accountId, lastMailbox),
      db.getArchivedEmailIds(accountId, lastMailbox)
    ]).then(async ([savedEmailIds, archivedEmailIds]) => {
      if (isStale()) return;
      console.log('[setActiveAccount] FF: %d saved, %d archived IDs', savedEmailIds.size, archivedEmailIds.size);
      set({ savedEmailIds, archivedEmailIds });
      if (archivedEmailIds.size > 0) {
        // Progressive batch loading: each batch of 200 updates the UI immediately
        await db.getArchivedEmails(accountId, lastMailbox, archivedEmailIds, (batchEmails) => {
          if (isStale()) return;
          set({ localEmails: batchEmails });
          get().updateSortedEmails();
        });
      }
      if (!isStale()) get().updateSortedEmails();
    }).catch(e => console.warn('[setActiveAccount] ID load failed:', e));

    // Use cached mailboxes from last successful connection, or INBOX-only as safe fallback.
    // Never use hardcoded paths like "Sent" — some servers require "INBOX.Sent" prefix.
    const cachedMailboxes = await db.getCachedMailboxes(accountId);
    const defaultMailboxes = cachedMailboxes || [
      { name: 'INBOX', path: 'INBOX', specialUse: null, children: [] }
    ];

    if (isStale()) { console.log('[setActiveAccount] Stale after mailbox cache, aborting'); return; }

    // Set cached mailboxes immediately so sidebar isn't blank while background fetch runs
    set({ mailboxes: defaultMailboxes });

    // Check if credentials are missing — try keychain refresh before showing error
    let hasCredentials = account.password || (account.authType === 'oauth2' && account.oauth2AccessToken);
    if (!hasCredentials) {
      // Credentials may not be loaded yet (quick-load uses accounts.json without passwords).
      // Try fetching from keychain before giving up.
      console.log('[setActiveAccount] Credentials not in store, trying keychain for', account.email);
      try {
        const freshAccount = await db.getAccount(accountId);
        if (freshAccount && (freshAccount.password || (freshAccount.authType === 'oauth2' && freshAccount.oauth2AccessToken))) {
          account = freshAccount;
          hasCredentials = true;
          // Update store so future calls have the credentials
          const updatedAccounts = get().accounts.map(a => a.id === accountId ? { ...a, ...freshAccount } : a);
          set({ accounts: updatedAccounts });
        }
      } catch (e) {
        console.warn('[setActiveAccount] Keychain fetch failed:', e);
      }
    }
    if (!hasCredentials) {
      console.error('Credentials missing for account:', account.email);
      if (isStale()) return;
      set({
        mailboxes: defaultMailboxes,
        connectionStatus: 'error',
        connectionError: 'Password not found. Please re-enter your password in Settings.',
        connectionErrorType: 'passwordMissing',
        loading: false
      });
      get().loadSentHeaders(accountId);
      return;
    }

    // Check network connectivity (if Tauri available)
    if (invoke) {
      try {
        console.log('[setActiveAccount] Checking network connectivity...');
        const isOnline = await invoke('check_network_connectivity');
        if (isStale()) return;
        console.log('[setActiveAccount] Network connectivity result:', isOnline);
        if (isOnline === false) {
          console.error('[setActiveAccount] No network connectivity detected!');
          set({
            mailboxes: defaultMailboxes,
            connectionStatus: 'error',
            connectionError: 'No internet connection. Showing locally archived emails.',
            connectionErrorType: 'offline',
            loading: false
          });
          get().loadSentHeaders(accountId);
          return;
        }
      } catch (e) {
        console.warn('[setActiveAccount] Could not check network connectivity:', e);
        if (isStale()) return;
        // If connectivity check fails, assume offline
        set({
          mailboxes: defaultMailboxes,
          connectionStatus: 'error',
          connectionError: 'Could not check internet connection. Showing locally archived emails.',
          connectionErrorType: 'offline',
          loading: false
        });
        return;
      }
    } else {
      // Check browser online status as fallback
      if (!navigator.onLine) {
        console.error('[setActiveAccount] Browser reports offline');
        set({
          mailboxes: defaultMailboxes,
          connectionStatus: 'error',
          connectionError: 'No internet connection. Showing locally archived emails.',
          connectionErrorType: 'offline',
          loading: false
        });
        return;
      }
    }

    try {
      if (isStale()) return;

      if (isGraphAccount(account)) {
        // Graph accounts: loadEmails handles mailbox fetching internally
        await get().loadEmails();
        // Load cached Sent headers for chat view (non-blocking)
        if (!isStale()) get().loadSentHeaders(accountId);
      } else {
        // IMAP accounts: start email loading immediately, fetch mailboxes in background
        const emailLoadPromise = get().loadEmails();
        if (!isStale()) get().loadSentHeaders(accountId);

        // Background: refresh mailboxes from server (non-blocking)
        ensureFreshToken(account).then(freshAccount =>
          api.fetchMailboxes(freshAccount).then(freshMailboxes => {
            if (!isStale()) {
              set({
                mailboxes: freshMailboxes,
                connectionStatus: 'connected',
                connectionError: null,
                connectionErrorType: null
              });
              db.saveMailboxes(accountId, freshMailboxes);
            }
          })
        ).catch(e => console.warn('[setActiveAccount] Mailbox fetch failed (non-fatal):', e.message));

        await emailLoadPromise;
      }
    } catch (error) {
      console.error('Failed to connect to server:', error);

      // Determine error type
      let errorType = 'serverError';
      let errorMessage = error.message;

      if (error.message?.includes('authenticated but not connected') || error.message?.includes('Command Error. 12')) {
        errorType = 'outlookOAuth';
        errorMessage = 'Microsoft IMAP connection failed. This is a known Microsoft server issue affecting personal Outlook.com accounts with OAuth2. See FAQ for details.';
      } else if (error.message?.includes('password') || error.message?.includes('authentication')) {
        errorType = 'passwordMissing';
        errorMessage = 'Authentication failed. Please check your password in Settings.';
      } else if (error.message?.includes('network') || error.message?.includes('timeout') || error.message?.includes('ENOTFOUND') || error.message?.includes('Server unreachable')) {
        errorType = 'offline';
        errorMessage = error.message;
      }

      if (!isStale()) {
        set({
          mailboxes: defaultMailboxes,
          connectionStatus: 'error',
          connectionError: errorMessage,
          connectionErrorType: errorType
        });
      }
    } finally {
      if (!isStale()) set({ loading: false });
    }
  },

  // ── Unified Inbox ─────────────────────────────────────────────────────────

  setUnifiedInbox: (enabled) => {
    set({ unifiedInbox: enabled });
    if (enabled) {
      get().loadUnifiedInbox();
    }
  },

  loadUnifiedInbox: () => {
    const { accounts } = get();
    const { hiddenAccounts } = useSettingsStore.getState();

    // Collect cached INBOX emails from all visible accounts
    const allEmails = [];
    for (const account of accounts) {
      if (hiddenAccounts[account.id]) continue;

      const cached = _getFromAccountCache(account.id);
      if (!cached || !cached.emails) continue;
      // Only include emails that were from INBOX
      if (cached.activeMailbox && cached.activeMailbox !== 'INBOX') continue;

      for (const email of cached.emails) {
        allEmails.push({
          ...email,
          _accountEmail: account.email,
          _accountId: account.id,
        });
      }
    }

    // Also include currently active account's emails if it's on INBOX
    const { activeAccountId, activeMailbox, emails: currentEmails } = get();
    if (activeAccountId && activeMailbox === 'INBOX' && !hiddenAccounts[activeAccountId]) {
      const activeAccount = accounts.find(a => a.id === activeAccountId);
      if (activeAccount) {
        const existingUids = new Set(allEmails.map(e => `${e._accountId}:${e.uid}`));
        for (const email of currentEmails) {
          const key = `${activeAccountId}:${email.uid}`;
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

    set({
      emails: allEmails,
      sortedEmails: allEmails,
      _sortedEmailsFingerprint: `unified-${allEmails.length}-${Date.now()}`,
      activeMailbox: 'UNIFIED',
      totalEmails: allEmails.length,
      selectedEmailId: null,
      selectedEmail: null,
      selectedEmailSource: null,
      selectedThread: null,
      selectedEmailIds: new Set(),
      hasMoreEmails: false,
      currentPage: 1,
      loading: false,
    });
  },

  // Mailbox management
  setActiveMailbox: async (mailbox) => {
    const { activeAccountId } = get();
    const previousMailbox = get().activeMailbox;

    // Remember this mailbox for the account
    useSettingsStore.getState().setLastMailbox(activeAccountId, mailbox);

    // Save previous mailbox state to LRU cache before switching
    if (previousMailbox && previousMailbox !== mailbox) {
      _saveToMailboxCache(activeAccountId, previousMailbox, get());
    }

    // Clear selection but don't reset email data yet - loadEmails will handle cache
    set({
      activeMailbox: mailbox,
      selectedEmailId: null,
      selectedEmail: null,
      selectedEmailSource: null,
      selectedThread: null,
      selectedEmailIds: new Set()
    });

    // Check LRU cache for target mailbox — instant restore
    const cached = _getFromMailboxCache(activeAccountId, mailbox);
    if (cached) {
      console.log('[setActiveMailbox] LRU cache hit for', mailbox, '— restoring', cached.emails.length, 'emails');
      set({
        emails: cached.emails,
        localEmails: cached.localEmails,
        emailsByIndex: cached.emailsByIndex,
        totalEmails: cached.totalEmails,
        savedEmailIds: cached.savedEmailIds,
        archivedEmailIds: cached.archivedEmailIds,
        loadedRanges: cached.loadedRanges,
        currentPage: cached.currentPage,
        hasMoreEmails: cached.hasMoreEmails,
        loading: false,
        loadingMore: false,
      });
      get().updateSortedEmails();

      // Background CONDSTORE delta-sync — non-blocking
      get().loadEmails().catch(() => {});
      return;
    }

    // Load partial cached data (200 most recent) + saved/archived IDs + archived headers.
    const [cachedHeaders, savedEmailIds, archivedEmailIds] = await Promise.all([
      db.getEmailHeadersPartial(activeAccountId, mailbox, 200),
      db.getSavedEmailIds(activeAccountId, mailbox),
      db.getArchivedEmailIds(activeAccountId, mailbox),
    ]);
    // Fire-and-forget: load archived emails from disk in batches of 200 for progressive display.
    // localEmails is managed ONLY by this chain — never overwritten by set() below.
    if (archivedEmailIds.size > 0) {
      db.getArchivedEmails(activeAccountId, mailbox, archivedEmailIds, (batchEmails) => {
        if (get().activeAccountId !== activeAccountId || get().activeMailbox !== mailbox) return;
        set({ localEmails: batchEmails });
        get().updateSortedEmails();
      }).catch(() => {});
    }

    if (cachedHeaders && cachedHeaders.emails.length > 0) {
      console.log('[setActiveMailbox] Found cached data:', cachedHeaders.emails.length, 'of', cachedHeaders.totalCached, 'emails for', mailbox);

      // Build sparse index from cached emails
      const emailsByIndex = new Map();
      cachedHeaders.emails.forEach((email, idx) => {
        emailsByIndex.set(idx, {
          ...email,
          isLocal: savedEmailIds.has(email.uid),
          source: email.source || 'server'
        });
      });

      set({
        emails: cachedHeaders.emails,
        emailsByIndex,
        loadedRanges: [{ start: 0, end: cachedHeaders.emails.length }],
        loadingRanges: new Set(),
        totalEmails: cachedHeaders.totalEmails,
        savedEmailIds, archivedEmailIds,
        currentPage: Math.ceil(cachedHeaders.emails.length / 200) || 1,
        hasMoreEmails: cachedHeaders.emails.length < cachedHeaders.totalEmails,
        loading: false,
        loadingMore: true
      });
      get().updateSortedEmails();
    } else {
      // No cache - reset to empty
      set({
        emails: [],
        emailsByIndex: new Map(),
        loadedRanges: [],
        loadingRanges: new Set(),
        totalEmails: 0,
        savedEmailIds, archivedEmailIds,
        currentPage: 1,
        hasMoreEmails: true,
        loading: true
      });
      get().updateSortedEmails();
    }

    await get().loadEmails();
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
      const { activeAccountId, activeMailbox } = get();
      if (activeAccountId && activeMailbox) {
        Promise.all([
          db.getSavedEmailIds(activeAccountId, activeMailbox),
          db.getArchivedEmailIds(activeAccountId, activeMailbox),
          db.getLocalEmails(activeAccountId, activeMailbox),
        ]).then(([savedEmailIds, archivedEmailIds, localEmails]) => {
          set({ savedEmailIds, archivedEmailIds, localEmails });
          get().updateSortedEmails();
        });
      }
    }
  },
  
  // Load emails
  loadEmails: async () => {
    const { activeAccountId, accounts, activeMailbox } = get();
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;

    // Bump generation — any previous in-flight loadEmails call becomes stale
    const generation = ++_loadEmailsGeneration;

    // Helper: check if this loadEmails call is still current
    const isStale = () => get().activeAccountId !== activeAccountId || _loadEmailsGeneration !== generation;

    // Safety: clear stuck loading state after 20s — covers the ENTIRE function,
    // including credential checks, network checks, and IMAP operations.
    const loadingGuard = setTimeout(() => {
      if (get().activeAccountId === activeAccountId && get().loading) {
        console.warn('[loadEmails] Loading timeout — clearing stuck loading state after 20s');
        set({ loading: false, loadingMore: false });
      }
    }, 20000);

    try {
    // Proactively refresh OAuth2 token if expiring soon
    account = await ensureFreshToken(account);
    if (isStale()) return;

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
    set({ savedEmailIds, archivedEmailIds });

    // Fire-and-forget: load archived email headers from disk in background.
    // IMPORTANT: localEmails is managed ONLY by this fire-and-forget chain — never overwritten
    // by IMAP sync set() calls. This ensures archived emails persist once loaded.
    if (archivedEmailIds.size > 0 && (get().localEmails || []).length === 0) {
      // Use account-only staleness check (not generation) — archived emails should
      // persist regardless of which loadEmails iteration triggered them.
      const archivedAccount = activeAccountId;
      db.getArchivedEmails(activeAccountId, activeMailbox, archivedEmailIds, (batchEmails) => {
        if (get().activeAccountId !== archivedAccount) return;
        set({ localEmails: batchEmails });
        get().updateSortedEmails();
      }).catch(e => console.warn('[loadEmails] getArchivedEmails failed:', e));
    }

    // Use existing emails from store (populated by QuickLoad or previous setActiveMailbox)
    const existingStoreEmails = get().emails;
    const hasExistingEmails = existingStoreEmails.length > 0;
    console.log('[loadEmails] Decision point: hasExistingEmails=%s (%d), cachedHeaders.totalCached=%s, loading=%s',
      hasExistingEmails, existingStoreEmails.length, cachedHeaders?.totalCached ?? 'null', get().loading);

    if (hasExistingEmails) {
      // QuickLoad or setActiveMailbox already populated emails — just update local state
      // NOTE: Do NOT set localEmails here — the fire-and-forget chain manages it independently
      set({
        loading: false,
        loadingMore: true,
        error: null,
        totalEmails: cachedHeaders?.totalEmails ?? existingStoreEmails.length,
        hasMoreEmails: existingStoreEmails.length < (cachedHeaders?.totalEmails ?? existingStoreEmails.length)
      });
      get().updateSortedEmails();
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
          set({
            connectionStatus: 'connected',
            connectionError: null,
            connectionErrorType: null,
            loadingMore: false
          });
          get().updateSortedEmails();
          set({ loading: false, loadingMore: false });
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
        const serverResult = await api.fetchEmails(account, activeMailbox, 1);
        serverTotal = serverResult.total;
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

      // Save to account cache for instant restore on switch-back
      _saveToAccountCache(activeAccountId, get());

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
      } else if (error.message?.includes('password') || error.message?.includes('authentication') || error.message?.includes('No password')) {
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
      }
    } finally {
      clearTimeout(loadingGuard);
      if (!isStale()) set({ loading: false, loadingMore: false });
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
      // 1. Fetch mailbox list via Graph
      const graphFolders = await api.graphListFolders(account.oauth2AccessToken);
      if (isStale()) return;

      const mailboxes = graphFoldersToMailboxes(graphFolders);
      set({ mailboxes });
      db.saveMailboxes(activeAccountId, mailboxes);

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

      // Save to account cache for instant restore on switch-back
      _saveToAccountCache(activeAccountId, get());

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

        // Update account cache with latest state
        _saveToAccountCache(activeAccountId, get());

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
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;
    const currentIndex = sortedEmails.findIndex(e => e.uid === currentUid);
    if (currentIndex < 0) return;

    // Pre-fetch next 3 emails
    for (let i = 1; i <= 3; i++) {
      const nextEmail = sortedEmails[currentIndex + i];
      if (!nextEmail) break;

      const cacheKey = `${activeAccountId}-${activeMailbox}-${nextEmail.uid}`;
      if (emailCache.has(cacheKey)) continue; // Already cached

      try {
        // Try Maildir first (fast, local disk)
        const localEmail = await db.getLocalEmailLight(activeAccountId, activeMailbox, nextEmail.uid);
        if (localEmail && localEmail.html !== undefined) {
          get().addToCache(cacheKey, localEmail, cacheLimitMB);
          continue;
        }

        // Fallback to server fetch
        const account = get().accounts.find(a => a.id === activeAccountId);
        if (!account) break;

        if (isGraphAccount(account)) {
          // Graph API: fetch full message
          const graphId = getGraphMessageId(activeAccountId, activeMailbox, nextEmail.uid);
          if (!graphId) continue;
          const freshAccount = await ensureFreshToken(account);
          const graphMsg = await api.graphGetMessage(freshAccount.oauth2AccessToken, graphId);
          const email = graphMessageToEmail(graphMsg, nextEmail.uid);
          get().addToCache(cacheKey, email, cacheLimitMB);
        } else {
          // IMAP (auto-persists .eml)
          const email = await api.fetchEmailLight(account, nextEmail.uid, activeMailbox, activeAccountId);
          get().addToCache(cacheKey, email, cacheLimitMB);
        }
      } catch (e) {
        // Stop prefetch on network errors — don't waste bandwidth
        break;
      }
    }
  },

  // Select email
  selectEmail: async (uid, source = 'server') => {
    const { activeAccountId, accounts, activeMailbox } = get();
    let account = accounts.find(a => a.id === activeAccountId);
    account = await ensureFreshToken(account);
    const cacheKey = `${activeAccountId}-${activeMailbox}-${uid}`;
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;

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
      const localEmail = await db.getLocalEmailLight(activeAccountId, activeMailbox, uid);

      if (source === 'local-only' || (localEmail && localEmail.html !== undefined)) {
        email = localEmail;
        actualSource = source === 'local-only' ? 'local-only' : 'local';
        get().addToCache(cacheKey, email, cacheLimitMB);
      } else if (account && isGraphAccount(account)) {
        // 3a. Graph API: fetch full message by Graph message ID
        const freshAccount = await ensureFreshToken(account);
        const token = freshAccount.oauth2AccessToken;
        let graphId = getGraphMessageId(activeAccountId, activeMailbox, uid);

        // If graphIdMap is stale (e.g. after app restart), rebuild it by re-fetching headers
        if (!graphId) {
          console.log('[selectEmail] Graph ID not found for UID', uid, '— rebuilding map');
          try {
            const folders = await api.graphListFolders(token);
            const folder = folders.find(f => {
              const normalized = normalizeGraphFolderName(f.displayName);
              return normalized === activeMailbox || f.displayName === activeMailbox;
            });
            if (folder) {
              const { graphMessageIds } = await api.graphListMessages(token, folder.id, 200, 0);
              const uidMap = new Map();
              graphMessageIds.forEach((gid, i) => uidMap.set(i + 1, gid));
              _setGraphIdMap(activeAccountId, activeMailbox, uidMap);
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
          api.graphCacheMime(token, graphId, activeAccountId, activeMailbox, uid)
            .catch(e => console.warn('[selectEmail] Background MIME cache failed:', e));

          // Mark as read on server (if auto mode)
          const markAsReadMode = useSettingsStore.getState().markAsReadMode;
          if (markAsReadMode === 'auto' && !email.flags?.includes('\\Seen')) {
            try {
              await api.graphSetRead(token, graphId, true);
              email = { ...email, flags: [...(email.flags || []), '\\Seen'] };
            } catch (e) {
              console.warn('[selectEmail] Graph mark as read failed:', e);
            }
          }
        } else {
          console.warn('[selectEmail] No Graph message ID found for UID', uid);
        }
      } else if (account) {
        // 3b. IMAP: Fetch from server (light — saves full .eml to Maildir in Rust background)
        email = await api.fetchEmailLight(account, uid, activeMailbox, activeAccountId);
        actualSource = 'server';
        get().addToCache(cacheKey, email, cacheLimitMB);

        // Update saved IDs (the light IMAP fetch auto-persists to Maildir in Rust)
        try {
          const savedEmailIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);
          set({ savedEmailIds });
        } catch (e) {
          console.warn('[selectEmail] Failed to update saved IDs:', e);
        }

        // Mark as read on server (if auto mode)
        const markAsReadMode = useSettingsStore.getState().markAsReadMode;
        if (markAsReadMode === 'auto' && !email.flags?.includes('\\Seen')) {
          try {
            await api.updateEmailFlags(account, uid, ['\\Seen'], 'add', activeMailbox);
            email = { ...email, flags: [...(email.flags || []), '\\Seen'] };
          } catch (e) {
            console.warn('Failed to mark as read:', e);
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
        const localEmail = await db.getLocalEmailLight(activeAccountId, activeMailbox, uid);
        if (localEmail) {
          set({ selectedEmail: localEmail, selectedEmailSource: 'local-only' });
        } else {
          const detail = error.message || String(error);
          set({ error: `Failed to load email (UID ${uid}, ${activeMailbox}): ${detail}` });
        }
      } catch (fallbackError) {
        console.error('[selectEmail] Fallback also failed:', fallbackError);
        const detail = error.message || String(error);
        set({ error: `Failed to load email (UID ${uid}, ${activeMailbox}): ${detail}` });
      }
    } finally {
      set({ loadingEmail: false });
      // Pre-fetch next 3 email bodies in background for instant navigation
      get()._prefetchAdjacentEmails(uid);
    }
  },

  // Archive email locally (save .eml with 'A' flag)
  saveEmailLocally: async (uid) => {
    const { activeAccountId, accounts, activeMailbox, selectedEmail } = get();
    const account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;

    const cacheKey = `${activeAccountId}-${activeMailbox}-${uid}`;
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;

    try {
      // Check if already cached in Maildir — just set archive flag
      const alreadyCached = await db.isEmailSaved(activeAccountId, activeMailbox, uid);
      if (alreadyCached) {
        await db.archiveEmail(activeAccountId, activeMailbox, uid);
      } else {
        // Need full email content (with rawSource) to save .eml
        const email = await api.fetchEmail(account, uid, activeMailbox);

        if (!email.rawSource) {
          throw new Error('Email has no raw source data');
        }

        // Store .eml with archived + seen flags
        const invoke = window.__TAURI__?.core?.invoke;
        await invoke('maildir_store', {
          accountId: activeAccountId,
          mailbox: activeMailbox,
          uid: email.uid,
          rawSourceBase64: email.rawSource,
          flags: ['archived', 'seen'],
        });
      }

      // Update state
      const savedEmailIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);
      const archivedEmailIds = await db.getArchivedEmailIds(activeAccountId, activeMailbox);
      const localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);

      set({ savedEmailIds, archivedEmailIds, localEmails });
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
        const localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);
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
    const { activeAccountId, activeMailbox, selectedEmailId } = get();
    const localId = `${activeAccountId}-${activeMailbox}-${uid}`;
    
    await db.deleteLocalEmail(localId);

    const savedEmailIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);
    const archivedEmailIds = await db.getArchivedEmailIds(activeAccountId, activeMailbox);
    const localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);

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
    const { activeAccountId, accounts, activeMailbox, selectedEmailId } = get();
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;
    account = await ensureFreshToken(account);

    if (isGraphAccount(account)) {
      const graphId = getGraphMessageId(activeAccountId, activeMailbox, uid);
      if (!graphId) throw new Error('Cannot delete: no Graph message ID found for this email.');
      await api.graphDeleteMessage(account.oauth2AccessToken, graphId);
    } else {
      await api.deleteEmail(account, uid, activeMailbox);
    }

    // Immediately remove from emails array so displayEmails flags it as local-only
    const filteredEmails = get().emails.filter(e => e.uid !== uid);
    const newTotal = Math.max(0, (get().totalEmails || 0) - 1);
    const updates = {
      emails: filteredEmails,
      totalEmails: newTotal,
    };
    if (selectedEmailId === uid) {
      updates.selectedEmailId = null;
      updates.selectedEmail = null;
      updates.selectedEmailSource = null;
      updates.selectedThread = null;
    }
    set(updates);

    // Update cached headers on disk so loadEmails doesn't restore the deleted email
    await db.saveEmailHeaders(activeAccountId, activeMailbox, filteredEmails, newTotal);

    // Background refresh to sync with server (skip during batch operations)
    if (!skipRefresh) get().loadEmails();
  },
  
  // Move emails to a different mailbox/folder
  moveEmails: async (uids, targetMailbox) => {
    const { activeAccountId, accounts, activeMailbox, mailboxes, selectedEmailId } = get();
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;
    account = await ensureFreshToken(account);

    if (isGraphAccount(account)) {
      // Resolve Graph message IDs from UIDs
      const messageIds = uids
        .map(uid => getGraphMessageId(activeAccountId, activeMailbox, uid))
        .filter(Boolean);
      if (messageIds.length === 0) throw new Error('Cannot move: no Graph message IDs found for selected emails.');

      // Find the Graph folder ID for the target mailbox
      const targetFolder = mailboxes.find(m => m.path === targetMailbox || m.name === targetMailbox);
      if (!targetFolder || !targetFolder._graphFolderId) {
        throw new Error(`Cannot move: target folder "${targetMailbox}" not found.`);
      }

      await api.graphMoveEmails(account.oauth2AccessToken, messageIds, targetFolder._graphFolderId);
    } else {
      await api.moveEmails(account, uids, activeMailbox, targetMailbox);
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
    const { activeAccountId, accounts, activeMailbox, selectedEmail } = get();
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;
    account = await ensureFreshToken(account);

    try {
      // Route through Graph API or IMAP depending on account transport
      if (isGraphAccount(account)) {
        const graphId = getGraphMessageId(activeAccountId, activeMailbox, uid);
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
          activeMailbox
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
    const { selectedEmailIds, activeAccountId, accounts, activeMailbox } = get();
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account || selectedEmailIds.size === 0) return;

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

    account = await ensureFreshToken(account);
    for (const uid of uids) {
      try {
        await api.updateEmailFlags(account, uid, ['\\Seen'], 'add', activeMailbox);
      } catch (e) {
        console.error(`Failed to mark email ${uid} as read:`, e);
      }
    }
  },

  // Bulk mark as unread — clears selection immediately, optimistic UI update
  markSelectedAsUnread: async () => {
    const { selectedEmailIds, activeAccountId, accounts, activeMailbox } = get();
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account || selectedEmailIds.size === 0) return;

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

    account = await ensureFreshToken(account);
    for (const uid of uids) {
      try {
        await api.updateEmailFlags(account, uid, ['\\Seen'], 'remove', activeMailbox);
      } catch (e) {
        console.error(`Failed to mark email ${uid} as unread:`, e);
      }
    }
  },

  // Bulk delete from server — clears selection immediately
  deleteSelectedFromServer: async () => {
    const { selectedEmailIds, activeAccountId, accounts, activeMailbox } = get();
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account || selectedEmailIds.size === 0) return;

    const uids = Array.from(selectedEmailIds);
    set({ selectedEmailIds: new Set() });

    account = await ensureFreshToken(account);
    const isGraph = isGraphAccount(account);
    for (const uid of uids) {
      try {
        if (isGraph) {
          const graphId = getGraphMessageId(activeAccountId, activeMailbox, uid);
          if (graphId) {
            await api.graphDeleteMessage(account.oauth2AccessToken, graphId);
          } else {
            console.warn(`[deleteSelectedFromServer] No Graph ID for UID ${uid}, skipping`);
          }
        } else {
          await api.deleteEmail(account, uid, activeMailbox);
        }
      } catch (e) {
        console.error(`Failed to delete email ${uid}:`, e);
      }
    }

    await get().loadEmails();
  },

  // Export email
  exportEmail: async (uid) => {
    const { activeAccountId, activeMailbox } = get();
    const localId = `${activeAccountId}-${activeMailbox}-${uid}`;
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
          totalUnread += currentEmails.filter(e => !e.flags?.includes('\\Seen')).length;
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
              totalUnread += headers.filter(e => !e.flags?.includes('\\Seen')).length;

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

            totalUnread += allEmails.filter(e => !e.flags?.includes('\\Seen')).length;

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

      // Reload emails with the fresh credentials
      await get().loadEmails();
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

  // Search functions
  setSearchQuery: (query) => set({ searchQuery: query }),

  setSearchFilters: (filters) => set(state => ({
    searchFilters: { ...state.searchFilters, ...filters }
  })),

  performSearch: async () => {
    const { searchQuery, searchFilters, emails, localEmails, activeMailbox, activeAccountId, accounts, savedEmailIds } = get();

    if (!searchQuery.trim() && !searchFilters.sender && !searchFilters.dateFrom && !searchFilters.dateTo) {
      set({ searchActive: false, searchResults: [], isSearching: false });
      return;
    }

    set({ isSearching: true, searchActive: true });

    let account = accounts.find(a => a.id === activeAccountId);
    account = await ensureFreshToken(account);
    const queryLower = searchQuery.toLowerCase().trim();

    // Helper to filter emails locally
    const filterEmailsLocally = (emailList, markSource) => {
      return emailList.filter(email => {
        // Search in sender
        const senderMatch = !queryLower ||
          email.from?.address?.toLowerCase().includes(queryLower) ||
          email.from?.name?.toLowerCase().includes(queryLower);

        // Search in subject
        const subjectMatch = !queryLower ||
          email.subject?.toLowerCase().includes(queryLower);

        // Search in body preview
        const bodyMatch = !queryLower ||
          email.text?.toLowerCase().includes(queryLower) ||
          email.html?.toLowerCase().includes(queryLower) ||
          email.textBody?.toLowerCase().includes(queryLower) ||
          email.htmlBody?.toLowerCase().includes(queryLower);

        // Sender filter
        const senderFilterMatch = !searchFilters.sender ||
          email.from?.address?.toLowerCase().includes(searchFilters.sender.toLowerCase()) ||
          email.from?.name?.toLowerCase().includes(searchFilters.sender.toLowerCase());

        // Date filters
        const emailDate = new Date(email.date || email.internalDate);
        const dateFromMatch = !searchFilters.dateFrom ||
          emailDate >= new Date(searchFilters.dateFrom);
        const dateToMatch = !searchFilters.dateTo ||
          emailDate <= new Date(searchFilters.dateTo);

        // Attachments filter
        const attachmentMatch = !searchFilters.hasAttachments ||
          email.hasAttachments ||
          (email.attachments && email.attachments.length > 0);

        // Must match query in at least one field AND all filters
        const queryMatch = !queryLower || senderMatch || subjectMatch || bodyMatch;

        return queryMatch && senderFilterMatch && dateFromMatch && dateToMatch && attachmentMatch;
      }).map(e => ({
        ...e,
        isLocal: markSource === 'local' || savedEmailIds.has(e.uid),
        source: markSource || e.source || 'server'
      }));
    };

    try {
      const allResults = [];

      // 1. Search in-memory emails (already loaded headers)
      if (searchFilters.location !== 'local') {
        const inMemoryResults = filterEmailsLocally(emails, 'server');
        allResults.push(...inMemoryResults);
        console.log(`[Search] Found ${inMemoryResults.length} in-memory matches`);
      }

      // 2. Search locally archived emails from Maildir
      if (searchFilters.location !== 'server') {
        try {
          const localResults = await db.searchLocalEmails(activeAccountId, searchQuery, {
            sender: searchFilters.sender,
            dateFrom: searchFilters.dateFrom,
            dateTo: searchFilters.dateTo,
            mailbox: searchFilters.folder === 'current' ? activeMailbox :
                     searchFilters.folder === 'all' ? null : searchFilters.folder,
            hasAttachments: searchFilters.hasAttachments
          });
          allResults.push(...localResults);
          console.log(`[Search] Found ${localResults.length} local Maildir matches`);
        } catch (error) {
          console.warn('[Search] Local search failed:', error);
        }
      }

      // 3. Search on server via IMAP (if online and not local-only search)
      if (searchFilters.location !== 'local' && account && hasValidCredentials(account)) {
        try {
          const serverFilters = {};
          if (searchFilters.sender) serverFilters.from = searchFilters.sender;
          if (searchFilters.dateFrom) serverFilters.since = searchFilters.dateFrom;
          if (searchFilters.dateTo) serverFilters.before = searchFilters.dateTo;

          const mailboxToSearch = searchFilters.folder === 'current' ? activeMailbox :
                                  searchFilters.folder === 'all' ? 'INBOX' : searchFilters.folder;

          const serverResponse = await api.searchEmails(account, mailboxToSearch, searchQuery, serverFilters);

          if (serverResponse.emails && serverResponse.emails.length > 0) {
            const serverResults = serverResponse.emails.map(e => ({
              ...e,
              isLocal: savedEmailIds.has(e.uid),
              source: 'server-search'
            }));
            allResults.push(...serverResults);
            console.log(`[Search] Found ${serverResults.length} server matches (total on server: ${serverResponse.total})`);
          }
        } catch (error) {
          console.warn('[Search] Server search failed:', error);
          // Continue with local results only
        }
      }

      // 4. Deduplicate results by UID (prefer local > server-search > server)
      const seen = new Map();
      const sourcePriority = { 'local': 3, 'local-only': 3, 'server-search': 2, 'server': 1 };

      for (const email of allResults) {
        const key = email.uid || email.messageId;
        const existing = seen.get(key);

        if (!existing || (sourcePriority[email.source] || 0) > (sourcePriority[existing.source] || 0)) {
          seen.set(key, email);
        }
      }

      const deduplicatedResults = Array.from(seen.values());

      // 5. Sort by date (newest first)
      deduplicatedResults.sort((a, b) => {
        const dateA = new Date(a.date || a.internalDate || 0);
        const dateB = new Date(b.date || b.internalDate || 0);
        return dateB - dateA;
      });

      console.log(`[Search] Total unique results: ${deduplicatedResults.length}`);
      set({ searchResults: deduplicatedResults, isSearching: false });

      // Add to search history
      if (searchQuery.trim()) {
        useSettingsStore.getState().addSearchToHistory(searchQuery.trim());
      }
    } catch (error) {
      console.error('[mailStore] Search failed:', error);
      set({ isSearching: false, searchResults: [] });
    }
  },

  clearSearch: () => set({
    searchActive: false,
    searchQuery: '',
    searchFilters: {
      location: 'all',
      folder: 'current',
      sender: '',
      dateFrom: null,
      dateTo: null,
      hasAttachments: false,
    },
    searchResults: [],
    isSearching: false
  })
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
