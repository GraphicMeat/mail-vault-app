import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../services/db';
import * as api from '../services/api';
import { useSettingsStore } from './settingsStore';

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
  selectedEmailId: null,
  selectedEmail: null,
  selectedEmailSource: null, // 'server' | 'local' | 'local-only'

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

  // Pagination
  currentPage: 1,
  hasMoreEmails: true,
  totalEmails: 0,
  
  // Selection for bulk actions
  selectedEmailIds: new Set(),
  
  // Bulk save progress
  bulkSaveProgress: null, // { total, completed, errors, active }

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
    set({ emailCache: new Map(), cacheCurrentSizeMB: 0 });
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
  addToCache: (cacheKey, email, cacheLimitMB) => {
    const { emailCache, cacheCurrentSizeMB } = get();
    const emailSize = get().estimateEmailSizeMB(email);
    
    // If limit is 0, cache is unlimited
    if (cacheLimitMB > 0) {
      // Evict oldest entries if we'd exceed the limit
      let currentSize = cacheCurrentSizeMB;
      const newCache = new Map(emailCache);
      
      while (currentSize + emailSize > cacheLimitMB && newCache.size > 0) {
        // Find oldest entry
        let oldestKey = null;
        let oldestTime = Infinity;
        
        for (const [key, entry] of newCache) {
          if (entry.timestamp < oldestTime) {
            oldestTime = entry.timestamp;
            oldestKey = key;
          }
        }
        
        if (oldestKey) {
          const evicted = newCache.get(oldestKey);
          currentSize -= evicted.size;
          newCache.delete(oldestKey);
        } else {
          break;
        }
      }
      
      // Add new entry
      newCache.set(cacheKey, {
        email,
        timestamp: Date.now(),
        size: emailSize
      });
      
      set({ 
        emailCache: newCache, 
        cacheCurrentSizeMB: currentSize + emailSize 
      });
    } else {
      // Unlimited cache
      const newCache = new Map(emailCache);
      newCache.set(cacheKey, {
        email,
        timestamp: Date.now(),
        size: emailSize
      });
      set({ 
        emailCache: newCache, 
        cacheCurrentSizeMB: cacheCurrentSizeMB + emailSize 
      });
    }
  },
  
  // Update sorted emails (memoization for performance)
  updateSortedEmails: () => {
    const { emails, localEmails, viewMode, savedEmailIds } = get();

    let result = [];

    if (viewMode === 'server') {
      result = emails.map(e => ({
        ...e,
        isLocal: savedEmailIds.has(e.uid),
        source: 'server'
      }));
    } else if (viewMode === 'local') {
      result = localEmails.map(e => ({
        ...e,
        isLocal: true,
        source: 'local'
      }));
    } else {
      // Combine: server emails + local-only emails
      const serverUids = new Set(emails.map(e => e.uid));
      const combinedEmails = emails.map(e => ({
        ...e,
        isLocal: savedEmailIds.has(e.uid),
        source: 'server'
      }));

      // Add local-only emails (deleted from server but saved locally)
      for (const localEmail of localEmails) {
        if (!serverUids.has(localEmail.uid)) {
          combinedEmails.push({
            ...localEmail,
            isLocal: true,
            source: 'local-only'
          });
        }
      }

      result = combinedEmails;
    }

    // Sort by date descending (newest first) - done once on update
    result.sort((a, b) => {
      const dateA = new Date(a.date || a.internalDate || 0);
      const dateB = new Date(b.date || b.internalDate || 0);
      return dateB - dateA;
    });

    set({ sortedEmails: result });
  },

  // Get email from cache (updates timestamp for LRU)
  getFromCache: (cacheKey) => {
    const { emailCache } = get();
    const entry = emailCache.get(cacheKey);
    
    if (entry) {
      // Update timestamp (LRU)
      const newCache = new Map(emailCache);
      newCache.set(cacheKey, { ...entry, timestamp: Date.now() });
      set({ emailCache: newCache });
      return entry.email;
    }
    
    return null;
  },
  
  // Initialize
  init: async () => {
    try {
      await db.initDB();
      const accounts = await db.getAccounts();
      set({ accounts });
      
      if (accounts.length > 0) {
        await get().setActiveAccount(accounts[0].id);
      }
    } catch (error) {
      console.error('Failed to initialize:', error);
      set({ error: error.message });
    }
  },
  
  // Account management
  addAccount: async (accountData) => {
    console.log('[mailStore] addAccount called with:', { ...accountData, password: '***' });

    const account = {
      id: uuidv4(),
      ...accountData,
      createdAt: new Date().toISOString()
    };
    console.log('[mailStore] Created account object with id:', account.id);

    // Test connection first
    console.log('[mailStore] Testing connection...');
    try {
      await api.testConnection(account);
      console.log('[mailStore] Connection test successful');
    } catch (error) {
      console.error('[mailStore] Connection test failed:', error);
      throw error;
    }

    // Save to IndexedDB
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
    if (account) {
      try {
        await api.disconnect(account);
      } catch (e) {
        // Ignore disconnect errors
      }
    }
    
    await db.deleteAccount(accountId);
    
    const newAccounts = get().accounts.filter(a => a.id !== accountId);
    
    set({ accounts: newAccounts });
    
    if (get().activeAccountId === accountId) {
      if (newAccounts.length > 0) {
        await get().setActiveAccount(newAccounts[0].id);
      } else {
        set({
          activeAccountId: null,
          mailboxes: [],
          emails: [],
          localEmails: [],
          savedEmailIds: new Set(),
          selectedEmailId: null,
          selectedEmail: null,
          selectedEmailSource: null
        });
      }
    }
  },
  
  setActiveAccount: async (accountId) => {
    const account = get().accounts.find(a => a.id === accountId);
    if (!account) return;

    const invoke = window.__TAURI__?.tauri?.invoke || window.__TAURI__?.invoke;
    const { activeAccountId: currentAccountId, emails: currentEmails, totalEmails: currentTotalEmails } = get();

    // Check if we're switching to the same account that already has data loaded
    const isSameAccount = currentAccountId === accountId;
    const hasExistingData = currentEmails.length > 0 || currentTotalEmails > 0;

    if (isSameAccount && hasExistingData) {
      // Same account with data - don't reset, just refresh in background
      console.log('[setActiveAccount] Same account with existing data, preserving state');
      // Just call loadEmails which will handle cache and server fetch
      await get().loadEmails();
      return;
    }

    // Different account or no data - need to reset and load
    console.log('[setActiveAccount] Switching to account:', accountId, 'from:', currentAccountId);

    // Only reset selection-related state, preserve emails if switching to same account
    set({
      activeAccountId: accountId,
      selectedEmailId: null,
      selectedEmail: null,
      selectedEmailSource: null,
      selectedEmailIds: new Set(),
      connectionStatus: 'disconnected',
      connectionError: null,
      connectionErrorType: null,
      error: null
    });

    // Get local emails first (always available)
    const localEmails = await db.getLocalEmails(accountId, 'INBOX');
    const savedEmailIds = await db.getSavedEmailIds(accountId, 'INBOX');

    // Load cached headers to check if we have data for this account
    const cachedHeaders = await db.getEmailHeaders(accountId, 'INBOX');

    if (cachedHeaders && cachedHeaders.emails.length > 0) {
      console.log('[setActiveAccount] Found cached data:', cachedHeaders.emails.length, 'emails');
      // Build sparse index from cached emails
      const emailsByIndex = new Map();
      cachedHeaders.emails.forEach((email, idx) => {
        const index = email.displayIndex !== undefined ? email.displayIndex : idx;
        emailsByIndex.set(index, {
          ...email,
          isLocal: savedEmailIds.has(email.uid),
          source: email.source || 'server'
        });
      });

      const loadedRanges = [{ start: 0, end: cachedHeaders.emails.length }];

      // Set cached data - don't show loading spinner, but indicate background refresh
      set({
        emails: cachedHeaders.emails,
        emailsByIndex,
        loadedRanges,
        loadingRanges: new Set(),
        totalEmails: cachedHeaders.totalEmails,
        localEmails,
        savedEmailIds,
        loading: false,
        loadingMore: true, // Indicate background refresh is happening
        currentPage: Math.ceil(cachedHeaders.emails.length / 50) || 1,
        hasMoreEmails: cachedHeaders.emails.length < cachedHeaders.totalEmails
      });
      get().updateSortedEmails();
      console.log('[setActiveAccount] Showing cached data, will refresh from server...');
    } else {
      // No cache - reset to empty with loading state
      set({
        loading: true,
        emails: localEmails,
        localEmails,
        savedEmailIds,
        emailsByIndex: new Map(),
        loadedRanges: [],
        loadingRanges: new Set(),
        currentPage: 1,
        hasMoreEmails: true,
        totalEmails: 0
      });
      get().updateSortedEmails();
    }

    const defaultMailboxes = [
      { name: 'INBOX', path: 'INBOX', specialUse: null, children: [] },
      { name: 'Sent', path: 'Sent', specialUse: '\\Sent', children: [] },
      { name: 'Drafts', path: 'Drafts', specialUse: '\\Drafts', children: [] },
      { name: 'Trash', path: 'Trash', specialUse: '\\Trash', children: [] }
    ];

    // Check if password is missing - local emails are still viewable
    if (!account.password) {
      console.error('Password missing for account:', account.email);
      set({
        mailboxes: defaultMailboxes,
        localEmails,
        savedEmailIds,
        connectionStatus: 'error',
        connectionError: 'Keychain access required to fetch emails from server. Local emails are available.',
        connectionErrorType: 'passwordMissing',
        loading: false
      });
      return;
    }

    // Check network connectivity (if Tauri available)
    if (invoke) {
      try {
        console.log('[setActiveAccount] Checking network connectivity...');
        const isOnline = await invoke('check_network_connectivity');
        console.log('[setActiveAccount] Network connectivity result:', isOnline);
        if (isOnline === false) {
          console.error('[setActiveAccount] No network connectivity detected!');
          set({
            mailboxes: defaultMailboxes,
            localEmails,
            savedEmailIds,
            connectionStatus: 'error',
            connectionError: 'No internet connection. Showing locally saved emails.',
            connectionErrorType: 'offline',
            loading: false
          });
          return;
        }
      } catch (e) {
        console.warn('[setActiveAccount] Could not check network connectivity:', e);
        // If connectivity check fails, assume offline
        set({
          mailboxes: defaultMailboxes,
          localEmails,
          savedEmailIds,
          connectionStatus: 'error',
          connectionError: 'Could not check internet connection. Showing locally saved emails.',
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
          localEmails,
          savedEmailIds,
          connectionStatus: 'error',
          connectionError: 'No internet connection. Showing locally saved emails.',
          connectionErrorType: 'offline',
          loading: false
        });
        return;
      }
    }

    try {
      // Fetch mailboxes
      const mailboxes = await api.fetchMailboxes(account);
      set({
        mailboxes,
        connectionStatus: 'connected',
        connectionError: null,
        connectionErrorType: null
      });

      // Load emails (this will update connection status)
      await get().loadEmails();
    } catch (error) {
      console.error('Failed to connect to server:', error);

      // Determine error type
      let errorType = 'serverError';
      let errorMessage = error.message;

      if (error.message?.includes('password') || error.message?.includes('authentication')) {
        errorType = 'passwordMissing';
        errorMessage = 'Authentication failed. Please check your password in Settings.';
      } else if (error.message?.includes('network') || error.message?.includes('timeout') || error.message?.includes('ENOTFOUND')) {
        errorType = 'offline';
        errorMessage = 'Cannot connect to email server. Please check your internet connection.';
      }

      set({
        mailboxes: defaultMailboxes,
        localEmails,
        savedEmailIds,
        connectionStatus: 'error',
        connectionError: errorMessage,
        connectionErrorType: errorType
      });
    } finally {
      set({ loading: false });
    }
  },
  
  // Mailbox management
  setActiveMailbox: async (mailbox) => {
    const { activeAccountId } = get();

    // Clear selection but don't reset email data yet - loadEmails will handle cache
    set({
      activeMailbox: mailbox,
      selectedEmailId: null,
      selectedEmail: null,
      selectedEmailSource: null,
      selectedEmailIds: new Set()
    });

    // Check if we have cached data for this mailbox
    const cachedHeaders = await db.getEmailHeaders(activeAccountId, mailbox);
    const savedEmailIds = await db.getSavedEmailIds(activeAccountId, mailbox);
    const localEmails = await db.getLocalEmails(activeAccountId, mailbox);

    if (cachedHeaders && cachedHeaders.emails.length > 0) {
      console.log('[setActiveMailbox] Found cached data:', cachedHeaders.emails.length, 'emails for', mailbox);

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
        localEmails,
        savedEmailIds,
        currentPage: Math.ceil(cachedHeaders.emails.length / 50) || 1,
        hasMoreEmails: cachedHeaders.emails.length < cachedHeaders.totalEmails,
        loading: false,
        loadingMore: true
      });
      get().updateSortedEmails();
    } else {
      // No cache - reset to empty
      set({
        emails: localEmails,
        emailsByIndex: new Map(),
        loadedRanges: [],
        loadingRanges: new Set(),
        totalEmails: 0,
        localEmails,
        savedEmailIds,
        currentPage: 1,
        hasMoreEmails: true,
        loading: true
      });
      get().updateSortedEmails();
    }

    await get().loadEmails();
  },
  
  // View mode
  setViewMode: (mode) => {
    set({ viewMode: mode });
    get().updateSortedEmails();
  },
  
  // Load emails
  loadEmails: async () => {
    const { activeAccountId, accounts, activeMailbox } = get();
    const account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;

    const invoke = window.__TAURI__?.tauri?.invoke || window.__TAURI__?.invoke;

    // Get local emails first (always available)
    const localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);
    const savedEmailIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);

    // Load cached headers from IndexedDB for instant display BEFORE resetting state
    const cachedHeaders = await db.getEmailHeaders(activeAccountId, activeMailbox);

    if (cachedHeaders && cachedHeaders.emails.length > 0) {
      console.log('[loadEmails] Loaded', cachedHeaders.emails.length, 'cached headers from IndexedDB (total:', cachedHeaders.totalEmails, ')');

      // Build sparse index from cached emails
      const emailsByIndex = new Map();
      cachedHeaders.emails.forEach((email, idx) => {
        // Use displayIndex if available, otherwise use array index
        const index = email.displayIndex !== undefined ? email.displayIndex : idx;
        emailsByIndex.set(index, {
          ...email,
          isLocal: savedEmailIds.has(email.uid),
          source: email.source || 'server'
        });
      });

      // Calculate loaded ranges from cached data
      const loadedRanges = cachedHeaders.emails.length > 0
        ? [{ start: 0, end: cachedHeaders.emails.length }]
        : [];

      // Set cached data immediately - don't reset to empty!
      // Use loadingMore to indicate background refresh while showing cached data
      set({
        emails: cachedHeaders.emails,
        emailsByIndex,
        loadedRanges,
        loadingRanges: new Set(),
        totalEmails: cachedHeaders.totalEmails,
        localEmails,
        savedEmailIds,
        loading: false, // Show cached data immediately
        loadingMore: true, // Indicate background refresh is happening
        error: null,
        currentPage: Math.ceil(cachedHeaders.emails.length / 50) || 1,
        hasMoreEmails: cachedHeaders.emails.length < cachedHeaders.totalEmails
      });
      get().updateSortedEmails();
      console.log('[loadEmails] Showing cached data, will refresh from server in background...');
    } else {
      // No cache - reset state to empty
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
        localEmails,
        savedEmailIds,
        emails: localEmails // Show local emails while loading
      });
      get().updateSortedEmails();
    }

    // Keep previous/cached emails for degraded modes (password missing, offline)
    const previousEmails = get().emails;

    // Check if password is missing - keep cached emails visible
    if (!account.password) {
      console.error('[loadEmails] Password missing for account:', account.email);
      set({
        // Keep previous/cached emails when password is missing
        emails: previousEmails,
        localEmails,
        savedEmailIds,
        connectionStatus: 'error',
        connectionError: 'Keychain access required to fetch new emails. Local and cached emails are available.',
        connectionErrorType: 'passwordMissing',
        loading: false,
        loadingMore: false
      });
      return;
    }

    // Check network connectivity (if Tauri available)

    if (invoke) {
      try {
        console.log('[loadEmails] Checking network connectivity...');
        const isOnline = await invoke('check_network_connectivity');
        console.log('[loadEmails] Network connectivity result:', isOnline);
        if (isOnline === false) {
          console.error('[loadEmails] No network connectivity detected!');
          set({
            // Keep previous emails when offline
            emails: previousEmails,
            localEmails,
            savedEmailIds,
            connectionStatus: 'error',
            connectionError: 'No internet connection. Showing cached and locally saved emails.',
            connectionErrorType: 'offline',
            loading: false,
            loadingMore: false
          });
          return;
        }
      } catch (e) {
        console.warn('[loadEmails] Could not check network connectivity:', e);
        // If connectivity check itself fails, assume we're offline
        console.error('[loadEmails] Connectivity check failed, assuming offline');
        set({
          // Keep previous emails when offline
          emails: previousEmails,
          localEmails,
          savedEmailIds,
          connectionStatus: 'error',
          connectionError: 'Could not check internet connection. Showing cached and locally saved emails.',
          connectionErrorType: 'offline',
          loading: false,
          loadingMore: false
        });
        return;
      }
    } else {
      // Check browser online status as fallback
      if (!navigator.onLine) {
        console.error('[loadEmails] Browser reports offline');
        set({
          // Keep previous emails when offline
          emails: previousEmails,
          localEmails,
          savedEmailIds,
          connectionStatus: 'error',
          connectionError: 'No internet connection. Showing cached and locally saved emails.',
          connectionErrorType: 'offline',
          loading: false,
          loadingMore: false
        });
        return;
      }
    }

    try {
      console.log('[loadEmails] Fetching fresh emails from server...');
      // Fetch page 1 to check for new emails
      const serverResult = await api.fetchEmails(account, activeMailbox, 1);
      console.log('[loadEmails] Server returned', serverResult.emails.length, 'emails, total:', serverResult.total);

      // Get existing cached emails
      const existingEmails = get().emails;
      const existingUids = new Set(existingEmails.map(e => e.uid));

      // Find new emails (ones we don't have cached)
      const newEmails = serverResult.emails.filter(e => !existingUids.has(e.uid));
      console.log('[loadEmails] Found', newEmails.length, 'new emails not in cache');

      // Merge: new emails first, then existing cached emails
      let mergedEmails;
      if (existingEmails.length > 0 && newEmails.length < serverResult.emails.length) {
        // We have cached emails - merge new ones at the beginning
        const newEmailsWithIndex = newEmails.map((email, idx) => ({
          ...email,
          displayIndex: idx,
          isLocal: savedEmailIds.has(email.uid),
          source: 'server'
        }));

        // Shift existing email indices
        const shiftedExisting = existingEmails.map((email, idx) => ({
          ...email,
          displayIndex: newEmails.length + idx,
          isLocal: savedEmailIds.has(email.uid)
        }));

        mergedEmails = [...newEmailsWithIndex, ...shiftedExisting];
        console.log('[loadEmails] Merged to', mergedEmails.length, 'total emails (preserved cache)');
      } else {
        // No cache or all emails are new - use server result as base
        mergedEmails = serverResult.emails.map((email, idx) => ({
          ...email,
          displayIndex: idx,
          isLocal: savedEmailIds.has(email.uid),
          source: 'server'
        }));
      }

      // Build sparse index
      const emailsByIndex = new Map();
      mergedEmails.forEach((email, idx) => {
        emailsByIndex.set(idx, email);
      });

      // Calculate current page based on merged emails
      const currentPage = Math.ceil(mergedEmails.length / 50) || 1;
      const hasMoreEmails = mergedEmails.length < serverResult.total;

      set({
        emails: mergedEmails,
        emailsByIndex,
        loadedRanges: [{ start: 0, end: mergedEmails.length }],
        localEmails,
        savedEmailIds,
        connectionStatus: 'connected',
        connectionError: null,
        connectionErrorType: null,
        currentPage,
        hasMoreEmails,
        totalEmails: serverResult.total,
        loadingMore: false
      });

      // Update sorted emails for memoization
      get().updateSortedEmails();

      // Save merged headers to IndexedDB cache
      db.saveEmailHeaders(activeAccountId, activeMailbox, mergedEmails, serverResult.total)
        .catch(e => console.warn('[loadEmails] Failed to cache headers:', e));

      // Continue loading more if we don't have all emails yet
      if (hasMoreEmails) {
        setTimeout(() => get().loadMoreEmails(), 2000);
      }
    } catch (error) {
      console.error('[loadEmails] Failed to load emails:', error);

      // Determine error type
      let errorType = 'serverError';
      let errorMessage = error.message;

      if (error.message?.includes('password') || error.message?.includes('authentication') || error.message?.includes('No password')) {
        errorType = 'passwordMissing';
        errorMessage = 'Authentication failed. Please check your password in Settings.';
      } else if (error.message?.includes('network') || error.message?.includes('timeout') || error.message?.includes('ENOTFOUND') || error.message?.includes('ECONNREFUSED')) {
        errorType = 'offline';
        errorMessage = 'Cannot connect to email server. Please check your internet connection.';
      }

      // Keep previous/cached emails on error - don't wipe out the cache!
      set({
        emails: previousEmails.length > 0 ? previousEmails : localEmails,
        localEmails,
        savedEmailIds,
        connectionStatus: 'error',
        connectionError: errorMessage,
        connectionErrorType: errorType
      });
    } finally {
      set({ loading: false, loadingMore: false });
    }
  },

  // Load more emails (called internally for background loading)
  loadMoreEmails: async () => {
    const { activeAccountId, accounts, activeMailbox, emails, currentPage, hasMoreEmails, loadingMore } = get();
    const account = accounts.find(a => a.id === activeAccountId);

    // Don't load if already loading, no more emails, or no account
    if (!account || loadingMore || !hasMoreEmails) return;

    // Don't load more if password is missing or offline
    if (!account.password) return;

    set({ loadingMore: true });

    try {
      const nextPage = currentPage + 1;
      const serverResult = await api.fetchEmails(account, activeMailbox, nextPage);

      // Use requestIdleCallback to update state when browser is idle
      // This prevents blocking the UI during heavy loading
      const updateState = () => {
        const newEmails = [...get().emails, ...serverResult.emails];
        set({
          emails: newEmails,
          currentPage: nextPage,
          hasMoreEmails: serverResult.hasMore,
          totalEmails: serverResult.total,
          loadingMore: false
        });

        // Update sorted emails for memoization
        get().updateSortedEmails();

        // Update cached headers with all loaded emails
        db.saveEmailHeaders(activeAccountId, activeMailbox, newEmails, serverResult.total)
          .catch(e => console.warn('[loadMoreEmails] Failed to cache headers:', e));

        // Continue loading in background if there are more emails
        if (serverResult.hasMore) {
          // Longer delay to keep UI responsive
          setTimeout(() => get().loadMoreEmails(), 1000);
        }
      };

      // Use requestIdleCallback if available, otherwise setTimeout
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(updateState, { timeout: 2000 });
      } else {
        setTimeout(updateState, 50);
      }
    } catch (error) {
      console.error('[loadMoreEmails] Failed to load more emails:', error);
      // Don't set hasMoreEmails to false on error - allow retry
      set({ loadingMore: false });

      // Retry after a delay if there are still more emails to load
      if (get().hasMoreEmails && get().emails.length < get().totalEmails) {
        console.log('[loadMoreEmails] Will retry in 3 seconds...');
        setTimeout(() => get().loadMoreEmails(), 3000);
      }
    }
  },

  // Load emails by index range (for virtualized scrolling)
  loadEmailRange: async (startIndex, endIndex) => {
    const { activeAccountId, accounts, activeMailbox, emailsByIndex, loadedRanges, loadingRanges, savedEmailIds } = get();
    const account = accounts.find(a => a.id === activeAccountId);

    if (!account || !account.password) return;

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

        // Update emails array from sparse map for compatibility
        const emailsArray = [];
        for (let i = 0; i < get().totalEmails; i++) {
          if (newEmailsByIndex.has(i)) {
            emailsArray.push(newEmailsByIndex.get(i));
          }
        }

        const loadingRangesAfter = new Set(get().loadingRanges);
        loadingRangesAfter.delete(rangeKey);

        set({
          emailsByIndex: newEmailsByIndex,
          loadedRanges: mergedRanges,
          loadingRanges: loadingRangesAfter,
          emails: emailsArray,
          totalEmails: result.total
        });

        get().updateSortedEmails();

        // Cache the updated emails
        db.saveEmailHeaders(activeAccountId, activeMailbox, emailsArray, result.total)
          .catch(e => console.warn('[loadEmailRange] Failed to cache headers:', e));
      }
    } catch (error) {
      console.error('[loadEmailRange] Failed:', error);
      const loadingRangesAfter = new Set(get().loadingRanges);
      loadingRangesAfter.delete(rangeKey);
      set({ loadingRanges: loadingRangesAfter });
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
  
  // Select email
  selectEmail: async (uid, source = 'server') => {
    const { activeAccountId, accounts, activeMailbox, localEmails } = get();
    const account = accounts.find(a => a.id === activeAccountId);
    const cacheKey = `${activeAccountId}-${activeMailbox}-${uid}`;
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;
    
    set({ selectedEmailId: uid, loadingEmail: true, selectedEmail: null, selectedEmailSource: source });
    
    try {
      let email;
      let actualSource = source;
      
      // Check cache first (also updates LRU timestamp)
      const cachedEmail = get().getFromCache(cacheKey);
      if (cachedEmail) {
        set({ selectedEmail: cachedEmail, selectedEmailSource: source, loadingEmail: false });
        return;
      }
      
      // Try local storage if available
      const localEmail = localEmails.find(e => e.uid === uid);
      
      if (source === 'local-only' || (localEmail && localEmail.html !== undefined)) {
        // Local email with full content
        email = localEmail;
        actualSource = source === 'local-only' ? 'local-only' : 'local';
        // Add to cache
        get().addToCache(cacheKey, email, cacheLimitMB);
      } else if (account) {
        // Fetch from server
        email = await api.fetchEmail(account, uid, activeMailbox);
        actualSource = 'server';
        
        // Add to cache
        get().addToCache(cacheKey, email, cacheLimitMB);
        
        // Mark as read on server (if auto mode)
        const markAsReadMode = useSettingsStore.getState().markAsReadMode;
        if (markAsReadMode === 'auto' && !email.flags?.includes('\\Seen')) {
          try {
            await api.updateEmailFlags(account, uid, ['\\Seen'], 'add', activeMailbox);
            // Update the email flags locally
            email = { ...email, flags: [...(email.flags || []), '\\Seen'] };
          } catch (e) {
            console.warn('Failed to mark as read:', e);
          }
        }
      }
      
      // Update hasAttachments on the list item based on real (non-inline) attachments
      if (email?.attachments) {
        const isEmbeddedInline = (a) => {
          const type = (a.contentType || '').toLowerCase();
          if (!type.startsWith('image/')) return false;
          if (a.contentId && email.html) {
            const cid = a.contentId.replace(/^<|>$/g, '');
            if (email.html.includes(`cid:${cid}`)) return true;
          }
          if (!a.filename && a.size && a.size < 5000) return true;
          return false;
        };
        const hasReal = email.attachments.some(a => !isEmbeddedInline(a));
        set(state => ({
          selectedEmail: email,
          selectedEmailSource: actualSource,
          emails: state.emails.map(e => e.uid === uid ? { ...e, hasAttachments: hasReal } : e)
        }));
      } else {
        set({ selectedEmail: email, selectedEmailSource: actualSource });
      }
    } catch (error) {
      // Fallback to local if server fails
      const localEmail = localEmails.find(e => e.uid === uid);
      if (localEmail) {
        set({ selectedEmail: localEmail, selectedEmailSource: 'local-only' });
      } else {
        set({ error: `Failed to load email: ${error.message}` });
      }
    } finally {
      set({ loadingEmail: false });
    }
  },
  
  // Save email locally
  saveEmailLocally: async (uid) => {
    const { activeAccountId, accounts, activeMailbox, selectedEmail } = get();
    const account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;
    
    const cacheKey = `${activeAccountId}-${activeMailbox}-${uid}`;
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;
    
    try {
      let email;
      
      // Check if we already have the full email in cache
      const cachedEmail = get().getFromCache(cacheKey);
      if (cachedEmail) {
        email = cachedEmail;
      } else if (selectedEmail && selectedEmail.uid === uid) {
        // Use currently selected email
        email = selectedEmail;
      } else {
        // Need to fetch from server
        email = await api.fetchEmail(account, uid, activeMailbox);
        
        // Add to cache
        get().addToCache(cacheKey, email, cacheLimitMB);
      }
      
      // Save to IndexedDB
      await db.saveEmail(email, activeAccountId, activeMailbox);
      
      // Update state
      const savedEmailIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);
      const localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);

      set({ savedEmailIds, localEmails });
      get().updateSortedEmails();
    } catch (error) {
      set({ error: `Failed to save email: ${error.message}` });
      throw error;
    }
  },
  
  // Save multiple emails with progress tracking
  saveEmailsLocally: async (uids) => {
    const { activeAccountId, accounts, activeMailbox } = get();
    const account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;
    
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;
    
    // Initialize progress
    set({ 
      bulkSaveProgress: { 
        total: uids.length, 
        completed: 0, 
        errors: 0, 
        active: true 
      } 
    });
    
    const emails = [];
    let completed = 0;
    let errors = 0;
    
    for (const uid of uids) {
      const cacheKey = `${activeAccountId}-${activeMailbox}-${uid}`;
      
      try {
        let email;
        
        // Check cache first
        const cachedEmail = get().getFromCache(cacheKey);
        if (cachedEmail) {
          email = cachedEmail;
        } else {
          // Need to fetch
          email = await api.fetchEmail(account, uid, activeMailbox);
          
          // Add to cache
          get().addToCache(cacheKey, email, cacheLimitMB);
        }
        
        emails.push(email);
        completed++;
      } catch (error) {
        console.error(`Failed to fetch email ${uid}:`, error);
        errors++;
      }
      
      // Update progress
      set({ 
        bulkSaveProgress: { 
          total: uids.length, 
          completed, 
          errors, 
          active: true 
        } 
      });
    }
    
    // Save all fetched emails to IndexedDB
    if (emails.length > 0) {
      await db.saveEmails(emails, activeAccountId, activeMailbox);
      
      const savedEmailIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);
      const localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);

      set({ savedEmailIds, localEmails });
      get().updateSortedEmails();
    }

    // Mark as complete (keep visible for a moment)
    set({ 
      bulkSaveProgress: { 
        total: uids.length, 
        completed, 
        errors, 
        active: false 
      } 
    });
    
    // Clear progress after delay
    setTimeout(() => {
      set({ bulkSaveProgress: null });
    }, 3000);
  },
  
  // Cancel/dismiss bulk save progress
  dismissBulkProgress: () => {
    set({ bulkSaveProgress: null });
  },
  
  // Remove local email
  removeLocalEmail: async (uid) => {
    const { activeAccountId, activeMailbox, selectedEmailId } = get();
    const localId = `${activeAccountId}-${activeMailbox}-${uid}`;
    
    await db.deleteLocalEmail(localId);
    
    const savedEmailIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);
    const localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);
    
    // Clear selection if we deleted the selected email
    if (selectedEmailId === uid) {
      set({ savedEmailIds, localEmails, selectedEmailId: null, selectedEmail: null, selectedEmailSource: null });
    } else {
      set({ savedEmailIds, localEmails });
    }
    get().updateSortedEmails();
  },
  
  // Delete email from server
  deleteEmailFromServer: async (uid) => {
    const { activeAccountId, accounts, activeMailbox, selectedEmailId } = get();
    const account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;
    
    await api.deleteEmail(account, uid, activeMailbox);
    
    // Clear selection if we deleted the selected email
    if (selectedEmailId === uid) {
      set({ selectedEmailId: null, selectedEmail: null, selectedEmailSource: null });
    }
    
    await get().loadEmails();
  },
  
  // Mark email as read/unread
  markEmailReadStatus: async (uid, read) => {
    const { activeAccountId, accounts, activeMailbox, selectedEmail } = get();
    const account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;
    
    try {
      await api.updateEmailFlags(
        account, 
        uid, 
        ['\\Seen'], 
        read ? 'add' : 'remove', 
        activeMailbox
      );
      
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
        
        return { emails, selectedEmail: updatedSelectedEmail };
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
  
  // Bulk save
  saveSelectedLocally: async () => {
    const { selectedEmailIds } = get();
    await get().saveEmailsLocally(Array.from(selectedEmailIds));
    set({ selectedEmailIds: new Set() });
  },

  // Bulk mark as read
  markSelectedAsRead: async () => {
    const { selectedEmailIds, activeAccountId, accounts, activeMailbox } = get();
    const account = accounts.find(a => a.id === activeAccountId);
    if (!account || selectedEmailIds.size === 0) return;

    const uids = Array.from(selectedEmailIds);
    for (const uid of uids) {
      try {
        await api.updateEmailFlags(account, uid, ['\\Seen'], 'add', activeMailbox);
      } catch (e) {
        console.error(`Failed to mark email ${uid} as read:`, e);
      }
    }

    set(state => ({
      emails: state.emails.map(e =>
        selectedEmailIds.has(e.uid)
          ? { ...e, flags: [...(e.flags || []), '\\Seen'].filter((f, i, a) => a.indexOf(f) === i) }
          : e
      ),
      selectedEmailIds: new Set()
    }));
  },

  // Bulk mark as unread
  markSelectedAsUnread: async () => {
    const { selectedEmailIds, activeAccountId, accounts, activeMailbox } = get();
    const account = accounts.find(a => a.id === activeAccountId);
    if (!account || selectedEmailIds.size === 0) return;

    const uids = Array.from(selectedEmailIds);
    for (const uid of uids) {
      try {
        await api.updateEmailFlags(account, uid, ['\\Seen'], 'remove', activeMailbox);
      } catch (e) {
        console.error(`Failed to mark email ${uid} as unread:`, e);
      }
    }

    set(state => ({
      emails: state.emails.map(e =>
        selectedEmailIds.has(e.uid)
          ? { ...e, flags: (e.flags || []).filter(f => f !== '\\Seen') }
          : e
      ),
      selectedEmailIds: new Set()
    }));
  },

  // Bulk delete from server
  deleteSelectedFromServer: async () => {
    const { selectedEmailIds, activeAccountId, accounts, activeMailbox } = get();
    const account = accounts.find(a => a.id === activeAccountId);
    if (!account || selectedEmailIds.size === 0) return;

    const uids = Array.from(selectedEmailIds);
    for (const uid of uids) {
      try {
        await api.deleteEmail(account, uid, activeMailbox);
      } catch (e) {
        console.error(`Failed to delete email ${uid}:`, e);
      }
    }

    set({ selectedEmailIds: new Set() });
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

    console.log('[mailStore] Refreshing all accounts...');

    let totalUnread = 0;
    let previousEmailCount = get().emails.length;

    for (const account of accounts) {
      // Skip if password is missing
      if (!account.password) {
        console.warn(`[mailStore] Skipping account ${account.email} - no password`);
        continue;
      }

      try {
        // If this is the active account, refresh the current mailbox
        if (account.id === activeAccountId) {
          await get().loadEmails();
          // Count unread in current view
          const currentEmails = get().emails;
          totalUnread += currentEmails.filter(e => !e.flags?.includes('\\Seen')).length;
        } else {
          // For other accounts, fetch INBOX to count unread
          try {
            const result = await api.fetchEmails(account, 'INBOX', 1);
            if (result.emails) {
              totalUnread += result.emails.filter(e => !e.flags?.includes('\\Seen')).length;
            }
          } catch (e) {
            console.warn(`[mailStore] Could not fetch INBOX for ${account.email}:`, e);
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

    return { newEmails, totalUnread };
  },

  // Clear error
  clearError: () => set({ error: null }),

  // Retry keychain access - attempts to fetch password from keychain again
  retryKeychainAccess: async () => {
    const { activeAccountId, accounts } = get();
    const account = accounts.find(a => a.id === activeAccountId);
    if (!account) return false;

    const invoke = window.__TAURI__?.tauri?.invoke || window.__TAURI__?.invoke;
    if (!invoke) return false;

    console.log('[mailStore] Retrying keychain access for account:', account.email);

    try {
      // Try to get password from keychain
      const password = await invoke('get_password', { accountId: account.id });

      if (password) {
        console.log('[mailStore] Password retrieved from keychain');

        // Update account with password
        const updatedAccount = { ...account, password };
        set(state => ({
          accounts: state.accounts.map(a =>
            a.id === account.id ? updatedAccount : a
          )
        }));

        // Reload emails with the password
        await get().loadEmails();
        return true;
      } else {
        console.warn('[mailStore] No password returned from keychain');
        set({
          connectionError: 'Password not found in Keychain. Please add your password in Settings.',
          connectionErrorType: 'passwordMissing'
        });
        return false;
      }
    } catch (error) {
      console.error('[mailStore] Failed to get password from keychain:', error);
      set({
        connectionError: 'Could not access Keychain. Please check system permissions or add password in Settings.',
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

    const account = accounts.find(a => a.id === activeAccountId);
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

      // 2. Search locally saved emails from IndexedDB
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
          console.log(`[Search] Found ${localResults.length} local IndexedDB matches`);
        } catch (error) {
          console.warn('[Search] Local search failed:', error);
        }
      }

      // 3. Search on server via IMAP (if online and not local-only search)
      if (searchFilters.location !== 'local' && account && account.password) {
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
