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
      actionButtonDisplay: 'icon-only', // 'icon-only' | 'icon-label' | 'text-only'
      sidebarCollapsed: false, // Whether sidebar is in compact/collapsed mode
      sidebarAccountsRatio: 0.4, // Ratio of accounts section height vs total available (0.2 - 0.8)
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

      // Billing
      billingEmail: '',
      billingProfile: null,   // cached { customerId, hasSubscription, status, priceId, interval, currentPeriodEnd, cancelAtPeriodEnd, premiumAccess, clientLimit, activeClientCount, activeClients, currentClientId, clientAccessGranted }
      billingLastChecked: null,
      setBillingEmail: (email) => set({ billingEmail: email }),
      setBillingProfile: (profile) => set({ billingProfile: profile, billingLastChecked: Date.now() }),
      clearBillingProfile: () => set({ billingProfile: null, billingLastChecked: null, billingEmail: '' }),

      // Link safety settings
      linkSafetyEnabled: true,
      linkSafetyClickConfirm: true,
      linkAlerts: {}, // { [uid]: 'red'|'yellow' } — persisted link alert results
      unreadPerAccount: {}, // { [accountId]: number } — persisted unread counts
      setLinkSafetyEnabled: (v) => set({ linkSafetyEnabled: v }),
      setLinkSafetyClickConfirm: (v) => set({ linkSafetyClickConfirm: v }),
      setLinkAlert: (uid, level) => set(s => ({ linkAlerts: { ...s.linkAlerts, [uid]: level } })),
      setUnreadPerAccount: (counts) => set({ unreadPerAccount: counts }),
      setUnreadForAccount: (accountId, count) => set(s => ({ unreadPerAccount: { ...s.unreadPerAccount, [accountId]: count } })),

      // Auto-cleanup rules
      // Each: { id, accountEmail: '*' | 'email@...', folder, olderThan: { value: number, unit: 'days'|'months' }, action: 'delete'|'archive-delete', enabled: boolean }
      cleanupRules: [],

      // Global backup configuration
      backupGlobalEnabled: false,    // Master switch: true = all accounts use global schedule
      backupGlobalConfig: { interval: 'daily', hourlyInterval: 1, timeOfDay: '03:00', dayOfWeek: 1 },
      backupScope: 'archived',       // 'archived' = only locally archived emails, 'all' = everything from server
      backupCustomPath: null,        // LEGACY — kept for migration only. Use externalBackupLocation instead.
      // Native-backed external backup location (resolved via Rust bookmark/path commands)
      // Shape: { displayPath, status, platform, lastValidatedAt, lastError } | null
      externalBackupLocation: null,

      // Per-account backup configuration (used when backupGlobalEnabled=false, or as overrides)
      backupSchedules: {},
      // Shape: { [accountId]: { enabled: bool, interval: 'hourly'|'daily'|'weekly', hourlyInterval: 2, timeOfDay: '03:00', dayOfWeek: 1, folders: string[]|null } }
      // folders: null = all folders, string[] = specific folder paths

      // Backup runtime state (persisted for display across restarts)
      backupState: {},
      // Shape: { [accountId]: { lastBackupTime: number|null, lastStatus: 'success'|'failed'|null, lastError: string|null, emailsBackedUp: number, nextRunTime: number|null } }

      // Backup history (max 5 entries per account)
      backupHistory: {},
      // Shape: { [accountId]: [{ timestamp: number, emailsBackedUp: number, durationSecs: number, success: bool, error: string|null }] }

      // Active backup progress moved to ephemeral backupStore.js (not persisted)

      // Migration state
      activeMigration: null,        // MigrationProgress object from Tauri events, or null
      migrationHistory: [],         // Array of last 5 completed/failed/cancelled migrations
      incompleteMigration: null,    // MigrationState loaded from disk on startup (for resume banner)

      // Migration actions
      setActiveMigration: (migration) => set({ activeMigration: migration }),
      clearActiveMigration: () => set({ activeMigration: null }),
      addMigrationHistory: (entry) => set(state => ({
          migrationHistory: [entry, ...state.migrationHistory].slice(0, 5)
      })),
      setIncompleteMigration: (val) => set({ incompleteMigration: val }),
      clearIncompleteMigration: () => set({ incompleteMigration: null }),

      // Migration live log (10 entries max, displayed in MigrationSettings)
      migrationLogEntries: [],

      // Folder email counts from background counting (keyed by folder_path)
      migrationFolderCounts: {},

      // Migration log actions
      addMigrationLogEntry: (entry) => set(state => {
          // Deduplicate: skip if last entry has same timestamp+sender+subject
          const last = state.migrationLogEntries[state.migrationLogEntries.length - 1];
          if (last && last.timestamp === entry.timestamp && last.sender === entry.sender && last.subject === entry.subject) {
              return state;
          }
          return { migrationLogEntries: [...state.migrationLogEntries, entry].slice(-10) };
      }),
      clearMigrationLogEntries: () => set({ migrationLogEntries: [] }),

      // Folder count actions
      setMigrationFolderCount: (folderPath, count, counting) => set(state => ({
          migrationFolderCounts: {
              ...state.migrationFolderCounts,
              [folderPath]: { count, counting }
          }
      })),
      clearMigrationFolderCounts: () => set({ migrationFolderCounts: {} }),

      // Backup notification preferences
      backupNotifyOnSuccess: true,
      backupNotifyOnFailure: true,

      // Global backup actions
      setBackupGlobalEnabled: (val) => set({ backupGlobalEnabled: val }),
      setBackupGlobalConfig: (config) => set(state => ({
        backupGlobalConfig: { ...state.backupGlobalConfig, ...config }
      })),
      setBackupScope: (scope) => set({ backupScope: scope }),
      setBackupCustomPath: (path) => set({ backupCustomPath: path }),
      setExternalBackupLocation: (loc) => set({ externalBackupLocation: loc }),

      // Per-account backup actions
      setBackupSchedule: (accountId, config) => set(state => ({
        backupSchedules: { ...state.backupSchedules, [accountId]: config }
      })),

      removeBackupSchedule: (accountId) => set(state => {
        const { [accountId]: _, ...rest } = state.backupSchedules;
        return { backupSchedules: rest };
      }),

      updateBackupState: (accountId, update) => set(state => ({
        backupState: {
          ...state.backupState,
          [accountId]: { ...(state.backupState[accountId] || {}), ...update }
        }
      })),

      addBackupHistoryEntry: (accountId, entry) => set(state => {
        const existing = state.backupHistory[accountId] || [];
        const updated = [entry, ...existing].slice(0, 5);
        return { backupHistory: { ...state.backupHistory, [accountId]: updated } };
      }),

      setBackupNotifyOnSuccess: (val) => set({ backupNotifyOnSuccess: val }),
      setBackupNotifyOnFailure: (val) => set({ backupNotifyOnFailure: val }),

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
      setSidebarAccountsRatio: (ratio) => set({ sidebarAccountsRatio: Math.max(0.15, Math.min(0.55, ratio)) }),
      setSignatureDisplay: (mode) => set({ signatureDisplay: mode }),
      setActionButtonDisplay: (mode) => set({ actionButtonDisplay: mode }),
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
        if (!hasPremiumAccess(get().billingProfile)) return;
        set((state) => ({
          cleanupRules: [...state.cleanupRules, { ...rule, id: crypto.randomUUID() }],
        }));
      },

      updateCleanupRule: (id, updates) => {
        if (!hasPremiumAccess(get().billingProfile)) return;
        set((state) => ({
          cleanupRules: state.cleanupRules.map(r => r.id === id ? { ...r, ...updates } : r),
        }));
      },

      removeCleanupRule: (id) => set((state) => ({
        cleanupRules: state.cleanupRules.filter(r => r.id !== id),
      })),

      toggleCleanupRule: (id) => {
        if (!hasPremiumAccess(get().billingProfile)) return;
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
          actionButtonDisplay: 'icon-only',
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
          billingEmail: '',
          billingProfile: null,
          billingLastChecked: null,
          linkSafetyEnabled: true,
          linkSafetyClickConfirm: true,
          cleanupRules: [],
          activeMigration: null,
          migrationHistory: [],
          incompleteMigration: null,
        });
      }
    }),
    {
      name: 'mailvault-settings',
      version: 3,
      storage: createJSONStorage(() => safeStorage),
      merge: (persisted, current) => ({ ...current, ...(persisted || {}) }),
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

/**
 * Check whether the premium dev override should be honored.
 * Returns true only when running inside the Tauri desktop app
 * connected to the Vite dev server (npm run tauri:dev).
 */
export function isTauriDevPremiumOverrideEnabled() {
  if (typeof window === 'undefined') return false;
  if (!window.__TAURI__) return false;
  if (!import.meta.env.DEV) return false;
  if (window.location.origin !== 'http://localhost:5173') return false;
  return typeof window.__MAILVAULT_FORCE_PREMIUM__ === 'boolean';
}

/**
 * Derive premium access from a billing profile.
 * - trialing, active, past_due → access
 * - canceled → access only until currentPeriodEnd
 * - incomplete, unpaid → no access
 */
export function hasPremiumAccess(billingProfile) {
  // Override honored only in Tauri dev mode (npm run tauri:dev)
  if (isTauriDevPremiumOverrideEnabled()) {
    return window.__MAILVAULT_FORCE_PREMIUM__;
  }

  if (!billingProfile?.hasSubscription) return false;
  const { status, currentPeriodEnd, premiumAccess, clientAccessGranted } = billingProfile;

  // When client registration is active, server returns clientAccessGranted
  // which means: subscription is premium AND this device is registered
  if (typeof clientAccessGranted === 'boolean') return clientAccessGranted;

  // Server already computes premiumAccess — trust it if present
  if (typeof premiumAccess === 'boolean') return premiumAccess;
  // Client-side fallback
  if (['trialing', 'active', 'past_due'].includes(status)) return true;
  if (status === 'canceled' && currentPeriodEnd) return new Date(currentPeriodEnd).getTime() > Date.now();
  return false;
}
