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
function hashColor(email) {
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

export const useSettingsStore = create(
  persist(
    (set, get) => ({
      // Storage settings
      localStoragePath: '', // User-selected local folder path
      storageConfigured: false,
      
      // Cache settings
      cacheLimitMB: 512, // Maximum cache size in MB (0 = unlimited), default 512MB

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
      
      // Auto-save drafts
      autoSaveDrafts: true,
      autoSaveInterval: 30, // seconds

      // Email sync settings
      refreshInterval: 5, // minutes (0 = disabled)
      refreshOnLaunch: true,
      lastRefreshTime: null,

      // Notification settings
      notificationsEnabled: true,

      // Badge settings
      badgeEnabled: true,
      badgeMode: 'unread', // 'unread' | 'total'

      // Mark as read settings
      markAsReadMode: 'auto', // 'auto' | 'manual'

      // Layout settings
      layoutMode: 'three-column', // 'three-column' | 'two-column'
      viewStyle: 'list', // 'list' | 'chat'
      emailListStyle: 'default', // 'default' | 'compact'
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

      // Email sync settings
      setRefreshInterval: (minutes) => set({ refreshInterval: minutes }),
      setRefreshOnLaunch: (enabled) => set({ refreshOnLaunch: enabled }),
      setLastRefreshTime: (time) => set({ lastRefreshTime: time }),

      // Notification settings
      setNotificationsEnabled: (enabled) => set({ notificationsEnabled: enabled }),

      // Badge settings
      setBadgeEnabled: (enabled) => set({ badgeEnabled: enabled }),
      setBadgeMode: (mode) => set({ badgeMode: mode }),

      // Mark as read settings
      setMarkAsReadMode: (mode) => set({ markAsReadMode: mode }),

      // Layout settings
      setLayoutMode: (mode) => set({ layoutMode: mode }),
      setViewStyle: (style) => set({ viewStyle: style }),
      setEmailListStyle: (style) => set({ emailListStyle: style }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleSidebarCollapsed: () => set(state => ({ sidebarCollapsed: !state.sidebarCollapsed })),
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

      // Reset settings
      resetSettings: () => {
        set({
          localStoragePath: '',
          storageConfigured: false,
          cacheLimitMB: 512,
          localCacheDurationMonths: 3,
          accountOrder: [],
          hiddenAccounts: {},
          lastMailboxPerAccount: {},
          signatures: {},
          displayNames: {},
          accountColors: {},
          defaultSignatureEnabled: true,
          autoSaveDrafts: true,
          autoSaveInterval: 30,
          refreshInterval: 5,
          refreshOnLaunch: true,
          lastRefreshTime: null,
          notificationsEnabled: true,
          badgeEnabled: true,
          badgeMode: 'unread',
          markAsReadMode: 'auto',
          layoutMode: 'three-column',
          viewStyle: 'list',
          emailListStyle: 'default',
          sidebarCollapsed: false,
          listPaneSize: 350,
          viewerPaneSize: 50,
          onboardingComplete: false,
          searchHistoryLimit: 20,
          searchHistory: [],
          filterHistoryPeriodDays: 30,
          topFiltersLimit: 20,
          filterUsageHistory: []
        });
      }
    }),
    {
      name: 'mailvault-settings',
      storage: createJSONStorage(() => safeStorage),
      // Migrate existing users from the old 5GB default to 512MB
      onRehydrateStorage: () => (state) => {
        if (state && state.cacheLimitMB >= 5120) {
          // Use setState to trigger persistence write
          setTimeout(() => useSettingsStore.setState({ cacheLimitMB: 512 }), 0);
        }
      }
    }
  )
);
