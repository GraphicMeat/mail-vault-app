import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { safeStorage } from './safeStorage';

// Palette of visually distinct avatar colors
export const AVATAR_COLORS = [
  '#6366f1', // indigo (default accent)
  '#f43f5e', // rose
  '#10b981', // emerald
  '#f59e0b', // amber
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#ef4444', // red
  '#06b6d4', // cyan
];

// Deterministic color from email string
export function hashColor(email) {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = ((hash << 5) - hash) + email.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// Get the initial letter(s) for an account avatar
export function getAccountInitial(account, displayName) {
  const name = displayName || account.name;
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name[0].toUpperCase();
  }
  return (account.email || '?')[0].toUpperCase();
}

// Get avatar color for an account (user override or deterministic)
export function getAccountColor(accountColors, account) {
  return accountColors[account.id] || hashColor(account.email || account.id);
}

// Default keyboard shortcuts — extracted so resetKeyboardShortcuts can reference it
export const DEFAULT_SHORTCUTS = {
  nextEmail: 'j',
  prevEmail: 'k',
  goToInbox: 'g i',
  goToSent: 'g s',
  goToDrafts: 'g d',
  reply: 'r',
  replyAll: 'a',
  forward: 'f',
  archive: 'e',
  delete: '#',
  moveToFolder: 'm',
  compose: 'c',
  toggleSelect: 'x',
  escape: 'Escape',
  focusSearch: '/',
  showShortcuts: '?',
  openSettings: 'Meta+,',
};

export const useSettingsStore = create(
  persist(
    (set, get) => ({
      // Storage settings
      localStoragePath: '', // User-selected local folder path
      storageConfigured: false,
      
      // Cache settings
      cacheLimitMB: 128, // Maximum cache size in MB (0 = unlimited), default 128MB

      // Local email caching duration (in months)
      localCacheDurationMonths: 3, // Default 3 months
      
      // Signature settings (per account)
      signatures: {}, // { [accountId]: { html: string, text: string, enabled: boolean } }
      
      // Account order (array of account IDs for drag-to-reorder)
      accountOrder: [],

      // Hidden accounts { [accountId]: true } — hidden accounts don't sync and are invisible in sidebar
      hiddenAccounts: {},

      // Last selected mailbox per account { [accountId]: string }
      lastMailboxPerAccount: {},

      // Display settings
      displayNames: {}, // { [accountId]: string }
      accountColors: {}, // { [accountId]: string (hex color) } — user overrides for avatar color
      
      // Default settings
      defaultSignatureEnabled: true,
      
      // Undo send settings
      undoSendEnabled: false,  // OFF by default
      undoSendDelay: 5,        // seconds: 5, 10, 15, 30

      // Auto-save drafts
      autoSaveDrafts: true,
      autoSaveInterval: 30, // seconds

      // Email sync settings
      refreshInterval: 5, // minutes (0 = disabled)
      refreshOnLaunch: true,
      lastRefreshTime: null,

      // Notification settings
      notificationSettings: {
        enabled: true,
        showPreview: true,
        accounts: {},
        // New accounts get default: { enabled: true, folders: ['INBOX'] }
      },

      // Badge settings
      badgeEnabled: true,
      badgeMode: 'unread', // 'unread' | 'total'

      // Mark as read settings
      markAsReadMode: 'delay', // 'delay' | 'auto' | 'manual'
      markAsReadDelay: 3, // seconds to wait before marking as read (when mode is 'delay')

      // Layout settings
      layoutMode: 'three-column', // 'three-column' | 'two-column'
      viewStyle: 'list', // 'list' | 'chat'
      emailListStyle: 'default', // 'default' | 'compact'
      emailListGrouping: 'chronological', // 'chronological' | 'sender'
      threadSortOrder: 'oldest-first', // 'oldest-first' | 'newest-first'
      dateFormat: 'auto', // 'auto' | 'MM/dd/yyyy' | 'dd/MM/yyyy' | 'yyyy-MM-dd' | 'dd MMM yyyy' | 'custom'
      customDateFormat: '', // Only used when dateFormat === 'custom'
      signatureDisplay: 'smart', // 'smart' | 'always-show' | 'always-hide' | 'collapsed'
      sidebarCollapsed: false, // Whether sidebar is in compact/collapsed mode
      listPaneSize: 350, // Width of email list in 3-column, or height in 2-column
      viewerPaneSize: 50, // Percentage of remaining space for viewer in 3-column

      // Onboarding
      onboardingComplete: false,

      // Search settings
      searchHistoryLimit: 20, // Max number of searches to keep (20-500)
      searchHistory: [], // Array of recent search queries
      filterHistoryPeriodDays: 30, // Period for tracking popular filters (1-365 days)
      topFiltersLimit: 20, // Number of top filters to show (1-50)
      filterUsageHistory: [], // Array of { filter, timestamp } for tracking usage

      // Update notification settings
      updateSnoozeUntil: null,
      updateSkippedVersion: null,

      // Email templates
      emailTemplates: [], // Each: { id: string, name: string, body: string, createdAt: string (ISO) }

      // Keyboard shortcuts
      keyboardShortcuts: { ...DEFAULT_SHORTCUTS },
      keyboardShortcutsEnabled: true,

      // Paid user flag (placeholder — swap to real payment check later)
      isPaidUser: false,

      // Link safety (premium feature — enabled for all while isPaidUser is unwired)
      linkSafetyEnabled: true,
      linkSafetyClickConfirm: true,
      setLinkSafetyEnabled: (v) => set({ linkSafetyEnabled: v }),
      setLinkSafetyClickConfirm: (v) => set({ linkSafetyClickConfirm: v }),

      // Auto-cleanup rules
      // Each: { id, accountEmail: '*' | 'email@...', folder, olderThan: { value: number, unit: 'days'|'months' }, action: 'delete'|'archive-delete', enabled: boolean }
      cleanupRules: [],

      // Per-account mailbox memory
      getLastMailbox: (accountId) => get().lastMailboxPerAccount[accountId] || 'INBOX',
      setLastMailbox: (accountId, mailbox) => set({
        lastMailboxPerAccount: { ...get().lastMailboxPerAccount, [accountId]: mailbox }
      }),

      // Account order management
      setAccountOrder: (order) => set({ accountOrder: order }),
      getOrderedAccounts: (accounts) => {
        const order = get().accountOrder;
        if (!order.length) return accounts;
        const orderMap = new Map(order.map((id, i) => [id, i]));
        return [...accounts].sort((a, b) => {
          const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity;
          const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity;
          return ai - bi;
        });
      },

      // Set local storage path
      setLocalStoragePath: (path) => {
        set({ localStoragePath: path, storageConfigured: !!path });
      },
      
      // Set cache limit
      setCacheLimitMB: (limit) => {
        set({ cacheLimitMB: limit });
      },

      // Set local cache duration (validates: 0 (all), 1, 3, 6, or 12 months)
      setLocalCacheDurationMonths: (months) => {
        const validValues = [0, 1, 3, 6, 12]; // 0 = cache all emails
        if (validValues.includes(months)) {
          set({ localCacheDurationMonths: months });
        }
      },
      
      // Signature management
      setSignature: (accountId, signature) => {
        set(state => ({
          signatures: {
            ...state.signatures,
            [accountId]: signature
          }
        }));
      },
      
      getSignature: (accountId) => {
        return get().signatures[accountId] || { html: '', text: '', enabled: false };
      },
      
      // Display name management
      setDisplayName: (accountId, name) => {
        set(state => ({
          displayNames: {
            ...state.displayNames,
            [accountId]: name
          }
        }));
      },
      
      getDisplayName: (accountId) => {
        return get().displayNames[accountId] || '';
      },

      // Account color management
      setAccountColor: (accountId, color) => {
        set(state => ({
          accountColors: { ...state.accountColors, [accountId]: color }
        }));
      },
      clearAccountColor: (accountId) => {
        set(state => {
          const { [accountId]: _, ...rest } = state.accountColors;
          return { accountColors: rest };
        });
      },

      // Hidden account management
      setAccountHidden: (accountId, hidden) => {
        set(state => {
          if (hidden) {
            return { hiddenAccounts: { ...state.hiddenAccounts, [accountId]: true } };
          }
          const { [accountId]: _, ...rest } = state.hiddenAccounts;
          return { hiddenAccounts: rest };
        });
      },
      isAccountHidden: (accountId) => !!get().hiddenAccounts[accountId],

      // Undo send settings
      setUndoSendEnabled: (enabled) => set({ undoSendEnabled: enabled }),
      setUndoSendDelay: (delay) => set({ undoSendDelay: delay }),

      // Email sync settings
      setRefreshInterval: (minutes) => set({ refreshInterval: minutes }),
      setRefreshOnLaunch: (enabled) => set({ refreshOnLaunch: enabled }),
      setLastRefreshTime: (time) => set({ lastRefreshTime: time }),

      // Notification settings
      setNotificationEnabled: (enabled) => set((state) => ({
        notificationSettings: { ...state.notificationSettings, enabled },
      })),

      setNotificationShowPreview: (show) => set((state) => ({
        notificationSettings: { ...state.notificationSettings, showPreview: show },
      })),

      setAccountNotificationEnabled: (accountId, enabled) => set((state) => ({
        notificationSettings: {
          ...state.notificationSettings,
          accounts: {
            ...state.notificationSettings.accounts,
            [accountId]: {
              ...(state.notificationSettings.accounts[accountId] || { enabled: true, folders: ['INBOX'] }),
              enabled,
            },
          },
        },
      })),

      setAccountNotificationFolders: (accountId, folders) => set((state) => ({
        notificationSettings: {
          ...state.notificationSettings,
          accounts: {
            ...state.notificationSettings.accounts,
            [accountId]: {
              ...(state.notificationSettings.accounts[accountId] || { enabled: true, folders: ['INBOX'] }),
              folders,
            },
          },
        },
      })),

      shouldNotify: (accountId, folder) => {
        const { notificationSettings } = get();
        if (!notificationSettings.enabled) return false;
        const acctConfig = notificationSettings.accounts[accountId];
        if (!acctConfig) return true; // Unconfigured accounts default to enabled INBOX
        if (!acctConfig.enabled) return false;
        return acctConfig.folders.includes(folder);
      },

      // Badge settings
      setBadgeEnabled: (enabled) => set({ badgeEnabled: enabled }),
      setBadgeMode: (mode) => set({ badgeMode: mode }),

      // Mark as read settings
      setMarkAsReadMode: (mode) => set({ markAsReadMode: mode }),
      setMarkAsReadDelay: (delay) => set({ markAsReadDelay: delay }),

      // Layout settings
      setLayoutMode: (mode) => set({ layoutMode: mode }),
      setViewStyle: (style) => set({ viewStyle: style }),
      setEmailListStyle: (style) => set({ emailListStyle: style }),
      setEmailListGrouping: (grouping) => set({ emailListGrouping: grouping }),
      setThreadSortOrder: (order) => set({ threadSortOrder: order }),
      setDateFormat: (value) => set({ dateFormat: value }),
      setCustomDateFormat: (value) => set({ customDateFormat: value }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleSidebarCollapsed: () => set(state => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSignatureDisplay: (mode) => set({ signatureDisplay: mode }),
      setListPaneSize: (size) => set({ listPaneSize: size }),
      setViewerPaneSize: (size) => set({ viewerPaneSize: size }),

      // Onboarding
      setOnboardingComplete: (complete) => set({ onboardingComplete: complete }),

      // Search settings
      setSearchHistoryLimit: (limit) => set({ searchHistoryLimit: Math.min(500, Math.max(20, limit)) }),
      addSearchToHistory: (query) => {
        if (!query || !query.trim()) return;
        const trimmed = query.trim();
        set(state => {
          // Remove duplicate if exists, then add to front
          const filtered = state.searchHistory.filter(q => q !== trimmed);
          const newHistory = [trimmed, ...filtered].slice(0, state.searchHistoryLimit);
          return { searchHistory: newHistory };
        });
      },
      removeSearchFromHistory: (query) => {
        set(state => ({
          searchHistory: state.searchHistory.filter(q => q !== query)
        }));
      },
      clearSearchHistory: () => set({ searchHistory: [] }),

      // Filter history settings
      setFilterHistoryPeriodDays: (days) => set({ filterHistoryPeriodDays: Math.min(365, Math.max(30, days)) }),
      setTopFiltersLimit: (limit) => set({ topFiltersLimit: Math.min(50, Math.max(1, limit)) }),

      // Track filter usage
      addFilterUsage: (filterType, filterValue) => {
        if (!filterValue) return;
        set(state => {
          const entry = {
            type: filterType, // 'sender', 'folder', 'dateRange', 'hasAttachments'
            value: filterValue,
            timestamp: Date.now()
          };
          // Keep only last 1000 entries to prevent unbounded growth
          const newHistory = [entry, ...state.filterUsageHistory].slice(0, 1000);
          return { filterUsageHistory: newHistory };
        });
      },

      // Get popular filters within the configured period
      getPopularFilters: () => {
        const state = get();
        const cutoffTime = Date.now() - (state.filterHistoryPeriodDays * 24 * 60 * 60 * 1000);

        // Filter to entries within the period
        const recentUsage = state.filterUsageHistory.filter(entry => entry.timestamp >= cutoffTime);

        // Count occurrences by type and value
        const counts = {};
        recentUsage.forEach(entry => {
          const key = `${entry.type}:${entry.value}`;
          counts[key] = (counts[key] || 0) + 1;
        });

        // Convert to array and sort by count
        const sorted = Object.entries(counts)
          .map(([key, count]) => {
            const [type, ...valueParts] = key.split(':');
            return { type, value: valueParts.join(':'), count };
          })
          .sort((a, b) => b.count - a.count)
          .slice(0, state.topFiltersLimit);

        return sorted;
      },

      clearFilterHistory: () => set({ filterUsageHistory: [] }),

      // Email template methods
      addEmailTemplate: (name, body) => set((state) => ({
        emailTemplates: [...state.emailTemplates, {
          id: crypto.randomUUID(),
          name,
          body,
          createdAt: new Date().toISOString(),
        }],
      })),

      updateEmailTemplate: (id, updates) => set((state) => ({
        emailTemplates: state.emailTemplates.map(t =>
          t.id === id ? { ...t, ...updates } : t
        ),
      })),

      removeEmailTemplate: (id) => set((state) => ({
        emailTemplates: state.emailTemplates.filter(t => t.id !== id),
      })),

      reorderEmailTemplates: (templates) => set({ emailTemplates: templates }),

      // Keyboard shortcut methods
      setKeyboardShortcut: (action, keybinding) => set((state) => ({
        keyboardShortcuts: { ...state.keyboardShortcuts, [action]: keybinding },
      })),
      setKeyboardShortcutsEnabled: (enabled) => set({ keyboardShortcutsEnabled: enabled }),
      resetKeyboardShortcuts: () => set({ keyboardShortcuts: { ...DEFAULT_SHORTCUTS } }),

      // Auto-cleanup rule methods
      addCleanupRule: (rule) => {
        if (!get().isPaidUser) return;
        set((state) => ({
          cleanupRules: [...state.cleanupRules, { ...rule, id: crypto.randomUUID() }],
        }));
      },

      updateCleanupRule: (id, updates) => {
        if (!get().isPaidUser) return;
        set((state) => ({
          cleanupRules: state.cleanupRules.map(r => r.id === id ? { ...r, ...updates } : r),
        }));
      },

      removeCleanupRule: (id) => set((state) => ({
        cleanupRules: state.cleanupRules.filter(r => r.id !== id),
      })),

      toggleCleanupRule: (id) => {
        if (!get().isPaidUser) return;
        set((state) => ({
          cleanupRules: state.cleanupRules.map(r =>
            r.id === id ? { ...r, enabled: !r.enabled } : r
          ),
        }));
      },

      // Update notification methods
      setUpdateSnooze: () => set({ updateSnoozeUntil: Date.now() + 24 * 60 * 60 * 1000 }),
      clearUpdateSnooze: () => set({ updateSnoozeUntil: null }),
      setSkippedVersion: (version) => set({ updateSkippedVersion: version }),
      clearSkippedVersion: () => set({ updateSkippedVersion: null }),

      // Reset settings
      resetSettings: () => {
        set({
          localStoragePath: '',
          storageConfigured: false,
          cacheLimitMB: 128,
          localCacheDurationMonths: 3,
          accountOrder: [],
          hiddenAccounts: {},
          lastMailboxPerAccount: {},
          signatures: {},
          displayNames: {},
          accountColors: {},
          defaultSignatureEnabled: true,
          undoSendEnabled: false,
          undoSendDelay: 5,
          autoSaveDrafts: true,
          autoSaveInterval: 30,
          refreshInterval: 5,
          refreshOnLaunch: true,
          lastRefreshTime: null,
          notificationSettings: {
            enabled: true,
            showPreview: true,
            accounts: {},
          },
          badgeEnabled: true,
          badgeMode: 'unread',
          markAsReadMode: 'delay',
          markAsReadDelay: 3,
          layoutMode: 'three-column',
          viewStyle: 'list',
          emailListStyle: 'default',
          emailListGrouping: 'chronological',
          threadSortOrder: 'oldest-first',
          dateFormat: 'auto',
          customDateFormat: '',
          signatureDisplay: 'smart',
          sidebarCollapsed: false,
          listPaneSize: 350,
          viewerPaneSize: 50,
          onboardingComplete: false,
          searchHistoryLimit: 20,
          searchHistory: [],
          filterHistoryPeriodDays: 30,
          topFiltersLimit: 20,
          filterUsageHistory: [],
          updateSnoozeUntil: null,
          updateSkippedVersion: null,
          emailTemplates: [],
          keyboardShortcuts: { ...DEFAULT_SHORTCUTS },
          keyboardShortcutsEnabled: true,
          isPaidUser: false,
          linkSafetyEnabled: true,
          linkSafetyClickConfirm: true,
          cleanupRules: [],
        });
      }
    }),
    {
      name: 'mailvault-settings',
      storage: createJSONStorage(() => safeStorage),
      // Migrate existing users from old defaults (5GB or 512MB) down to 128MB
      onRehydrateStorage: () => (state) => {
        if (state && state.cacheLimitMB >= 512) {
          setTimeout(() => useSettingsStore.setState({ cacheLimitMB: 128 }), 0);
        }
        // Migrate old notificationsEnabled → notificationSettings
        if (state && 'notificationsEnabled' in state && !state.notificationSettings) {
          const enabled = state.notificationsEnabled;
          setTimeout(() => useSettingsStore.setState({
            notificationSettings: { enabled, showPreview: true, accounts: {} },
            notificationsEnabled: undefined,
          }), 0);
        }
      }
    }
  )
);
