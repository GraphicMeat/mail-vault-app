import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { safeStorage } from './safeStorage';

// Palette of visually distinct avatar colors
// An account's identity colour, and deliberately none of the reserved words.
//
// This list used to open with indigo, emerald, amber, blue and red — the
// accent plus the entire custody-and-status vocabulary. That was survivable
// while the colour was a 7px avatar dot, but the identity colour is now
// structural: it spines and washes the active account row. An account hashed
// to emerald would have claimed "in your vault" down the whole rail, and one
// hashed to red would have read as destructive. Every hue below is chosen to
// sit outside `--mail-accent`, `--mail-local`, `--mail-server`,
// `--mail-only-copy`, `--mail-warning` and `--mail-danger`.
//
// Changing this list re-hashes accounts that never set an explicit colour;
// an explicit `accountColors[account.id]` override still wins.
export const AVATAR_COLORS = [
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#64748b', // slate
  '#d946ef', // fuchsia
  '#f43f5e', // rose
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

      // User-added classification categories
      customCategories: [],

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
      sendAsAddresses: {}, // { [accountId]: string } — outgoing From override; login is unchanged
      lastComposeIdentity: null, // { accountId, address } — identity of the last sent message; new composes default to it
      accountColors: {}, // { [accountId]: string (hex color) } — user overrides for avatar color
      
      // Default settings
      defaultSignatureEnabled: true,
      
      // Send delay (undo send) — 0 = immediate, or seconds: 15, 30, 60, 120, 180, 240, 300
      undoSendEnabled: false,  // kept for backward compat; true when sendDelay > 0
      undoSendDelay: 5,        // kept for backward compat
      sendDelay: 0,            // seconds — 0 = immediate (no delay)

      // Auto-save drafts
      autoSaveDrafts: true,
      autoSaveInterval: 30, // seconds

      // Spellcheck while composing — the toolbar toggle writes here so the
      // choice outlives the compose window that made it.
      spellcheckEnabled: true,

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
      timeFormat: 'auto', // 'auto' (system locale) | '12h' | '24h'
      signatureDisplay: 'smart', // 'smart' | 'always-show' | 'always-hide' | 'collapsed'
      actionButtonDisplay: 'icon-only', // 'icon-only' | 'icon-label' | 'text-only'
      emailViewerTheme: 'system', // 'light' | 'dark' | 'system' — default theme for email content rendering
      sidebarCollapsed: false, // Whether sidebar is in compact/collapsed mode
      sidebarAccountsRatio: 0.4, // Ratio of accounts section height vs total available (0.2 - 0.8)
      sidebarStyle: 'list', // 'list' | 'tagcloud' — render accounts & folders as list rows or wrapped bubble tags
      listPaneSize: 350, // Width of the email list in three-column
      // Height of the email list when the panes are stacked. Separate from the
      // width above: one number read on two axes let a legal list width become
      // a list height that pushed the reading pane off the bottom of the window.
      listPaneHeight: 320,
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

      // Server-resolved premium pricing, shared by every paywall so the Billing
      // tab and the feature overlays can never quote different currencies.
      // { currency, monthly, yearly, pricingMode, fetchedAt } — minor units.
      premiumPricing: null,
      setPremiumPricing: (p) => set({ premiumPricing: p ? { ...p, fetchedAt: Date.now() } : null }),

      // Share-to-unlock reward (non-MAS): premium granted for starring/sharing.
      // expiresAt is the running unlock deadline; each action grants days once.
      shareGrant: { expiresAt: null, github: false, x: false, linkedin: false, githubUser: null },
      shareUnlockLastShownAt: null,
      // Grant premium days for a completed action. Idempotent per action; days stack.
      recordShareAction: (action, days, meta = {}) => set((s) => {
        const g = s.shareGrant || { expiresAt: null };
        if (g[action]) return {}; // already counted this action
        const base = Math.max(Date.now(), g.expiresAt || 0);
        return {
          shareGrant: {
            ...g,
            ...meta,
            [action]: true,
            expiresAt: base + days * 86_400_000,
          },
        };
      }),
      markShareUnlockShown: () => set({ shareUnlockLastShownAt: Date.now() }),

      // Post-backup automation upsell — shown once ever after the first manual backup.
      upsellBackupShown: false,
      markUpsellBackupShown: () => set({ upsellBackupShown: true }),

      // Link safety settings
      linkSafetyEnabled: true,
      linkSafetyClickConfirm: true,
      // Persisted link alert results, keyed `accountId-mailbox-uid`. A bare UID
      // is unique per mailbox only, so keying by it lit account A's red flag on
      // account B's message with the same UID. Old (v3) maps are dropped in the
      // migration below — every entry is recomputed on next open.
      linkAlerts: {}, // { [`${accountId}-${mailbox}-${uid}`]: 'red'|'yellow' }
      unreadPerAccount: {}, // { [accountId]: number } — persisted unread counts
      setLinkSafetyEnabled: (v) => set({ linkSafetyEnabled: v }),
      setLinkSafetyClickConfirm: (v) => set({ linkSafetyClickConfirm: v }),
      // `key` comes from emailScopeKey(email, mailState). Unresolvable message
      // → no key → no write: a warning stored under the wrong message is worse
      // than one that has to be rescanned.
      setLinkAlert: (key, level) => set(s => (key ? { linkAlerts: { ...s.linkAlerts, [key]: level } } : s)),
      setUnreadPerAccount: (counts) => set({ unreadPerAccount: counts }),
      setUnreadForAccount: (accountId, count) => set(s => ({ unreadPerAccount: { ...s.unreadPerAccount, [accountId]: count } })),

      // Auto-cleanup rules
      // Each: { id, accountEmail: '*' | 'email@...', folder, olderThan: { value: number, unit: 'days'|'months' }, action: 'delete'|'archive-delete', enabled: boolean }
      cleanupRules: [],

      // Helper mode: 'on-demand' (default) or 'always-on' (recommended)
      // on-demand: helper starts with app, stops when app quits
      // always-on: helper registered for background availability, persists after app close
      daemonMode: 'on-demand',

      // Time Capsule snapshot configuration
      snapshotAutoEnabled: true,     // Whether automatic snapshots are created after backups
      snapshotCadence: 'after_every_backup', // 'after_every_backup' | 'daily' | 'weekly'
      snapshotLastTimes: {},         // { [accountId]: timestamp } — last auto-snapshot per account

      // Global backup configuration
      backupGlobalEnabled: false,    // Master switch: true = all accounts use global schedule
      backupGlobalConfig: { interval: 'daily', hourlyInterval: 1, timeOfDay: '03:00', dayOfWeek: 1 },
      backupScope: 'archived',       // 'archived' = only locally archived emails, 'all' = everything from server
      backupCustomPath: null,        // LEGACY — kept for migration only. Use externalBackupLocation instead.
      // Native-backed external backup location (resolved via Rust bookmark/path commands)
      // Shape: { displayPath, status, platform, lastValidatedAt, lastError } | null
      externalBackupLocation: null,
      // Where the working copy of the mail is stored. null until the app reports it.
      vaultStatus: null,

      // Per-account backup configuration (used when backupGlobalEnabled=false, or as overrides)
      backupSchedules: {},
      // Shape: { [accountId]: { enabled: bool, interval: 'hourly'|'daily'|'weekly', hourlyInterval: 2, timeOfDay: '03:00', dayOfWeek: 1, folders: string[]|null } }
      // folders: null = all folders, string[] = specific folder paths

      // Per-account daily transfer limits — read by the daemon from disk to decide
      // whether to warn or pause sync. Missing entry = cap off, warn on.
      transferLimits: {},
      // Shape: { [accountId]: { capEnabled: bool, warnEnabled: bool, dailyDownLimitBytes: number|null, dailyUpLimitBytes: number|null } }

      // Show the transfer-stats bubble when hovering an account in the sidebar.
      transferHoverEnabled: true,

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

      // Restore-to-server state
      activeRestore: null,          // RestoreProgress object from Tauri events, or null
      restoreDetected: null,        // { accountId, account, folders: [{ mailbox, localCount }] } or null
      restoreDismissedIds: [],      // account ids the user dismissed this session (no re-prompt)

      setActiveRestore: (restore) => set({ activeRestore: restore }),
      clearActiveRestore: () => set({ activeRestore: null }),
      setRestoreDetected: (detected) => set({ restoreDetected: detected }),
      clearRestoreDetected: () => set({ restoreDetected: null }),
      dismissRestore: (accountId) => set((s) => ({
        restoreDetected: null,
        restoreDismissedIds: s.restoreDismissedIds.includes(accountId)
          ? s.restoreDismissedIds
          : [...s.restoreDismissedIds, accountId],
      })),

      // Change Server modal — global, opened via account id (sidebar/settings wire it up)
      changeServerAccountId: null,
      openChangeServer: (accountId) => set({ changeServerAccountId: accountId }),
      closeChangeServer: () => set({ changeServerAccountId: null }),

      // Backup notification preferences
      backupNotifyOnSuccess: true,
      backupNotifyOnFailure: true,

      // Time Capsule actions
      setSnapshotAutoEnabled: (val) => set({ snapshotAutoEnabled: val }),
      setSnapshotCadence: (cadence) => set({ snapshotCadence: cadence }),
      recordSnapshotTime: (accountId) => set(state => ({
        snapshotLastTimes: { ...state.snapshotLastTimes, [accountId]: Date.now() }
      })),

      // Daemon actions
      setDaemonMode: (mode) => set({ daemonMode: mode }),

      // Global backup actions
      setBackupGlobalEnabled: (val) => set({ backupGlobalEnabled: val }),
      setBackupGlobalConfig: (config) => set(state => ({
        backupGlobalConfig: { ...state.backupGlobalConfig, ...config }
      })),
      setBackupScope: (scope) => set({ backupScope: scope }),
      setBackupCustomPath: (path) => set({ backupCustomPath: path }),
      setExternalBackupLocation: (loc) => set({ externalBackupLocation: loc }),
      setVaultStatus: (status) => set({ vaultStatus: status }),

      // Per-account backup actions
      setBackupSchedule: (accountId, config) => set(state => ({
        backupSchedules: { ...state.backupSchedules, [accountId]: config }
      })),

      setTransferHoverEnabled: (enabled) => set({ transferHoverEnabled: !!enabled }),

      // Per-account transfer limit actions
      setTransferLimit: (accountId, patch) => set(state => ({
        transferLimits: {
          ...state.transferLimits,
          [accountId]: { ...(state.transferLimits[accountId] || {}), ...patch },
        }
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

      // Custom categories
      addCustomCategory: (name) => {
        const current = get().customCategories;
        const trimmed = name.trim();
        if (trimmed && !current.includes(trimmed)) {
          set({ customCategories: [...current, trimmed] });
        }
      },
      removeCustomCategory: (name) => {
        set({ customCategories: get().customCategories.filter(c => c !== name) });
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

      // Send-as address management — the outgoing identity only. IMAP/SMTP
      // still authenticate as account.email, which stays the account key.
      setSendAsAddress: (accountId, address) => {
        set(state => ({
          sendAsAddresses: {
            ...state.sendAsAddresses,
            [accountId]: (address || '').trim()
          }
        }));
      },

      getSendAsAddress: (accountId) => {
        return get().sendAsAddresses?.[accountId] || '';
      },

      setLastComposeIdentity: (accountId, address) => {
        set({ lastComposeIdentity: { accountId, address: (address || '').trim() } });
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
      setSendDelay: (seconds) => set({ sendDelay: seconds, undoSendEnabled: seconds > 0, undoSendDelay: seconds }),

      // Compose spellcheck
      setSpellcheckEnabled: (enabled) => set({ spellcheckEnabled: !!enabled }),

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
      setTimeFormat: (value) => set({ timeFormat: value }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleSidebarCollapsed: () => set(state => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarAccountsRatio: (ratio) => set({ sidebarAccountsRatio: Math.max(0.1, Math.min(0.85, ratio)) }),
      setSidebarStyle: (style) => set({ sidebarStyle: style === 'tagcloud' ? 'tagcloud' : 'list' }),
      setSignatureDisplay: (mode) => set({ signatureDisplay: mode }),
      setActionButtonDisplay: (mode) => set({ actionButtonDisplay: mode }),
      setEmailViewerTheme: (mode) => set({ emailViewerTheme: mode }),
      setListPaneSize: (size) => set({ listPaneSize: size }),
      setListPaneHeight: (size) => set({ listPaneHeight: size }),
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
          customCategories: [],
          accountOrder: [],
          hiddenAccounts: {},
          lastMailboxPerAccount: {},
          signatures: {},
          displayNames: {},
          sendAsAddresses: {},
          lastComposeIdentity: null,
          accountColors: {},
          defaultSignatureEnabled: true,
          undoSendEnabled: false,
          undoSendDelay: 5,
          autoSaveDrafts: true,
          autoSaveInterval: 30,
          spellcheckEnabled: true,
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
          timeFormat: 'auto',
          signatureDisplay: 'smart',
          actionButtonDisplay: 'icon-only',
          emailViewerTheme: 'system',
          sidebarCollapsed: false,
          sidebarStyle: 'list',
          listPaneSize: 350,
          listPaneHeight: 320,
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
          activeRestore: null,
          restoreDetected: null,
          restoreDismissedIds: [],
        });
      }
    }),
    {
      name: 'mailvault-settings',
      version: 4,
      storage: createJSONStorage(() => safeStorage),
      // v3 → v4: linkAlerts moved from bare-UID keys to `accountId-mailbox-uid`.
      // The old keys can't be upgraded — a UID alone doesn't say which mailbox
      // or account it belonged to — so drop the map. Alerts come back as each
      // message is opened.
      migrate: (persisted, version) => (
        version < 4 && persisted ? { ...persisted, linkAlerts: {} } : persisted
      ),
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
/** True while an unexpired share-to-unlock grant is active (non-MAS reward). */
export function isShareGrantActive() {
  try {
    const g = useSettingsStore.getState().shareGrant;
    return !!(g && g.expiresAt && g.expiresAt > Date.now());
  } catch {
    return false;
  }
}

export function hasPremiumAccess(billingProfile) {
  // Override honored only in Tauri dev mode (npm run tauri:dev)
  if (isTauriDevPremiumOverrideEnabled()) {
    return window.__MAILVAULT_FORCE_PREMIUM__;
  }

  // Share-to-unlock reward grants full premium for its window.
  if (isShareGrantActive()) return true;

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
