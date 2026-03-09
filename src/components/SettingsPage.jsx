import React, { useState, useEffect } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useThemeStore } from '../stores/themeStore';
import { useSettingsStore, AVATAR_COLORS, getAccountInitial, getAccountColor, DEFAULT_SHORTCUTS } from '../stores/settingsStore';
import { formatEmailDate } from '../utils/dateFormat';
import { safeStorage } from '../stores/safeStorage';
import { motion, AnimatePresence } from 'framer-motion';
import { getOAuth2AuthUrl, exchangeOAuth2Code } from '../services/api';
import { runCleanupRules } from '../services/cleanupEngine';
import {
  X,
  Sun,
  Moon,
  FolderOpen,
  Save,
  User,
  Mail,
  FileText,
  HardDrive,
  Shield,
  Palette,
  Check,
  Trash2,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Download,
  Upload,
  Database,
  Loader,
  RefreshCw,
  Bell,
  ScrollText,
  Key,
  LayoutGrid,
  Columns,
  Rows,
  RotateCcw,
  Search,
  Clock,
  Filter,
  MessageSquare,
  List,
  Link,
  Unlink,
  Copy,
  Plus,
  Eye,
  EyeOff,
  PenTool,
  Keyboard,
  SendHorizontal,
  Lock,
  Play,
  Pencil,
  AlertTriangle,
  Sparkles
} from 'lucide-react';

function ToggleSwitch({ active, onClick }) {
  return (
    <div
      className={`toggle-switch ${active ? 'active' : ''}`}
      onClick={onClick}
    />
  );
}

export function SettingsPage({ onClose, onAddAccount, onReportBug }) {
  const { accounts, removeAccount } = useMailStore();
  const { theme, toggleTheme } = useThemeStore();
  const {
    localStoragePath,
    setLocalStoragePath,
    signatures,
    setSignature,
    getSignature,
    displayNames,
    setDisplayName,
    getDisplayName,
    refreshInterval,
    setRefreshInterval,
    refreshOnLaunch,
    setRefreshOnLaunch,
    lastRefreshTime,
    notificationSettings,
    setNotificationEnabled,
    setNotificationShowPreview,
    setAccountNotificationEnabled,
    setAccountNotificationFolders,
    badgeEnabled,
    setBadgeEnabled,
    badgeMode,
    setBadgeMode,
    markAsReadMode,
    setMarkAsReadMode,
    layoutMode,
    setLayoutMode,
    viewStyle,
    setViewStyle,
    emailListStyle,
    setEmailListStyle,
    threadSortOrder,
    setThreadSortOrder,
    setOnboardingComplete,
    searchHistoryLimit,
    setSearchHistoryLimit,
    searchHistory,
    clearSearchHistory,
    filterHistoryPeriodDays,
    setFilterHistoryPeriodDays,
    topFiltersLimit,
    setTopFiltersLimit,
    filterUsageHistory,
    clearFilterHistory,
    localCacheDurationMonths,
    setLocalCacheDurationMonths,
    accountOrder,
    getOrderedAccounts,
    setAccountOrder,
    accountColors,
    setAccountColor,
    clearAccountColor,
    hiddenAccounts,
    setAccountHidden,
    isAccountHidden,
    dateFormat,
    customDateFormat,
    setDateFormat,
    setCustomDateFormat,
    signatureDisplay,
    setSignatureDisplay,
    keyboardShortcuts,
    keyboardShortcutsEnabled,
    setKeyboardShortcut,
    setKeyboardShortcutsEnabled,
    resetKeyboardShortcuts,
    undoSendEnabled,
    setUndoSendEnabled,
    undoSendDelay,
    setUndoSendDelay,
    emailTemplates,
    addEmailTemplate,
    updateEmailTemplate,
    removeEmailTemplate,
    isPaidUser,
    cleanupRules,
    addCleanupRule,
    updateCleanupRule,
    removeCleanupRule,
    toggleCleanupRule
  } = useSettingsStore();
  
  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const [activeTab, setActiveTab] = useState('general');
  const [selectedAccountId, setSelectedAccountId] = useState(accounts[0]?.id || null);
  const [signatureText, setSignatureText] = useState('');
  const [accountDisplayName, setAccountDisplayName] = useState('');
  const [saved, setSaved] = useState(false);
  const [movingStorage, setMovingStorage] = useState(false);
  const [supportsFileSystem, setSupportsFileSystem] = useState(false);
  const [showExportChoice, setShowExportChoice] = useState(false);
  const [logs, setLogs] = useState('');
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [localStorageUsage, setLocalStorageUsage] = useState(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [clearCacheConfirm, setClearCacheConfirm] = useState(false);
  const [clearCacheResult, setClearCacheResult] = useState(null);
  const [oauthReconnecting, setOauthReconnecting] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [rebindingAction, setRebindingAction] = useState(null); // action key being rebound
  const [rebindFirstKey, setRebindFirstKey] = useState(null); // first key of multi-key sequence
  const [rebindTimer, setRebindTimer] = useState(null); // timeout for multi-key sequence
  const [expandedNotifAccounts, setExpandedNotifAccounts] = useState({});
  const [templateForm, setTemplateForm] = useState(null); // null | { mode: 'add' } | { mode: 'edit', id }
  const [templateName, setTemplateName] = useState('');
  const [templateBody, setTemplateBody] = useState('');
  const [cleanupForm, setCleanupForm] = useState(null); // null | { mode: 'add' } | { mode: 'edit', id }
  const [cleanupAccount, setCleanupAccount] = useState('all');
  const [cleanupFolder, setCleanupFolder] = useState('INBOX');
  const [cleanupAge, setCleanupAge] = useState(30);
  const [cleanupUnit, setCleanupUnit] = useState('days');
  const [cleanupAction, setCleanupAction] = useState('delete');
  const [cleanupDeleteConfirm, setCleanupDeleteConfirm] = useState(null);
  const [showCleanupFirstTimeWarning, setShowCleanupFirstTimeWarning] = useState(false);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState(null);
  const orderedAccounts = getOrderedAccounts(accounts);

  const moveAccount = (accountId, direction) => {
    const ids = orderedAccounts.map(a => a.id);
    const idx = ids.indexOf(accountId);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= ids.length) return;
    ids.splice(idx, 1);
    ids.splice(newIdx, 0, accountId);
    setAccountOrder(ids);
  };
  
  // Check for File System Access API support
  useEffect(() => {
    setSupportsFileSystem('showDirectoryPicker' in window);
  }, []);

  // Load local storage usage
  useEffect(() => {
    const loadStorageUsage = async () => {
      try {
        const { getStorageUsage } = await import('../services/db');
        const usage = await getStorageUsage();
        setLocalStorageUsage(usage);
      } catch (error) {
        console.error('Failed to get storage usage:', error);
      }
    };
    loadStorageUsage();
  }, []);
  
  // Load signature and display name when account changes
  useEffect(() => {
    if (selectedAccountId) {
      const sig = getSignature(selectedAccountId);
      setSignatureText(sig.text || '');
      setAccountDisplayName(getDisplayName(selectedAccountId) || '');
      setShowRemoveConfirm(false);
    }
  }, [selectedAccountId]);

  // Keyboard shortcut rebind listener
  useEffect(() => {
    if (!rebindingAction) return;

    const handleRebindKey = (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Ignore bare modifier keys
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;

      // Build key string with modifiers
      let key = '';
      if (e.metaKey) key += 'Meta+';
      if (e.ctrlKey) key += 'Ctrl+';
      if (e.altKey) key += 'Alt+';
      if (e.shiftKey && e.key.length > 1) key += 'Shift+';
      key += e.key.length === 1 ? e.key : e.key;

      // Cancel rebind on Escape (without modifiers)
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !rebindFirstKey) {
        setRebindingAction(null);
        setRebindFirstKey(null);
        if (rebindTimer) { clearTimeout(rebindTimer); setRebindTimer(null); }
        return;
      }

      if (rebindFirstKey) {
        // Second key of multi-key sequence
        if (rebindTimer) clearTimeout(rebindTimer);
        const binding = rebindFirstKey + ' ' + (e.key.length === 1 ? e.key : e.key);
        setKeyboardShortcut(rebindingAction, binding);
        setRebindingAction(null);
        setRebindFirstKey(null);
        setRebindTimer(null);
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
        // Single printable key — could be start of multi-key sequence
        const firstKey = e.key;
        setRebindFirstKey(firstKey);
        const timer = setTimeout(() => {
          // No second key within 500ms — save as single key
          setKeyboardShortcut(rebindingAction, firstKey);
          setRebindingAction(null);
          setRebindFirstKey(null);
          setRebindTimer(null);
        }, 500);
        setRebindTimer(timer);
      } else {
        // Modifier combo or special key — save immediately
        setKeyboardShortcut(rebindingAction, key);
        setRebindingAction(null);
        setRebindFirstKey(null);
      }
    };

    window.addEventListener('keydown', handleRebindKey, true);
    return () => {
      window.removeEventListener('keydown', handleRebindKey, true);
      if (rebindTimer) clearTimeout(rebindTimer);
    };
  }, [rebindingAction, rebindFirstKey, rebindTimer, setKeyboardShortcut]);

  // Helper: find duplicate bindings
  const findDuplicateBinding = (action, binding) => {
    if (!binding) return null;
    for (const [otherAction, otherBinding] of Object.entries(keyboardShortcuts)) {
      if (otherAction !== action && otherBinding === binding) return otherAction;
    }
    return null;
  };

  // Shortcut action labels (same as ShortcutsModal)
  const SHORTCUT_ACTION_LABELS = {
    nextEmail: 'Next email',
    prevEmail: 'Previous email',
    goToInbox: 'Go to Inbox',
    goToSent: 'Go to Sent',
    goToDrafts: 'Go to Drafts',
    reply: 'Reply',
    replyAll: 'Reply all',
    forward: 'Forward',
    archive: 'Archive',
    delete: 'Delete',
    moveToFolder: 'Move to folder',
    compose: 'Compose',
    toggleSelect: 'Select / deselect',
    escape: 'Clear selection / close',
    focusSearch: 'Search',
    showShortcuts: 'Show shortcuts',
    openSettings: 'Open settings',
  };

  const SHORTCUT_CATEGORIES = [
    { title: 'Navigation', actions: ['nextEmail', 'prevEmail', 'goToInbox', 'goToSent', 'goToDrafts'] },
    { title: 'Actions', actions: ['reply', 'replyAll', 'forward', 'archive', 'delete', 'moveToFolder', 'compose'] },
    { title: 'Selection', actions: ['toggleSelect', 'escape'] },
    { title: 'UI', actions: ['focusSearch', 'showShortcuts', 'openSettings'] },
  ];

  // Format keybinding for display
  const formatKeybindingDisplay = (keybinding) => {
    if (!keybinding) return '—';
    const modMap = { Meta: '\u2318', Ctrl: '\u2303', Alt: '\u2325', Shift: '\u21E7' };
    if (keybinding.includes('+')) {
      return keybinding.split('+').map(p => modMap[p] || p).join('');
    }
    if (keybinding.includes(' ')) {
      return keybinding.split(' ').join(' then ');
    }
    if (keybinding === 'Escape') return 'Esc';
    return keybinding;
  };

  const handleSaveAccountSettings = () => {
    if (selectedAccountId) {
      setDisplayName(selectedAccountId, accountDisplayName);
      setSignature(selectedAccountId, {
        text: signatureText,
        html: signatureText.replace(/\n/g, '<br>'),
        enabled: !!signatureText.trim()
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };
  
  const handleSelectFolder = async () => {
    if (!supportsFileSystem) {
      return;
    }
    
    try {
      const dirHandle = await window.showDirectoryPicker({
        mode: 'readwrite'
      });
      
      const newPath = dirHandle.name;
      
      if (localStoragePath && localStoragePath !== newPath) {
        const shouldMove = confirm(
          'Do you want to move all existing emails and settings to the new folder?'
        );
        if (shouldMove) {
          setMovingStorage(true);
          setTimeout(() => {
            setLocalStoragePath(newPath);
            setMovingStorage(false);
          }, 500);
          return;
        }
      }
      
      setLocalStoragePath(newPath);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Folder selection error:', err);
      }
    }
  };
  
  // Export backup as ZIP of .eml files via Rust
  const handleExportData = () => {
    if (!invoke) {
      alert('Backup export is only available in the desktop app.');
      return;
    }
    setShowExportChoice(true);
  };

  const doExport = async (archivedOnly) => {
    setShowExportChoice(false);
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');

      const destPath = await save({
        defaultPath: `mailvault-backup-${new Date().toISOString().split('T')[0]}.zip`,
        filters: [{ name: 'ZIP Archives', extensions: ['zip'] }],
      });

      if (!destPath) return;

      const settingsData = {
        theme: safeStorage.getItem('mailvault-theme'),
        settings: safeStorage.getItem('mailvault-settings'),
      };

      const db = await import('../services/db');
      await db.initDB();
      const accountsList = await db.getAccountsWithoutPasswords();
      const backupAccounts = accountsList.map(a => ({
        email: a.email,
        imapServer: a.imapServer,
        smtpServer: a.smtpServer,
      }));

      // Show progress modal
      const store = useMailStore.getState();
      store.setExportProgress({ total: 0, completed: 0, active: true, mode: 'export' });

      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen('export-progress', (event) => {
        const p = event.payload;
        useMailStore.getState().setExportProgress({
          total: p.total, completed: p.completed, active: p.active, mode: 'export'
        });
      });

      try {
        await invoke('export_backup', {
          destPath,
          archivedOnly,
          settingsJson: JSON.stringify(settingsData),
          accountsJson: JSON.stringify(backupAccounts),
        });
      } finally {
        unlisten();
      }

      // Auto-dismiss after 3 seconds
      setTimeout(() => useMailStore.getState().dismissExportProgress(), 3000);
    } catch (error) {
      console.error('Export error:', error);
      useMailStore.getState().dismissExportProgress();
      alert('Failed to export backup: ' + (error.message || error));
    }
  };

  // Import backup from ZIP via Rust
  const handleImportData = async () => {
    if (!invoke) {
      alert('Backup import is only available in the desktop app.');
      return;
    }

    try {
      const { open } = await import('@tauri-apps/plugin-dialog');

      const sourcePath = await open({
        filters: [{ name: 'ZIP Archives', extensions: ['zip'] }],
        multiple: false,
      });

      if (!sourcePath) return;

      // Show progress modal
      const store = useMailStore.getState();
      store.setExportProgress({ total: 0, completed: 0, active: true, mode: 'import' });

      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen('import-progress', (event) => {
        const p = event.payload;
        useMailStore.getState().setExportProgress({
          total: p.total, completed: p.completed, active: p.active, mode: 'import'
        });
      });

      let result;
      try {
        result = await invoke('import_backup', { sourcePath });
      } finally {
        unlisten();
      }

      // Restore settings if present
      if (result.settingsJson) {
        try {
          const settings = JSON.parse(result.settingsJson);
          if (settings.theme) safeStorage.setItem('mailvault-theme', settings.theme);
          if (settings.settings) safeStorage.setItem('mailvault-settings', settings.settings);
        } catch (e) {
          console.warn('Failed to restore settings:', e);
        }
      }

      // Show completion briefly then reload
      setTimeout(() => {
        useMailStore.getState().dismissExportProgress();
        let msg = `Backup imported successfully!\n\n${result.emailCount} email(s) from ${result.accountCount} account(s).`;
        if (result.newAccounts.length > 0) {
          msg += `\n\nNew accounts created (re-enter passwords in Settings):\n• ${result.newAccounts.join('\n• ')}`;
        }
        alert(msg + '\n\nThe page will reload.');
        window.location.reload();
      }, 1500);
    } catch (error) {
      console.error('Import error:', error);
      useMailStore.getState().dismissExportProgress();
      alert('Failed to import backup: ' + (error.message || error));
    }
  };
  
  // Reconnect OAuth2 account
  const handleOAuth2Reconnect = async () => {
    if (!selectedAccountId) return;
    setOauthReconnecting(true);

    try {
      const account = accounts.find(a => a.id === selectedAccountId);
      const provider = account?.oauth2Provider || 'microsoft';
      const { authUrl, state } = await getOAuth2AuthUrl(account?.email, provider);

      if (invoke) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(authUrl);
      } else {
        window.open(authUrl, '_blank');
      }

      const tokenData = await exchangeOAuth2Code(state);

      const { saveAccount } = await import('../services/db');
      if (account) {
        await saveAccount({
          ...account,
          oauth2AccessToken: tokenData.accessToken,
          oauth2RefreshToken: tokenData.refreshToken,
          oauth2ExpiresAt: tokenData.expiresAt,
        });
      }

      const { init } = useMailStore.getState();
      await init();

      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error('OAuth2 reconnect failed:', error);
      alert('Reconnect failed: ' + (error.message || error));
    } finally {
      setOauthReconnecting(false);
    }
  };

  const selectedAccount = accounts.find(a => a.id === selectedAccountId);

  const tabs = [
    { id: 'general', label: 'General', icon: Palette },
    { id: 'accounts', label: 'Accounts', icon: User },
    { id: 'storage', label: 'Storage', icon: HardDrive },
    { id: 'logs', label: 'Logs', icon: ScrollText },
  ];

  // Tauri invoke for reading logs
  const invoke = window.__TAURI__?.core?.invoke;

  // Load logs when switching to logs tab
  useEffect(() => {
    if (activeTab === 'logs' && invoke) {
      loadLogs();
    }
  }, [activeTab]);

  const loadLogs = async () => {
    if (!invoke) return;
    setLoadingLogs(true);
    try {
      const logContent = await invoke('read_logs', { lines: 500 });
      setLogs(logContent);
    } catch (error) {
      console.error('Failed to load logs:', error);
      setLogs('Failed to load logs: ' + error);
    } finally {
      setLoadingLogs(false);
    }
  };

  // Update account password
  const handleUpdatePassword = async () => {
    if (!selectedAccountId || !newPassword.trim()) return;

    try {
      // Store the new password in keychain
      if (invoke) {
        await invoke('store_password', {
          accountId: selectedAccountId,
          password: newPassword
        });
      }

      // Re-save to db to trigger password storage
      const account = accounts.find(a => a.id === selectedAccountId);
      if (account) {
        const { saveAccount } = await import('../services/db');
        await saveAccount({ ...account, password: newPassword });
      }

      // Reinitialize the mail store to pick up the new password
      const { init } = useMailStore.getState();
      await init();

      setEditingPassword(false);
      setNewPassword('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error('Failed to update password:', error);
      alert('Failed to update password: ' + error);
    }
  };
  
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      data-testid="settings-page"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="bg-mail-bg border border-mail-border rounded-xl shadow-2xl 
                   w-full max-w-7xl h-[92vh] flex overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar */}
        <div className="w-56 bg-mail-surface border-r border-mail-border flex flex-col">
          <div className="p-4 border-b border-mail-border">
            <h2 className="text-lg font-semibold text-mail-text">Settings</h2>
          </div>
          
          <nav className="flex-1 p-2">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg
                           text-left transition-colors mb-1
                           ${activeTab === tab.id 
                             ? 'bg-mail-accent/10 text-mail-accent' 
                             : 'text-mail-text-muted hover:bg-mail-surface-hover hover:text-mail-text'}`}
              >
                <tab.icon size={18} />
                <span className="text-sm font-medium">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
        
        {/* Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-mail-border">
            <h3 className="text-lg font-semibold text-mail-text">
              {tabs.find(t => t.id === activeTab)?.label}
            </h3>
            <button
              onClick={onClose}
              className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            >
              <X size={20} className="text-mail-text-muted" />
            </button>
          </div>
          
          {/* Content Area */}
          <div className="flex-1 overflow-y-auto">
            {/* General Settings */}
            {activeTab === 'general' && (
              <div className="p-6 space-y-6">
                {/* Appearance */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <Palette size={18} className="text-mail-accent" />
                    Appearance
                  </h4>
                  
                  <div className="space-y-4">
                    <div className="flex items-center justify-between py-2">
                      <div>
                        <div className="font-medium text-mail-text">Theme</div>
                        <div className="text-sm text-mail-text-muted">
                          Choose between light and dark mode
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Sun size={18} className={theme === 'light' ? 'text-mail-accent' : 'text-mail-text-muted'} />
                        <ToggleSwitch
                          active={theme === 'dark'}
                          onClick={toggleTheme}
                        />
                        <Moon size={18} className={theme === 'dark' ? 'text-mail-accent' : 'text-mail-text-muted'} />
                      </div>
                    </div>

                    {/* Date Format */}
                    <div className="pt-4 border-t border-mail-border">
                      <div className="font-medium text-mail-text mb-1">Date Format</div>
                      <div className="text-sm text-mail-text-muted mb-3">
                        Controls how dates appear in the email list
                      </div>
                      <select
                        value={dateFormat}
                        onChange={(e) => setDateFormat(e.target.value)}
                        className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:border-mail-accent transition-all cursor-pointer"
                      >
                        <option value="auto">System Default ({navigator.language})</option>
                        <option value="MM/dd/yyyy">MM/DD/YYYY (US)</option>
                        <option value="dd/MM/yyyy">DD/MM/YYYY (Europe)</option>
                        <option value="yyyy-MM-dd">YYYY-MM-DD (ISO)</option>
                        <option value="dd MMM yyyy">DD MMM YYYY (e.g., 25 Feb 2024)</option>
                        <option value="custom">Custom...</option>
                      </select>
                      {dateFormat === 'custom' && (
                        <div className="mt-3">
                          <input
                            type="text"
                            value={customDateFormat}
                            onChange={(e) => setCustomDateFormat(e.target.value)}
                            placeholder="e.g., dd.MM.yyyy"
                            className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:border-mail-accent transition-all"
                          />
                          <p className="text-xs text-mail-text-muted mt-1">
                            Uses date-fns tokens: yyyy=year, MM=month, dd=day, HH=hour, mm=minute
                          </p>
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-4 text-xs text-mail-text-muted">
                        <span>Today: <span className="text-mail-text">{formatEmailDate(new Date().toISOString())}</span></span>
                        <span>Older: <span className="text-mail-text">{formatEmailDate('2023-06-15T10:00:00Z')}</span></span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Layout */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <LayoutGrid size={18} className="text-mail-accent" />
                    Layout
                  </h4>

                  <p className="text-sm text-mail-text-muted mb-4">
                    Choose how emails are displayed. Drag the divider between panes to resize.
                  </p>

                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => setLayoutMode('three-column')}
                      className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                                ${layoutMode === 'three-column'
                                  ? 'border-mail-accent bg-mail-accent/10'
                                  : 'border-mail-border hover:border-mail-accent/50'}`}
                    >
                      <div className="flex gap-1 w-full h-12">
                        <div className="w-1/4 bg-mail-border rounded" />
                        <div className="w-1/3 bg-mail-border rounded" />
                        <div className="flex-1 bg-mail-border rounded" />
                      </div>
                      <div className="flex items-center gap-2 text-sm font-medium text-mail-text">
                        <Columns size={16} />
                        Three Columns
                      </div>
                      <span className="text-xs text-mail-text-muted">
                        Sidebar | List | Content
                      </span>
                    </button>

                    <button
                      onClick={() => setLayoutMode('two-column')}
                      className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                                ${layoutMode === 'two-column'
                                  ? 'border-mail-accent bg-mail-accent/10'
                                  : 'border-mail-border hover:border-mail-accent/50'}`}
                    >
                      <div className="flex gap-1 w-full h-12">
                        <div className="w-1/4 bg-mail-border rounded" />
                        <div className="flex-1 flex flex-col gap-1">
                          <div className="h-1/2 bg-mail-border rounded" />
                          <div className="h-1/2 bg-mail-border rounded" />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-sm font-medium text-mail-text">
                        <Rows size={16} />
                        Two Columns
                      </div>
                      <span className="text-xs text-mail-text-muted">
                        List above Content
                      </span>
                    </button>
                  </div>
                </div>

                {/* View Style */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <MessageSquare size={18} className="text-mail-accent" />
                    View Style
                  </h4>

                  <p className="text-sm text-mail-text-muted mb-4">
                    Choose how to display your emails. Traditional list view or chat-style conversation view.
                  </p>

                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => setViewStyle('list')}
                      className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                                ${viewStyle === 'list'
                                  ? 'border-mail-accent bg-mail-accent/10'
                                  : 'border-mail-border hover:border-mail-accent/50'}`}
                    >
                      <div className="w-full h-12 flex flex-col gap-1">
                        <div className="h-3 bg-mail-border rounded w-full" />
                        <div className="h-3 bg-mail-border rounded w-full" />
                        <div className="h-3 bg-mail-border rounded w-3/4" />
                      </div>
                      <div className="flex items-center gap-2 text-sm font-medium text-mail-text">
                        <List size={16} />
                        List View
                      </div>
                      <span className="text-xs text-mail-text-muted">
                        Traditional email list
                      </span>
                    </button>

                    <button
                      onClick={() => setViewStyle('chat')}
                      className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                                ${viewStyle === 'chat'
                                  ? 'border-mail-accent bg-mail-accent/10'
                                  : 'border-mail-border hover:border-mail-accent/50'}`}
                    >
                      <div className="w-full h-12 flex flex-col justify-end gap-1">
                        <div className="h-2.5 bg-mail-border rounded-full w-2/3 self-start" />
                        <div className="h-2.5 bg-mail-accent/30 rounded-full w-1/2 self-end" />
                        <div className="h-2.5 bg-mail-border rounded-full w-3/5 self-start" />
                      </div>
                      <div className="flex items-center gap-2 text-sm font-medium text-mail-text">
                        <MessageSquare size={16} />
                        Chat View
                      </div>
                      <span className="text-xs text-mail-text-muted">
                        Conversation style
                      </span>
                    </button>
                  </div>
                </div>

                {/* Email List Style */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <List size={18} className="text-mail-accent" />
                    Email List Style
                  </h4>

                  <p className="text-sm text-mail-text-muted mb-4">
                    Choose how emails appear in the list.
                  </p>

                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => setEmailListStyle('default')}
                      className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                                ${emailListStyle === 'default'
                                  ? 'border-mail-accent bg-mail-accent/10'
                                  : 'border-mail-border hover:border-mail-accent/50'}`}
                    >
                      <div className="w-full h-12 flex flex-col gap-1.5 justify-center">
                        <div className="flex items-center gap-1">
                          <div className="w-2 h-2 bg-mail-border rounded-sm flex-shrink-0" />
                          <div className="h-2 bg-mail-border rounded flex-1" />
                          <div className="h-2 bg-mail-border rounded w-8" />
                        </div>
                        <div className="flex items-center gap-1">
                          <div className="w-2 h-2 bg-mail-border rounded-sm flex-shrink-0" />
                          <div className="h-2 bg-mail-border rounded flex-1" />
                          <div className="h-2 bg-mail-border rounded w-8" />
                        </div>
                      </div>
                      <span className="text-sm font-medium text-mail-text">Default</span>
                      <span className="text-xs text-mail-text-muted">Single line per email</span>
                    </button>

                    <button
                      onClick={() => setEmailListStyle('compact')}
                      className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                                ${emailListStyle === 'compact'
                                  ? 'border-mail-accent bg-mail-accent/10'
                                  : 'border-mail-border hover:border-mail-accent/50'}`}
                    >
                      <div className="w-full h-12 flex flex-col gap-0.5 justify-center">
                        <div className="flex items-center gap-1">
                          <div className="h-1.5 bg-mail-text-muted/30 rounded w-16" />
                          <div className="h-1.5 bg-mail-border rounded w-6 ml-auto" />
                        </div>
                        <div className="h-2 bg-mail-border rounded w-full" />
                        <div className="h-px bg-mail-border/50 w-full mt-0.5" />
                        <div className="flex items-center gap-1">
                          <div className="h-1.5 bg-mail-text-muted/30 rounded w-12" />
                          <div className="h-1.5 bg-mail-border rounded w-6 ml-auto" />
                        </div>
                        <div className="h-2 bg-mail-border rounded w-3/4" />
                      </div>
                      <span className="text-sm font-medium text-mail-text">Compact</span>
                      <span className="text-xs text-mail-text-muted">Sender + subject on two lines</span>
                    </button>
                  </div>
                </div>

                {/* Thread Sort Order */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <List size={18} className="text-mail-accent" />
                    Thread Sort Order
                  </h4>
                  <p className="text-sm text-mail-text-muted mb-4">
                    Choose how emails are ordered within a thread conversation.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => setThreadSortOrder('oldest-first')}
                      className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                                ${threadSortOrder === 'oldest-first'
                                  ? 'border-mail-accent bg-mail-accent/10'
                                  : 'border-mail-border hover:border-mail-accent/50'}`}
                    >
                      <ChevronDown size={24} className="text-mail-text-muted" />
                      <span className="text-sm font-medium text-mail-text">Oldest First</span>
                      <span className="text-xs text-mail-text-muted">Conversation flows top to bottom</span>
                    </button>
                    <button
                      onClick={() => setThreadSortOrder('newest-first')}
                      className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                                ${threadSortOrder === 'newest-first'
                                  ? 'border-mail-accent bg-mail-accent/10'
                                  : 'border-mail-border hover:border-mail-accent/50'}`}
                    >
                      <ChevronUp size={24} className="text-mail-text-muted" />
                      <span className="text-sm font-medium text-mail-text">Newest First</span>
                      <span className="text-xs text-mail-text-muted">Latest reply at the top</span>
                    </button>
                  </div>
                </div>

                {/* Signature Display */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <PenTool size={18} className="text-mail-accent" />
                    Signature Display
                  </h4>
                  <p className="text-sm text-mail-text-muted mb-4">
                    Control how email signatures appear in threads and conversations.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { value: 'smart', label: 'Smart', desc: 'Show once per sender, collapse duplicates' },
                      { value: 'always-show', label: 'Always Show', desc: 'Never collapse signatures' },
                      { value: 'always-hide', label: 'Always Hide', desc: 'Collapse all signatures' },
                      { value: 'collapsed', label: 'Collapsed', desc: 'Collapsed with toggle to expand' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setSignatureDisplay(opt.value)}
                        className={`p-3 rounded-lg border-2 transition-all text-left
                          ${signatureDisplay === opt.value
                            ? 'border-mail-accent bg-mail-accent/10'
                            : 'border-mail-border hover:border-mail-accent/50'}`}
                      >
                        <span className="text-sm font-medium text-mail-text block">{opt.label}</span>
                        <span className="text-xs text-mail-text-muted">{opt.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Email Sync */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <RefreshCw size={18} className="text-mail-accent" />
                    Email Sync
                  </h4>

                  <p className="text-sm text-mail-text-muted mb-4">
                    Automatically check for new emails at regular intervals.
                  </p>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between py-2">
                      <div>
                        <div className="font-medium text-mail-text">Refresh on app launch</div>
                        <div className="text-sm text-mail-text-muted">
                          Check for new emails when the app starts
                        </div>
                      </div>
                      <ToggleSwitch
                        active={refreshOnLaunch}
                        onClick={() => setRefreshOnLaunch(!refreshOnLaunch)}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-mail-text mb-2">
                        Auto-refresh interval
                      </label>
                      <select
                        value={refreshInterval}
                        onChange={(e) => setRefreshInterval(parseInt(e.target.value))}
                        className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                  text-mail-text focus:border-mail-accent transition-all
                                  cursor-pointer"
                      >
                        <option value={0}>Never</option>
                        <option value={1}>Every minute</option>
                        <option value={5}>Every 5 minutes</option>
                        <option value={15}>Every 15 minutes</option>
                        <option value={30}>Every 30 minutes</option>
                        <option value={60}>Every hour</option>
                        <option value={120}>Every 2 hours</option>
                        <option value={360}>Every 6 hours</option>
                        <option value={720}>Every 12 hours</option>
                        <option value={1440}>Every 24 hours</option>
                      </select>
                    </div>

                    {lastRefreshTime && (
                      <div className="flex items-center gap-2 p-3 bg-mail-bg rounded-lg text-sm text-mail-text-muted">
                        <RefreshCw size={14} />
                        <span>
                          Last refreshed: {(() => {
                            const diff = Date.now() - lastRefreshTime;
                            const minutes = Math.floor(diff / 60000);
                            if (minutes < 1) return 'Just now';
                            if (minutes === 1) return '1 minute ago';
                            if (minutes < 60) return `${minutes} minutes ago`;
                            const hours = Math.floor(minutes / 60);
                            if (hours === 1) return '1 hour ago';
                            if (hours < 24) return `${hours} hours ago`;
                            const days = Math.floor(hours / 24);
                            if (days === 1) return '1 day ago';
                            return `${days} days ago`;
                          })()}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Notifications */}
                <div data-testid="settings-notifications" className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <Bell size={18} className="text-mail-accent" />
                    Notifications
                  </h4>

                  <p className="text-sm text-mail-text-muted mb-4">
                    Get notified when new emails arrive.
                  </p>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between py-2">
                      <div>
                        <div className="font-medium text-mail-text">Enable desktop notifications</div>
                        <div className="text-sm text-mail-text-muted">
                          Show desktop notifications for new emails
                        </div>
                      </div>
                      <ToggleSwitch
                        active={notificationSettings.enabled}
                        onClick={() => setNotificationEnabled(!notificationSettings.enabled)}
                      />
                    </div>

                    {notificationSettings.enabled && (
                      <>
                        <div className="flex items-center justify-between py-2">
                          <div>
                            <div className="font-medium text-mail-text">Show email preview</div>
                            <div className="text-sm text-mail-text-muted">
                              Show sender and subject in notifications
                            </div>
                          </div>
                          <ToggleSwitch
                            active={notificationSettings.showPreview}
                            onClick={() => setNotificationShowPreview(!notificationSettings.showPreview)}
                          />
                        </div>

                        {/* Per-account notification settings */}
                        <div className="border-t border-mail-border pt-3">
                          <div className="text-sm font-medium text-mail-text mb-3">Per-account settings</div>
                          <div className="space-y-1">
                            {orderedAccounts.filter(a => !isAccountHidden(a.id)).map(account => {
                              const acctConfig = notificationSettings.accounts[account.id] || { enabled: true, folders: ['INBOX'] };
                              const isExpanded = expandedNotifAccounts[account.id];
                              const commonFolders = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'];
                              const displayName = getDisplayName(account.id) || account.email;

                              return (
                                <div key={account.id} className="rounded-lg border border-mail-border overflow-hidden">
                                  <div className="flex items-center gap-3 px-3 py-2.5">
                                    {/* Account avatar */}
                                    <div
                                      className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0"
                                      style={{ backgroundColor: getAccountColor(accountColors, account) }}
                                    >
                                      {getAccountInitial(account, displayName)}
                                    </div>

                                    {/* Account name + expand toggle */}
                                    <button
                                      className="flex-1 text-left min-w-0"
                                      onClick={() => setExpandedNotifAccounts(prev => ({
                                        ...prev,
                                        [account.id]: !prev[account.id]
                                      }))}
                                    >
                                      <div className="text-sm font-medium text-mail-text truncate">{displayName}</div>
                                    </button>

                                    {/* Expand chevron */}
                                    {acctConfig.enabled && (
                                      <button
                                        className="p-1 text-mail-text-muted hover:text-mail-text transition-colors"
                                        onClick={() => setExpandedNotifAccounts(prev => ({
                                          ...prev,
                                          [account.id]: !prev[account.id]
                                        }))}
                                        title="Configure folders"
                                      >
                                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                      </button>
                                    )}

                                    {/* Account toggle */}
                                    <ToggleSwitch
                                      active={acctConfig.enabled}
                                      onClick={() => setAccountNotificationEnabled(account.id, !acctConfig.enabled)}
                                    />
                                  </div>

                                  {/* Expanded folder list */}
                                  {acctConfig.enabled && isExpanded && (
                                    <div className="px-3 pb-3 pt-1 border-t border-mail-border bg-mail-bg/50">
                                      <div className="text-xs text-mail-text-muted mb-2">Notify for these folders:</div>
                                      <div className="space-y-1.5">
                                        {commonFolders.map(folder => {
                                          const isChecked = acctConfig.folders.includes(folder);
                                          return (
                                            <label key={folder} className="flex items-center gap-2 cursor-pointer group">
                                              <input
                                                type="checkbox"
                                                checked={isChecked}
                                                onChange={() => {
                                                  const newFolders = isChecked
                                                    ? acctConfig.folders.filter(f => f !== folder)
                                                    : [...acctConfig.folders, folder];
                                                  setAccountNotificationFolders(account.id, newFolders);
                                                }}
                                                className="rounded border-mail-border text-mail-accent focus:ring-mail-accent"
                                              />
                                              <span className="text-sm text-mail-text group-hover:text-mail-accent transition-colors">
                                                {folder}
                                              </span>
                                            </label>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    )}

                    <div className="flex items-center justify-between py-2">
                      <div>
                        <div className="font-medium text-mail-text">Show badge count</div>
                        <div className="text-sm text-mail-text-muted">
                          Display email count on dock icon
                        </div>
                      </div>
                      <ToggleSwitch
                        active={badgeEnabled}
                        onClick={() => setBadgeEnabled(!badgeEnabled)}
                      />
                    </div>

                    {badgeEnabled && (
                      <div>
                        <label className="block text-sm font-medium text-mail-text mb-2">
                          Badge shows
                        </label>
                        <select
                          value={badgeMode}
                          onChange={(e) => setBadgeMode(e.target.value)}
                          className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                    text-mail-text focus:border-mail-accent transition-all
                                    cursor-pointer"
                        >
                          <option value="unread">Unread messages</option>
                          <option value="total">Total messages</option>
                        </select>
                      </div>
                    )}

                    <div>
                      <label className="block text-sm font-medium text-mail-text mb-2">
                        Mark emails as read
                      </label>
                      <select
                        value={markAsReadMode}
                        onChange={(e) => setMarkAsReadMode(e.target.value)}
                        className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                  text-mail-text focus:border-mail-accent transition-all
                                  cursor-pointer"
                      >
                        <option value="auto">Automatically when opened</option>
                        <option value="manual">Manually only</option>
                      </select>
                      <p className="text-xs text-mail-text-muted mt-1">
                        {markAsReadMode === 'auto'
                          ? 'Emails are marked as read when you view them'
                          : 'Use the Mark as Read button to mark emails as read'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Sending */}
                <div data-testid="settings-undo-send" className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <SendHorizontal size={18} className="text-mail-accent" />
                    Sending
                  </h4>

                  <p className="text-sm text-mail-text-muted mb-4">
                    Configure send behavior and undo options.
                  </p>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between py-2">
                      <div>
                        <div className="font-medium text-mail-text">Enable Undo Send</div>
                        <div className="text-sm text-mail-text-muted">
                          Briefly delay sending so you can undo
                        </div>
                      </div>
                      <ToggleSwitch
                        active={undoSendEnabled}
                        onClick={() => setUndoSendEnabled(!undoSendEnabled)}
                      />
                    </div>

                    {undoSendEnabled && (
                      <div>
                        <label className="block text-sm font-medium text-mail-text mb-2">
                          Undo send delay
                        </label>
                        <select
                          value={undoSendDelay}
                          onChange={(e) => setUndoSendDelay(Number(e.target.value))}
                          className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                    text-mail-text focus:border-mail-accent transition-all
                                    cursor-pointer"
                        >
                          <option value={5}>5 seconds</option>
                          <option value={10}>10 seconds</option>
                          <option value={15}>15 seconds</option>
                          <option value={30}>30 seconds</option>
                        </select>
                      </div>
                    )}
                  </div>
                </div>

                {/* Search Settings */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <Search size={18} className="text-mail-accent" />
                    Search
                  </h4>

                  <p className="text-sm text-mail-text-muted mb-4">
                    Configure search behavior and history settings.
                  </p>

                  <div className="space-y-4">
                    {/* Search history limit */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-mail-text">
                          Search history limit
                        </label>
                        <span className="text-sm font-medium text-mail-accent">
                          {searchHistoryLimit} searches
                        </span>
                      </div>
                      <input
                        type="range"
                        min="20"
                        max="500"
                        step="10"
                        value={searchHistoryLimit}
                        onChange={(e) => setSearchHistoryLimit(parseInt(e.target.value))}
                        className="w-full"
                      />
                      <div className="flex justify-between mt-1 px-1">
                        <span className="text-[10px] text-mail-text-muted">20</span>
                        <span className="text-[10px] text-mail-text-muted">250</span>
                        <span className="text-[10px] text-mail-text-muted">500</span>
                      </div>
                    </div>

                    {/* Popular filters period */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-mail-text">
                          Popular filters period
                        </label>
                        <span className="text-sm font-medium text-mail-accent">
                          {filterHistoryPeriodDays >= 30 && filterHistoryPeriodDays < 60
                            ? '1 month'
                            : filterHistoryPeriodDays >= 60 && filterHistoryPeriodDays < 90
                            ? '2 months'
                            : filterHistoryPeriodDays >= 90 && filterHistoryPeriodDays < 180
                            ? '3 months'
                            : filterHistoryPeriodDays >= 180 && filterHistoryPeriodDays < 365
                            ? '6 months'
                            : '1 year'}
                        </span>
                      </div>
                      <input
                        type="range"
                        min="30"
                        max="365"
                        step="30"
                        value={filterHistoryPeriodDays}
                        onChange={(e) => setFilterHistoryPeriodDays(parseInt(e.target.value))}
                        className="w-full"
                      />
                      <div className="flex justify-between mt-1 px-1">
                        <span className="text-[10px] text-mail-text-muted">1 month</span>
                        <span className="text-[10px] text-mail-text-muted">6 months</span>
                        <span className="text-[10px] text-mail-text-muted">1 year</span>
                      </div>
                    </div>

                    {/* Top filters limit */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-mail-text">
                          Number of popular filters to show
                        </label>
                        <span className="text-sm font-medium text-mail-accent">
                          {topFiltersLimit} filters
                        </span>
                      </div>
                      <input
                        type="range"
                        min="5"
                        max="50"
                        step="5"
                        value={topFiltersLimit}
                        onChange={(e) => setTopFiltersLimit(parseInt(e.target.value))}
                        className="w-full"
                      />
                      <div className="flex justify-between mt-1 px-1">
                        <span className="text-[10px] text-mail-text-muted">5</span>
                        <span className="text-[10px] text-mail-text-muted">25</span>
                        <span className="text-[10px] text-mail-text-muted">50</span>
                      </div>
                    </div>

                    {/* Search history */}
                    <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
                      <div className="flex items-center gap-2">
                        <Clock size={14} className="text-mail-text-muted" />
                        <div>
                          <div className="text-sm text-mail-text">Search history</div>
                          <div className="text-xs text-mail-text-muted">
                            {searchHistory.length} saved searches
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={clearSearchHistory}
                        disabled={searchHistory.length === 0}
                        className="px-3 py-1.5 text-sm text-mail-text-muted hover:text-mail-text
                                  hover:bg-mail-border rounded-lg transition-colors disabled:opacity-50"
                      >
                        Clear
                      </button>
                    </div>

                    {/* Filter usage history */}
                    <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
                      <div className="flex items-center gap-2">
                        <Filter size={14} className="text-mail-text-muted" />
                        <div>
                          <div className="text-sm text-mail-text">Filter history</div>
                          <div className="text-xs text-mail-text-muted">
                            {filterUsageHistory.length} filter uses tracked
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={clearFilterHistory}
                        disabled={filterUsageHistory.length === 0}
                        className="px-3 py-1.5 text-sm text-mail-text-muted hover:text-mail-text
                                  hover:bg-mail-border rounded-lg transition-colors disabled:opacity-50"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                </div>

                {/* Email Templates */}
                <div data-testid="settings-templates" className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <FileText size={18} className="text-mail-accent" />
                    Email Templates
                  </h4>

                  <p className="text-sm text-mail-text-muted mb-4">
                    Create reusable templates for common emails.
                  </p>

                  <div className="space-y-3">
                    {emailTemplates.map((tpl) => (
                      <div key={tpl.id} className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
                        <div className="flex-1 min-w-0 mr-3">
                          <div className="text-sm font-medium text-mail-text truncate">{tpl.name}</div>
                          <div className="text-xs text-mail-text-muted truncate">
                            {tpl.body.length > 50 ? tpl.body.slice(0, 50) + '...' : tpl.body}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => {
                              setTemplateForm({ mode: 'edit', id: tpl.id });
                              setTemplateName(tpl.name);
                              setTemplateBody(tpl.body);
                            }}
                            className="p-1.5 text-mail-text-muted hover:text-mail-text hover:bg-mail-border rounded-lg transition-colors"
                            title="Edit template"
                          >
                            <PenTool size={14} />
                          </button>
                          <button
                            onClick={() => removeEmailTemplate(tpl.id)}
                            className="p-1.5 text-mail-text-muted hover:text-red-500 hover:bg-mail-border rounded-lg transition-colors"
                            title="Delete template"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}

                    {emailTemplates.length === 0 && !templateForm && (
                      <div className="text-sm text-mail-text-muted text-center py-3">
                        No templates yet. Create one to get started.
                      </div>
                    )}

                    <AnimatePresence>
                      {templateForm && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="p-4 bg-mail-bg rounded-lg border border-mail-border space-y-3">
                            <div>
                              <label className="block text-sm font-medium text-mail-text mb-1">
                                Template name
                              </label>
                              <input
                                type="text"
                                value={templateName}
                                onChange={(e) => setTemplateName(e.target.value)}
                                placeholder="e.g. Follow-up, Thank you, Meeting request"
                                className="w-full px-3 py-2 bg-mail-surface border border-mail-border rounded-lg
                                          text-sm text-mail-text placeholder-mail-text-muted
                                          focus:border-mail-accent focus:outline-none transition-colors"
                                autoFocus
                              />
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-mail-text mb-1">
                                Template body
                              </label>
                              <textarea
                                value={templateBody}
                                onChange={(e) => setTemplateBody(e.target.value)}
                                placeholder="Write the template content here..."
                                rows={5}
                                className="w-full px-3 py-2 bg-mail-surface border border-mail-border rounded-lg
                                          text-sm text-mail-text placeholder-mail-text-muted
                                          focus:border-mail-accent focus:outline-none transition-colors resize-y"
                              />
                            </div>
                            <div className="flex items-center gap-2 justify-end">
                              <button
                                onClick={() => {
                                  setTemplateForm(null);
                                  setTemplateName('');
                                  setTemplateBody('');
                                }}
                                className="px-3 py-1.5 text-sm text-mail-text-muted hover:text-mail-text
                                          hover:bg-mail-border rounded-lg transition-colors"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => {
                                  const name = templateName.trim();
                                  const body = templateBody.trim();
                                  if (!name || !body) return;
                                  if (templateForm.mode === 'add') {
                                    addEmailTemplate(name, body);
                                  } else {
                                    updateEmailTemplate(templateForm.id, { name, body });
                                  }
                                  setTemplateForm(null);
                                  setTemplateName('');
                                  setTemplateBody('');
                                }}
                                disabled={!templateName.trim() || !templateBody.trim()}
                                className="px-3 py-1.5 text-sm bg-mail-accent text-white rounded-lg
                                          hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed
                                          flex items-center gap-1.5"
                              >
                                <Save size={14} />
                                {templateForm.mode === 'add' ? 'Save' : 'Update'}
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {!templateForm && (
                      <button
                        onClick={() => {
                          setTemplateForm({ mode: 'add' });
                          setTemplateName('');
                          setTemplateBody('');
                        }}
                        className="flex items-center gap-2 px-3 py-2 text-sm text-mail-accent
                                  hover:bg-mail-bg rounded-lg transition-colors w-full justify-center
                                  border border-dashed border-mail-border hover:border-mail-accent"
                      >
                        <Plus size={14} />
                        Add Template
                      </button>
                    )}
                  </div>
                </div>

                {/* Keyboard Shortcuts */}
                <div data-testid="settings-shortcuts" className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <Keyboard size={18} className="text-mail-accent" />
                    Keyboard Shortcuts
                  </h4>

                  <p className="text-sm text-mail-text-muted mb-4">
                    Customize keyboard shortcuts. Click a binding to change it.
                  </p>

                  <div className="space-y-4">
                    {/* Master toggle */}
                    <div className="flex items-center justify-between py-2">
                      <div>
                        <div className="font-medium text-mail-text">Enable keyboard shortcuts</div>
                        <div className="text-sm text-mail-text-muted">
                          Use keyboard shortcuts to navigate and perform actions
                        </div>
                      </div>
                      <ToggleSwitch
                        active={keyboardShortcutsEnabled}
                        onClick={() => setKeyboardShortcutsEnabled(!keyboardShortcutsEnabled)}
                      />
                    </div>

                    {keyboardShortcutsEnabled && (
                      <div className="pt-2 space-y-5">
                        {SHORTCUT_CATEGORIES.map(category => (
                          <div key={category.title}>
                            <h5 className="text-xs font-semibold text-mail-text uppercase tracking-wider mb-2">
                              {category.title}
                            </h5>
                            <div className="bg-mail-bg rounded-lg overflow-hidden border border-mail-border">
                              {category.actions.map((action, idx) => {
                                const binding = keyboardShortcuts[action];
                                const defaultBinding = DEFAULT_SHORTCUTS[action];
                                const isModified = binding !== defaultBinding;
                                const isRebinding = rebindingAction === action;
                                const duplicate = isModified ? findDuplicateBinding(action, binding) : null;

                                return (
                                  <div
                                    key={action}
                                    className={`flex items-center justify-between px-3 py-2 ${
                                      idx > 0 ? 'border-t border-mail-border/50' : ''
                                    }`}
                                  >
                                    <span className="text-sm text-mail-text">
                                      {SHORTCUT_ACTION_LABELS[action] || action}
                                    </span>
                                    <div className="flex items-center gap-2">
                                      {duplicate && (
                                        <span className="text-xs text-amber-500" title={`Also bound to "${SHORTCUT_ACTION_LABELS[duplicate]}"`}>
                                          Duplicate
                                        </span>
                                      )}
                                      <button
                                        onClick={() => {
                                          if (isRebinding) {
                                            setRebindingAction(null);
                                            setRebindFirstKey(null);
                                            if (rebindTimer) { clearTimeout(rebindTimer); setRebindTimer(null); }
                                          } else {
                                            setRebindingAction(action);
                                            setRebindFirstKey(null);
                                          }
                                        }}
                                        className={`inline-flex items-center justify-center min-w-[72px] h-7 px-2
                                                   text-xs font-mono rounded-md border transition-all ${
                                          isRebinding
                                            ? 'border-mail-accent bg-mail-accent/10 text-mail-accent animate-pulse'
                                            : isModified
                                              ? 'border-mail-accent/50 bg-mail-accent/5 text-mail-text hover:border-mail-accent'
                                              : 'border-mail-border bg-mail-border/30 text-mail-text-muted hover:border-mail-accent/50'
                                        }`}
                                      >
                                        {isRebinding
                                          ? rebindFirstKey
                                            ? `${rebindFirstKey} + …`
                                            : 'Press key…'
                                          : formatKeybindingDisplay(binding)
                                        }
                                      </button>
                                      {isModified && !isRebinding && (
                                        <button
                                          onClick={() => setKeyboardShortcut(action, defaultBinding)}
                                          className="p-1 text-mail-text-muted hover:text-mail-text rounded transition-colors"
                                          title="Reset to default"
                                        >
                                          <RotateCcw size={13} />
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}

                        {/* Reset All */}
                        <div className="pt-2 border-t border-mail-border">
                          <button
                            onClick={resetKeyboardShortcuts}
                            className="px-4 py-2 text-sm text-mail-text-muted hover:text-mail-text
                                      hover:bg-mail-border rounded-lg transition-colors flex items-center gap-2"
                          >
                            <RotateCcw size={14} />
                            Reset All to Defaults
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Developer */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <RotateCcw size={18} className="text-mail-accent" />
                    Developer
                  </h4>

                  <p className="text-sm text-mail-text-muted mb-4">
                    Options for testing and development purposes.
                  </p>

                  <div className="flex items-center justify-between py-2">
                    <div>
                      <div className="font-medium text-mail-text">Reset Onboarding</div>
                      <div className="text-sm text-mail-text-muted">
                        Show the welcome screen again on next launch
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setOnboardingComplete(false);
                        window.location.reload();
                      }}
                      className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                                text-mail-text rounded-lg transition-colors flex items-center gap-2"
                    >
                      <RotateCcw size={16} />
                      Reset
                    </button>
                  </div>
                </div>

                {/* Help & Support */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <Mail size={18} className="text-mail-accent" />
                    Help & Support
                  </h4>

                  <div className="flex items-center justify-between py-2">
                    <div>
                      <div className="font-medium text-mail-text">Report a Bug</div>
                      <div className="text-sm text-mail-text-muted">
                        Send a bug report email to the developer
                      </div>
                    </div>
                    <button
                      onClick={() => { onReportBug?.(); onClose(); }}
                      className="px-4 py-2 bg-mail-accent hover:bg-mail-accent-hover
                                text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Report Bug
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Accounts Settings - Two column layout */}
            {activeTab === 'accounts' && (
              <div className="flex h-full">
                {/* Account List - Left Column */}
                <div className="w-72 border-r border-mail-border bg-mail-surface/50 overflow-y-auto">
                  <div className="p-4">
                    <div className="text-xs text-mail-text-muted uppercase tracking-wide mb-3">
                      Your Accounts
                    </div>
                    {accounts.length === 0 ? (
                      <div className="text-center py-8 text-mail-text-muted">
                        <Mail size={32} className="mx-auto mb-3 opacity-30" />
                        <p className="text-sm">No accounts configured</p>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {orderedAccounts.map((account, index) => (
                          <div
                            key={account.id}
                            onClick={() => setSelectedAccountId(account.id)}
                            className={`group/acct flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all
                                       ${account.id === selectedAccountId
                                         ? 'bg-mail-accent/10 border border-mail-accent/30'
                                         : 'hover:bg-mail-surface-hover border border-transparent'}`}
                          >
                            {orderedAccounts.length > 1 && (
                              <div className="flex flex-col opacity-0 group-hover/acct:opacity-100 transition-opacity">
                                <button
                                  onClick={(e) => { e.stopPropagation(); moveAccount(account.id, -1); }}
                                  disabled={index === 0}
                                  className={`p-0.5 rounded transition-colors ${index === 0 ? 'opacity-0' : 'hover:bg-mail-border'}`}
                                  title="Move up"
                                >
                                  <ChevronUp size={12} className="text-mail-text-muted" />
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); moveAccount(account.id, 1); }}
                                  disabled={index === orderedAccounts.length - 1}
                                  className={`p-0.5 rounded transition-colors ${index === orderedAccounts.length - 1 ? 'opacity-0' : 'hover:bg-mail-border'}`}
                                  title="Move down"
                                >
                                  <ChevronDown size={12} className="text-mail-text-muted" />
                                </button>
                              </div>
                            )}
                            <div
                              className={`w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold select-none${hiddenAccounts[account.id] ? ' opacity-40' : ''}`}
                              style={{ backgroundColor: getAccountColor(accountColors, account) }}
                            >
                              {getAccountInitial(account, getDisplayName(account.id))}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-mail-text truncate flex items-center gap-1.5">
                                {getDisplayName(account.id) || account.name || account.email?.split('@')[0] || 'Unknown'}
                                {account.authType === 'oauth2' && (
                                  <Shield size={12} className="text-blue-500 flex-shrink-0" />
                                )}
                                {hiddenAccounts[account.id] && (
                                  <EyeOff size={12} className="text-mail-text-muted flex-shrink-0" />
                                )}
                              </div>
                              <div className="text-xs text-mail-text-muted truncate">
                                {account.email}
                              </div>
                            </div>
                            {account.id === selectedAccountId && (
                              <ChevronRight size={16} className="text-mail-accent" />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {onAddAccount && (
                      <button
                        onClick={onAddAccount}
                        className="w-full mt-3 flex items-center justify-center gap-2 p-2.5 text-sm text-mail-text-muted
                                  hover:text-mail-text hover:bg-mail-surface-hover border border-dashed border-mail-border
                                  rounded-lg transition-all"
                      >
                        <Plus size={16} />
                        Add Account
                      </button>
                    )}
                  </div>
                </div>

                {/* Account Settings - Right Column */}
                <div className="flex-1 overflow-y-auto p-6">
                  {selectedAccount ? (
                    <div className="space-y-6">
                      {/* Account Info */}
                      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                          <User size={18} className="text-mail-accent" />
                          Account Settings
                        </h4>
                        
                        <div className="space-y-4">
                          <div>
                            <label className="block text-sm font-medium text-mail-text mb-2">
                              Email Address
                            </label>
                            <input
                              type="text"
                              value={selectedAccount.email}
                              disabled
                              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                        text-mail-text-muted cursor-not-allowed"
                            />
                          </div>
                          
                          <div>
                            <label className="block text-sm font-medium text-mail-text mb-2">
                              Display Name
                            </label>
                            <p className="text-sm text-mail-text-muted mb-2">
                              Name shown in the "From" field when sending emails
                            </p>
                            <input
                              type="text"
                              value={accountDisplayName}
                              onChange={(e) => setAccountDisplayName(e.target.value)}
                              placeholder="John Doe"
                              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                        text-mail-text placeholder-mail-text-muted
                                        focus:border-mail-accent transition-all"
                            />
                          </div>

                          {/* Avatar Color */}
                          <div>
                            <label className="block text-sm font-medium text-mail-text mb-2">
                              Avatar Color
                            </label>
                            <p className="text-sm text-mail-text-muted mb-2">
                              Color used for the account avatar in the sidebar
                            </p>
                            <div className="flex items-center gap-2 flex-wrap">
                              {AVATAR_COLORS.map(color => {
                                const currentColor = getAccountColor(accountColors, selectedAccount);
                                const isSelected = currentColor === color;
                                return (
                                  <button
                                    key={color}
                                    onClick={() => setAccountColor(selectedAccountId, color)}
                                    className={`w-7 h-7 rounded-full transition-all ${
                                      isSelected ? 'ring-2 ring-offset-2 ring-offset-mail-bg' : 'hover:scale-110'
                                    }`}
                                    style={{
                                      backgroundColor: color,
                                      '--tw-ring-color': color
                                    }}
                                    title={color}
                                  />
                                );
                              })}
                              {accountColors[selectedAccountId] && (
                                <button
                                  onClick={() => clearAccountColor(selectedAccountId)}
                                  className="text-xs text-mail-text-muted hover:text-mail-text transition-colors ml-1"
                                  title="Reset to default"
                                >
                                  Reset
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Hide Account */}
                      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {isAccountHidden(selectedAccountId) ? (
                              <EyeOff size={18} className="text-mail-text-muted" />
                            ) : (
                              <Eye size={18} className="text-mail-accent" />
                            )}
                            <div>
                              <div className="font-medium text-mail-text">
                                {isAccountHidden(selectedAccountId) ? 'Account Hidden' : 'Account Visible'}
                              </div>
                              <div className="text-sm text-mail-text-muted">
                                Hidden accounts are removed from the sidebar and stop syncing
                              </div>
                            </div>
                          </div>
                          <ToggleSwitch
                            active={!isAccountHidden(selectedAccountId)}
                            onClick={() => {
                              const currentlyHidden = isAccountHidden(selectedAccountId);
                              setAccountHidden(selectedAccountId, !currentlyHidden);

                              if (!currentlyHidden) {
                                // Hiding: destroy pipeline and switch active account if needed
                                import('../services/EmailPipelineManager').then(({ pipelineManager }) => {
                                  const pipeline = pipelineManager.pipelines.get(selectedAccountId);
                                  if (pipeline) {
                                    pipeline.destroy();
                                    pipelineManager.pipelines.delete(selectedAccountId);
                                  }
                                });

                                const { activeAccountId, setActiveAccount } = useMailStore.getState();
                                if (selectedAccountId === activeAccountId) {
                                  // Read fresh hidden state from store (not stale closure)
                                  const { hiddenAccounts: currentHidden } = useSettingsStore.getState();
                                  const nextVisible = accounts.find(
                                    a => a.id !== selectedAccountId && !currentHidden[a.id]
                                  );
                                  if (nextVisible) {
                                    setActiveAccount(nextVisible.id);
                                  } else {
                                    // No visible accounts left — clear active state
                                    useMailStore.setState({
                                      activeAccountId: null,
                                      mailboxes: [],
                                      emails: [],
                                      localEmails: [],
                                      savedEmailIds: new Set(),
                                      archivedEmailIds: new Set(),
                                      selectedEmailId: null,
                                      selectedEmail: null,
                                      selectedEmailSource: null
                                    });
                                  }
                                }
                              } else {
                                // Unhiding: trigger immediate sync
                                import('../services/EmailPipelineManager').then(({ pipelineManager }) => {
                                  const { activeAccountId } = useMailStore.getState();
                                  if (!activeAccountId) {
                                    useMailStore.getState().setActiveAccount(selectedAccountId);
                                  }
                                  pipelineManager.restartBackgroundPipelines();
                                });
                              }
                            }}
                          />
                        </div>
                      </div>

                      {/* Signature */}
                      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                          <FileText size={18} className="text-mail-accent" />
                          Email Signature
                        </h4>
                        
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-medium text-mail-text">Enable Signature</div>
                              <div className="text-sm text-mail-text-muted">
                                Automatically add to outgoing emails
                              </div>
                            </div>
                            <ToggleSwitch 
                              active={getSignature(selectedAccountId).enabled} 
                              onClick={() => {
                                const sig = getSignature(selectedAccountId);
                                setSignature(selectedAccountId, { ...sig, enabled: !sig.enabled });
                              }}
                            />
                          </div>
                          
                          <div>
                            <label className="block text-sm font-medium text-mail-text mb-2">
                              Signature Content
                            </label>
                            <textarea
                              value={signatureText}
                              onChange={(e) => setSignatureText(e.target.value)}
                              placeholder="Best regards,&#10;John Doe&#10;john@example.com"
                              rows={5}
                              className="w-full px-4 py-3 bg-mail-bg border border-mail-border rounded-lg
                                        text-mail-text placeholder-mail-text-muted resize-none
                                        font-mono text-sm focus:border-mail-accent transition-all"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Password / Authentication */}
                      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                          <Key size={18} className="text-mail-accent" />
                          Authentication
                        </h4>

                        {/* Auth type badge */}
                        <div className="flex items-center gap-2 mb-4">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium
                            ${selectedAccount.authType === 'oauth2'
                              ? 'bg-blue-500/10 text-blue-500 border border-blue-500/20'
                              : 'bg-mail-accent/10 text-mail-accent border border-mail-accent/20'}`}>
                            {selectedAccount.authType === 'oauth2' ? (
                              <><Shield size={12} /> {selectedAccount.oauth2Provider === 'google' ? 'Google' : 'Microsoft'} OAuth2</>
                            ) : (
                              <><Key size={12} /> Password</>
                            )}
                          </span>
                          {selectedAccount.authType === 'oauth2' && (
                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium
                              ${selectedAccount.oauth2ExpiresAt && selectedAccount.oauth2ExpiresAt > Date.now()
                                ? 'bg-mail-success/10 text-mail-success border border-mail-success/20'
                                : 'bg-mail-warning/10 text-mail-warning border border-mail-warning/20'}`}>
                              {selectedAccount.oauth2ExpiresAt && selectedAccount.oauth2ExpiresAt > Date.now() ? (
                                <><Link size={12} /> Connected</>
                              ) : (
                                <><Unlink size={12} /> Token expired</>
                              )}
                            </span>
                          )}
                        </div>

                        {/* OAuth2 account */}
                        {selectedAccount.authType === 'oauth2' ? (
                          <div className="space-y-4">
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="font-medium text-mail-text">{selectedAccount.oauth2Provider === 'google' ? 'Google' : 'Microsoft'} Account</div>
                                <div className="text-sm text-mail-text-muted">
                                  {selectedAccount.oauth2ExpiresAt && selectedAccount.oauth2ExpiresAt > Date.now()
                                    ? 'Authenticated via OAuth2. Tokens refresh automatically before expiry.'
                                    : 'Token expired. Tokens will refresh automatically on the next email operation, or click Reconnect.'}
                                </div>
                              </div>
                              <button
                                onClick={handleOAuth2Reconnect}
                                disabled={oauthReconnecting}
                                className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                                          text-mail-text rounded-lg transition-colors flex items-center gap-2
                                          disabled:opacity-50"
                              >
                                {oauthReconnecting ? (
                                  <Loader size={16} className="animate-spin" />
                                ) : (
                                  <RefreshCw size={16} />
                                )}
                                {oauthReconnecting ? 'Reconnecting...' : 'Reconnect'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {/* Password auth */}
                            {!selectedAccount.password && (
                              <div className="flex items-center gap-3 p-3 bg-mail-warning/10 border border-mail-warning/20 rounded-lg mb-4">
                                <div className="w-3 h-3 bg-mail-warning rounded-full" />
                                <span className="text-sm text-mail-text">
                                  Password not found. Please re-enter your password to reconnect.
                                </span>
                              </div>
                            )}

                            {editingPassword ? (
                              <div className="space-y-4">
                                <div>
                                  <label className="block text-sm font-medium text-mail-text mb-2">
                                    New Password
                                  </label>
                                  <input
                                    type="password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    placeholder="Enter your email password"
                                    className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                              text-mail-text placeholder-mail-text-muted
                                              focus:border-mail-accent transition-all"
                                  />
                                </div>
                                <div className="flex gap-2">
                                  <button
                                    onClick={handleUpdatePassword}
                                    disabled={!newPassword.trim()}
                                    className="px-4 py-2 bg-mail-accent hover:bg-mail-accent-hover
                                              text-white rounded-lg transition-colors disabled:opacity-50"
                                  >
                                    Save Password
                                  </button>
                                  <button
                                    onClick={() => {
                                      setEditingPassword(false);
                                      setNewPassword('');
                                    }}
                                    className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                                              text-mail-text rounded-lg transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-center justify-between">
                                <div>
                                  <div className="font-medium text-mail-text">Password</div>
                                  <div className="text-sm text-mail-text-muted">
                                    {selectedAccount.password ? 'Stored securely in system keychain' : 'Not configured'}
                                  </div>
                                </div>
                                <button
                                  onClick={() => setEditingPassword(true)}
                                  className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                                            text-mail-text rounded-lg transition-colors flex items-center gap-2"
                                >
                                  <Key size={16} />
                                  {selectedAccount.password ? 'Update' : 'Set Password'}
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      {/* Save Button */}
                      <div className="flex justify-end">
                        <button
                          onClick={handleSaveAccountSettings}
                          className="flex items-center gap-2 px-5 py-2.5 bg-mail-accent 
                                    hover:bg-mail-accent-hover text-white rounded-lg 
                                    font-medium transition-all"
                        >
                          {saved ? <Check size={18} /> : <Save size={18} />}
                          {saved ? 'Saved!' : 'Save Changes'}
                        </button>
                      </div>
                      
                      {/* Remove Account */}
                      <div className="bg-mail-surface border border-mail-danger/30 rounded-xl p-5 mt-6">
                        <h4 className="font-semibold text-mail-danger mb-4 flex items-center gap-2">
                          <Trash2 size={18} />
                          Remove Account
                        </h4>
                        
                        <p className="text-sm text-mail-text-muted mb-4">
                          This will remove the account from MailVault. All locally archived emails, 
                          attachments, and settings for this account will be permanently deleted 
                          and cannot be recovered.
                        </p>
                        <button
                          onClick={() => setShowRemoveConfirm(true)}
                          className="px-4 py-2 bg-mail-danger/10 hover:bg-mail-danger/20
                                    text-mail-danger rounded-lg transition-colors flex items-center gap-2"
                        >
                          <Trash2 size={16} />
                          Remove This Account
                        </button>

                        <AnimatePresence>
                          {showRemoveConfirm && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              className="overflow-hidden mt-4"
                            >
                              <div className="bg-mail-danger/5 border border-mail-danger/30 rounded-lg p-4">
                                <p className="text-sm text-mail-text mb-1 font-medium">
                                  Are you sure you want to remove {selectedAccount.email}?
                                </p>
                                <p className="text-sm text-mail-text-muted mb-4">
                                  This will permanently delete all locally archived emails, attachments, and settings for this account. This action cannot be undone.
                                </p>
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => {
                                      removeAccount(selectedAccountId);
                                      setShowRemoveConfirm(false);
                                      if (accounts.length > 1) {
                                        const nextAccount = accounts.find(a => a.id !== selectedAccountId);
                                        setSelectedAccountId(nextAccount?.id || null);
                                      }
                                    }}
                                    className="px-4 py-2 bg-mail-danger hover:bg-mail-danger/80
                                              text-white rounded-lg transition-colors text-sm font-medium"
                                  >
                                    Remove
                                  </button>
                                  <button
                                    onClick={() => setShowRemoveConfirm(false)}
                                    className="px-4 py-2 bg-mail-border hover:bg-mail-border/80
                                              text-mail-text rounded-lg transition-colors text-sm"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-full text-mail-text-muted">
                      <div className="text-center">
                        <User size={48} className="mx-auto mb-4 opacity-30" />
                        <p>Select an account to configure</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            
            {/* Storage Settings */}
            {activeTab === 'storage' && (
              <div className="p-6 space-y-6">
                {/* Current Storage Status */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <Database size={18} className="text-mail-accent" />
                    Storage Status
                  </h4>
                  
                  <div className="flex items-center gap-3 p-3 bg-mail-success/10 border border-mail-success/20 rounded-lg mb-4">
                    <div className="w-3 h-3 bg-mail-success rounded-full animate-pulse" />
                    <span className="text-sm text-mail-text">
                      Your emails are stored securely in local storage
                    </span>
                  </div>
                  
                  <p className="text-sm text-mail-text-muted">
                    All archived emails, attachments, and settings are stored locally on your device.
                    This data persists across sessions and is private to your device.
                  </p>
                </div>
                
                {/* Local Email Caching */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <HardDrive size={18} className="text-mail-accent" />
                    Local Email Caching
                  </h4>

                  <div className="space-y-4">
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <label className="text-sm font-medium text-mail-text">
                          Cache Duration
                        </label>
                        <span className="text-sm font-medium text-mail-accent">
                          {localCacheDurationMonths === 0 ? 'All emails' :
                           localCacheDurationMonths === 1 ? '1 month' :
                           localCacheDurationMonths === 12 ? '1 year' :
                           `${localCacheDurationMonths} months`}
                        </span>
                      </div>

                      {/* Slider - 5 steps: 1, 3, 6, 12 months, All */}
                      <div className="relative">
                        <input
                          type="range"
                          min="0"
                          max="4"
                          value={
                            localCacheDurationMonths === 1 ? 0 :
                            localCacheDurationMonths === 3 ? 1 :
                            localCacheDurationMonths === 6 ? 2 :
                            localCacheDurationMonths === 12 ? 3 : 4
                          }
                          onChange={(e) => {
                            const steps = [1, 3, 6, 12, 0]; // 0 = All
                            setLocalCacheDurationMonths(steps[parseInt(e.target.value)]);
                          }}
                          className="w-full"
                        />

                        {/* Tick marks */}
                        <div className="flex justify-between mt-1 px-1">
                          <span className="text-[10px] text-mail-text-muted">1 mo</span>
                          <span className="text-[10px] text-mail-text-muted">3 mo</span>
                          <span className="text-[10px] text-mail-text-muted">6 mo</span>
                          <span className="text-[10px] text-mail-text-muted">1 year</span>
                          <span className="text-[10px] text-mail-text-muted">All</span>
                        </div>
                      </div>
                    </div>

                    {/* Local storage usage */}
                    <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
                      <div>
                        <div className="text-sm text-mail-text">Local storage usage</div>
                        <div className="text-xs text-mail-text-muted">
                          {localStorageUsage ? (
                            <>
                              {localStorageUsage.totalMB >= 1024
                                ? `${(localStorageUsage.totalMB / 1024).toFixed(2)} GB`
                                : localStorageUsage.totalMB >= 1
                                ? `${localStorageUsage.totalMB.toFixed(2)} MB`
                                : `${(localStorageUsage.totalMB * 1024).toFixed(0)} KB`}
                              {' '}({localStorageUsage.emailCount.toLocaleString()} emails saved)
                            </>
                          ) : (
                            'Calculating...'
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Clear cache */}
                    <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
                      <div>
                        <div className="text-sm text-mail-text">Clear cached emails</div>
                        <div className="text-xs text-mail-text-muted">
                          Removes all cached .eml files and re-syncs. Archived emails are preserved.
                        </div>
                      </div>
                      {!clearCacheConfirm ? (
                        <button
                          onClick={() => { setClearCacheConfirm(true); setClearCacheResult(null); }}
                          disabled={clearingCache}
                          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                        >
                          <Trash2 size={14} />
                          Clear Cache
                        </button>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setClearCacheConfirm(false)}
                            disabled={clearingCache}
                            className="px-3 py-1.5 text-sm font-medium rounded-lg border border-mail-border text-mail-text-muted hover:bg-mail-surface transition-colors disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={async () => {
                              if (clearingCache) return;
                              setClearingCache(true);
                              setClearCacheResult(null);
                              try {
                                const invoke = window.__TAURI__?.core?.invoke;
                                if (!invoke) return;

                                // Stop all pipelines
                                const { pipelineManager } = await import('../services/EmailPipelineManager');
                                pipelineManager.destroyAll();

                                // Clear .eml files (preserving archived)
                                const result = await invoke('maildir_clear_cache');

                                // Clear headers cache files
                                await invoke('clear_email_cache', { accountId: null });

                                // Clear in-memory cache and reset emails array so coordinator hook re-triggers
                                useMailStore.getState().clearEmailCache();
                                useMailStore.setState({ emails: [], sortedEmails: [], localEmails: [], emailsByIndex: {}, totalEmails: 0, loadedRanges: [], currentPage: 0, hasMoreEmails: true, sentEmails: [] });

                                setClearCacheResult(result);

                                // Refresh storage usage
                                const { getStorageUsage } = await import('../services/db');
                                const usage = await getStorageUsage();
                                setLocalStorageUsage(usage);

                                // Re-load emails from server — this repopulates the store and lets the pipeline coordinator restart
                                const activeAccountId = useMailStore.getState().activeAccountId;
                                if (activeAccountId) {
                                  useMailStore.getState().loadEmails();
                                }
                              } catch (error) {
                                console.error('Failed to clear cache:', error);
                              } finally {
                                setClearingCache(false);
                                setClearCacheConfirm(false);
                              }
                            }}
                            disabled={clearingCache}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                          >
                            {clearingCache ? (
                              <Loader size={14} className="animate-spin" />
                            ) : (
                              <Trash2 size={14} />
                            )}
                            {clearingCache ? 'Clearing...' : 'Confirm'}
                          </button>
                        </div>
                      )}
                    </div>
                    {clearCacheResult && (
                      <div className="text-xs text-green-600 dark:text-green-400 px-1">
                        Cleared {clearCacheResult.deletedCount.toLocaleString()} cached emails
                        {clearCacheResult.skippedArchived > 0 && `, ${clearCacheResult.skippedArchived.toLocaleString()} archived emails preserved`}.
                        Re-sync started.
                      </div>
                    )}
                  </div>
                </div>

                {/* Auto-Cleanup Rules */}
                <div data-testid="settings-auto-cleanup" className="bg-mail-surface border border-mail-border rounded-xl p-5 relative overflow-hidden">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <Clock size={18} className="text-mail-accent" />
                    Auto-Cleanup
                    {!isPaidUser && (
                      <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-full">
                        <Sparkles size={10} />
                        Pro
                      </span>
                    )}
                  </h4>

                  {!isPaidUser ? (
                    /* Locked state for non-paid users */
                    <div className="relative">
                      {/* Blurred preview of what the UI looks like */}
                      <div className="opacity-30 blur-[1px] pointer-events-none select-none" aria-hidden="true">
                        <div className="space-y-2 mb-3">
                          <div className="flex items-center justify-between p-2.5 bg-mail-bg rounded-lg">
                            <div className="flex items-center gap-3 text-sm text-mail-text">
                              <span>INBOX</span>
                              <span className="text-mail-text-muted">All accounts</span>
                              <span className="text-mail-text-muted">Older than 90 days</span>
                              <span className="text-mail-text-muted">Archive locally then delete</span>
                            </div>
                          </div>
                          <div className="flex items-center justify-between p-2.5 bg-mail-bg rounded-lg">
                            <div className="flex items-center gap-3 text-sm text-mail-text">
                              <span>Trash</span>
                              <span className="text-mail-text-muted">All accounts</span>
                              <span className="text-mail-text-muted">Older than 30 days</span>
                              <span className="text-mail-text-muted">Delete from server</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <div className="px-3 py-1.5 text-sm bg-mail-accent/10 text-mail-accent rounded-lg">Add Rule</div>
                          <div className="px-3 py-1.5 text-sm bg-mail-surface-hover text-mail-text rounded-lg">Run All Now</div>
                        </div>
                      </div>

                      {/* Lock overlay */}
                      <div className="absolute inset-0 flex flex-col items-center justify-center bg-mail-surface/60 backdrop-blur-[1px] rounded-lg">
                        <div className="flex flex-col items-center gap-3 text-center px-6">
                          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/30 flex items-center justify-center">
                            <Lock size={20} className="text-amber-500" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-mail-text mb-1">Available in MailVault Pro</p>
                            <p className="text-xs text-mail-text-muted max-w-[280px]">
                              Automatically clean up old emails with custom rules. Set per-folder age thresholds, choose to archive or delete, and keep your mailbox tidy.
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* Full rule management UI for paid users */
                    <div className="space-y-4">
                      <p className="text-sm text-mail-text-muted">
                        Automatically clean up old emails with custom rules. Rules run in the background periodically.
                      </p>

                      {/* Existing rules list */}
                      {cleanupRules.length > 0 && (
                        <div className="space-y-2">
                          {cleanupRules.map((rule) => (
                            <div key={rule.id} className="flex items-center justify-between p-3 bg-mail-bg rounded-lg group">
                              <div className="flex items-center gap-3 text-sm min-w-0 flex-1">
                                <span className="font-medium text-mail-text">{rule.folder}</span>
                                <span className="text-mail-text-muted truncate">
                                  {rule.account === 'all' ? 'All accounts' : rule.account}
                                </span>
                                <span className="text-mail-text-muted whitespace-nowrap">
                                  {'>'} {rule.age} {rule.unit}
                                </span>
                                <span className={`text-xs px-1.5 py-0.5 rounded whitespace-nowrap ${
                                  rule.action === 'delete'
                                    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                    : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                }`}>
                                  {rule.action === 'delete' ? 'Delete from server' : 'Archive then delete'}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 ml-3 shrink-0">
                                <ToggleSwitch
                                  active={rule.enabled}
                                  onClick={() => toggleCleanupRule(rule.id)}
                                />
                                <button
                                  onClick={() => {
                                    setCleanupForm({ mode: 'edit', id: rule.id });
                                    setCleanupAccount(rule.account);
                                    setCleanupFolder(rule.folder);
                                    setCleanupAge(rule.age);
                                    setCleanupUnit(rule.unit);
                                    setCleanupAction(rule.action);
                                  }}
                                  className="p-1.5 text-mail-text-muted hover:text-mail-accent rounded-md hover:bg-mail-surface transition-colors opacity-0 group-hover:opacity-100"
                                  title="Edit rule"
                                >
                                  <Pencil size={14} />
                                </button>
                                {cleanupDeleteConfirm === rule.id ? (
                                  <div className="flex items-center gap-1">
                                    <button
                                      onClick={() => setCleanupDeleteConfirm(null)}
                                      className="px-2 py-1 text-xs text-mail-text-muted hover:bg-mail-surface rounded transition-colors"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      onClick={() => {
                                        removeCleanupRule(rule.id);
                                        setCleanupDeleteConfirm(null);
                                      }}
                                      className="px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                                    >
                                      Delete
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => setCleanupDeleteConfirm(rule.id)}
                                    className="p-1.5 text-mail-text-muted hover:text-red-500 rounded-md hover:bg-mail-surface transition-colors opacity-0 group-hover:opacity-100"
                                    title="Delete rule"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {cleanupRules.length === 0 && !cleanupForm && (
                        <div className="text-center py-6 text-mail-text-muted text-sm">
                          No cleanup rules yet. Add a rule to get started.
                        </div>
                      )}

                      {/* Inline add/edit form */}
                      {cleanupForm && (
                        <div className="bg-mail-bg border border-mail-border rounded-lg p-4 space-y-3">
                          <h5 className="text-sm font-medium text-mail-text">
                            {cleanupForm.mode === 'add' ? 'Add Cleanup Rule' : 'Edit Cleanup Rule'}
                          </h5>

                          {/* First-time warning */}
                          {showCleanupFirstTimeWarning && (
                            <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                              <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                              <p className="text-xs text-amber-800 dark:text-amber-300">
                                Auto-cleanup rules run automatically. Deleted emails cannot be recovered from server.
                              </p>
                            </div>
                          )}

                          <div className="grid grid-cols-2 gap-3">
                            {/* Account dropdown */}
                            <div>
                              <label className="text-xs text-mail-text-muted mb-1 block">Account</label>
                              <select
                                value={cleanupAccount}
                                onChange={(e) => setCleanupAccount(e.target.value)}
                                className="w-full px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                              >
                                <option value="all">All accounts</option>
                                {accounts
                                  .filter(a => !hiddenAccounts.includes(a.id))
                                  .map(a => (
                                    <option key={a.id} value={a.email}>{a.email}</option>
                                  ))
                                }
                              </select>
                            </div>

                            {/* Folder dropdown */}
                            <div>
                              <label className="text-xs text-mail-text-muted mb-1 block">Folder</label>
                              <select
                                value={cleanupFolder}
                                onChange={(e) => setCleanupFolder(e.target.value)}
                                className="w-full px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                              >
                                {['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'].map(f => (
                                  <option key={f} value={f}>{f}</option>
                                ))}
                              </select>
                            </div>

                            {/* Age threshold */}
                            <div>
                              <label className="text-xs text-mail-text-muted mb-1 block">Older than</label>
                              <div className="flex gap-2">
                                <input
                                  type="number"
                                  min={cleanupUnit === 'days' ? 7 : 1}
                                  value={cleanupAge}
                                  onChange={(e) => {
                                    const val = parseInt(e.target.value) || 0;
                                    setCleanupAge(val);
                                  }}
                                  className="w-20 px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                                />
                                <select
                                  value={cleanupUnit}
                                  onChange={(e) => {
                                    setCleanupUnit(e.target.value);
                                    if (e.target.value === 'days' && cleanupAge < 7) setCleanupAge(7);
                                  }}
                                  className="flex-1 px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                                >
                                  <option value="days">days</option>
                                  <option value="months">months</option>
                                </select>
                              </div>
                              {cleanupUnit === 'days' && cleanupAge < 7 && cleanupAge > 0 && (
                                <p className="text-[10px] text-red-500 mt-1">Minimum 7 days</p>
                              )}
                            </div>

                            {/* Action dropdown */}
                            <div>
                              <label className="text-xs text-mail-text-muted mb-1 block">Action</label>
                              <select
                                value={cleanupAction}
                                onChange={(e) => setCleanupAction(e.target.value)}
                                className="w-full px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                              >
                                <option value="delete">Delete from server</option>
                                <option value="archive-then-delete">Archive locally then delete</option>
                              </select>
                            </div>
                          </div>

                          <div className="flex justify-end gap-2 pt-1">
                            <button
                              onClick={() => {
                                setCleanupForm(null);
                                setShowCleanupFirstTimeWarning(false);
                              }}
                              className="px-3 py-1.5 text-sm text-mail-text-muted hover:bg-mail-surface rounded-lg transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => {
                                const effectiveAge = cleanupUnit === 'days' ? Math.max(7, cleanupAge) : Math.max(1, cleanupAge);
                                const ruleData = {
                                  account: cleanupAccount,
                                  folder: cleanupFolder,
                                  age: effectiveAge,
                                  unit: cleanupUnit,
                                  action: cleanupAction,
                                  enabled: true,
                                };
                                if (cleanupForm.mode === 'edit') {
                                  updateCleanupRule(cleanupForm.id, ruleData);
                                } else {
                                  addCleanupRule(ruleData);
                                }
                                setCleanupForm(null);
                                setShowCleanupFirstTimeWarning(false);
                              }}
                              disabled={cleanupUnit === 'days' && cleanupAge < 7}
                              className="px-3 py-1.5 text-sm font-medium bg-mail-accent text-white rounded-lg hover:bg-mail-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {cleanupForm.mode === 'edit' ? 'Save' : 'Add Rule'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Action buttons */}
                      {!cleanupForm && (<>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              setCleanupForm({ mode: 'add' });
                              setCleanupAccount('all');
                              setCleanupFolder('INBOX');
                              setCleanupAge(30);
                              setCleanupUnit('days');
                              setCleanupAction('delete');
                              if (cleanupRules.length === 0) {
                                setShowCleanupFirstTimeWarning(true);
                              }
                            }}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-mail-accent/10 text-mail-accent rounded-lg hover:bg-mail-accent/20 transition-colors"
                          >
                            <Plus size={14} />
                            Add Rule
                          </button>
                          {cleanupRules.length > 0 && (
                            <button
                              onClick={async () => {
                                setCleanupRunning(true);
                                setCleanupResult(null);
                                try {
                                  const result = await runCleanupRules();
                                  if (result.archived > 0 || result.deleted > 0) {
                                    setCleanupResult(`Cleaned up ${result.deleted} email${result.deleted !== 1 ? 's' : ''}${result.archived > 0 ? ` (${result.archived} archived)` : ''}`);
                                  } else {
                                    setCleanupResult('No emails matched cleanup criteria');
                                  }
                                } catch (e) {
                                  setCleanupResult(`Cleanup failed: ${e.message}`);
                                } finally {
                                  setCleanupRunning(false);
                                  setTimeout(() => setCleanupResult(null), 5000);
                                }
                              }}
                              disabled={cleanupRunning}
                              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-mail-surface-hover text-mail-text rounded-lg hover:bg-mail-border transition-colors disabled:opacity-50"
                            >
                              {cleanupRunning ? <Loader size={14} className="animate-spin" /> : <Play size={14} />}
                              {cleanupRunning ? 'Running...' : 'Run All Now'}
                            </button>
                          )}
                        </div>
                        {cleanupResult && (
                          <p className={`text-xs mt-2 ${cleanupResult.startsWith('Cleanup failed') ? 'text-mail-danger' : 'text-mail-text-muted'}`}>
                            {cleanupResult}
                          </p>
                        )}
                      </>)}
                    </div>
                  )}
                </div>

                {/* Backup & Restore */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <HardDrive size={18} className="text-mail-accent" />
                    Backup & Restore
                  </h4>
                  
                  <p className="text-sm text-mail-text-muted mb-4">
                    Export your data to create a backup file, or import a previous backup to restore your emails.
                  </p>
                  
                  <div className="flex gap-3">
                    <button
                      onClick={handleExportData}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-3
                                bg-mail-accent/10 hover:bg-mail-accent/20 text-mail-accent
                                rounded-lg transition-colors"
                    >
                      <Download size={18} />
                      Export Backup
                    </button>

                    <button
                      onClick={handleImportData}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-3
                                bg-mail-surface-hover hover:bg-mail-border text-mail-text
                                rounded-lg transition-colors"
                    >
                      <Upload size={18} />
                      Import Backup
                    </button>
                  </div>
                </div>
                
                {/* Advanced: Folder Selection (only for supported browsers) */}
                {supportsFileSystem && (
                  <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                    <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                      <FolderOpen size={18} className="text-mail-accent" />
                      Advanced: Custom Storage Folder
                    </h4>
                    
                    <p className="text-sm text-mail-text-muted mb-3">
                      Optionally select a folder on your device to sync your emails.
                    </p>
                    <div className="flex gap-2">
                      <div className="flex-1 px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                    text-mail-text min-h-[42px] flex items-center">
                        {localStoragePath || (
                          <span className="text-mail-text-muted">Browser storage (default)</span>
                        )}
                      </div>
                      <button
                        onClick={handleSelectFolder}
                        disabled={movingStorage}
                        className="px-4 py-2.5 bg-mail-surface-hover hover:bg-mail-border
                                  text-mail-text rounded-lg transition-colors flex items-center gap-2
                                  disabled:opacity-50"
                      >
                        <FolderOpen size={16} />
                        {movingStorage ? 'Moving...' : 'Browse'}
                      </button>
                    </div>
                  </div>
                )}
                
                {/* Security */}
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
                  <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                    <Shield size={18} className="text-mail-accent" />
                    Security
                  </h4>
                  
                  <div className="text-mail-text-muted text-sm">
                    <p className="mb-3">
                      Password protection for your local storage is coming soon.
                    </p>
                    <div className="flex items-center gap-2 text-mail-accent">
                      <Shield size={16} />
                      <span>This feature is under development</span>
                    </div>
                  </div>
                </div>
                
                {/* Danger Zone */}
                <div className="bg-mail-surface border border-mail-danger/30 rounded-xl p-5">
                  <h4 className="font-semibold text-mail-danger mb-4 flex items-center gap-2">
                    <Trash2 size={18} />
                    Danger Zone
                  </h4>
                  
                  <p className="text-sm text-mail-text-muted mb-4">
                    Clear all locally archived emails and settings. This action cannot be undone.
                  </p>
                  <button
                    onClick={async () => {
                      if (confirm('Are you sure? This will delete all locally archived emails and settings. This action cannot be undone.')) {
                        try {
                          const db = await import('../services/db');
                          // Delete each account's Maildir and data
                          const accts = await db.getAccountsWithoutPasswords();
                          for (const acct of accts) {
                            await db.deleteAccount(acct.id);
                          }
                        } catch (e) {
                          console.error('Failed to clear Maildir data:', e);
                        }
                        try { localStorage.clear(); } catch { /* sandbox may block */ }
                        window.location.reload();
                      }
                    }}
                    className="px-4 py-2 bg-mail-danger/10 hover:bg-mail-danger/20
                              text-mail-danger rounded-lg transition-colors flex items-center gap-2"
                  >
                    <Trash2 size={16} />
                    Clear All Data
                  </button>
                </div>
              </div>
            )}

            {/* Logs */}
            {activeTab === 'logs' && (
              <div className="p-6 space-y-6 h-full flex flex-col">
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5 flex-1 flex flex-col min-h-0">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="font-semibold text-mail-text flex items-center gap-2">
                      <ScrollText size={18} className="text-mail-accent" />
                      Application Logs
                    </h4>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={loadLogs}
                        disabled={loadingLogs}
                        className="px-3 py-1.5 text-sm text-mail-text-muted hover:text-mail-text
                                  hover:bg-mail-border rounded-lg transition-colors flex items-center gap-2"
                      >
                        <RefreshCw size={14} className={loadingLogs ? 'animate-spin' : ''} />
                        Refresh
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(logs);
                            setLogsCopied(true);
                            setTimeout(() => setLogsCopied(false), 2000);
                          } catch (err) {
                            console.error('Failed to copy logs:', err);
                          }
                        }}
                        disabled={!logs || loadingLogs}
                        className="px-3 py-1.5 text-sm text-mail-text-muted hover:text-mail-text
                                  hover:bg-mail-border rounded-lg transition-colors flex items-center gap-2
                                  disabled:opacity-50"
                      >
                        {logsCopied ? <Check size={14} /> : <Copy size={14} />}
                        {logsCopied ? 'Copied!' : 'Copy'}
                      </button>
                      <button
                        onClick={async () => {
                          console.log('Export button clicked, logs length:', logs?.length);
                          if (!logs || logs.length === 0) {
                            alert('No logs to export. Try refreshing first.');
                            return;
                          }
                          try {
                            // Use Tauri save dialog if available
                            if (invoke) {
                              const { save } = await import('@tauri-apps/plugin-dialog');
                              const { writeTextFile } = await import('@tauri-apps/plugin-fs');
                              const filePath = await save({
                                defaultPath: `mailvault-logs-${new Date().toISOString().split('T')[0]}.txt`,
                                filters: [{ name: 'Text Files', extensions: ['txt'] }]
                              });
                              if (filePath) {
                                await writeTextFile(filePath, logs);
                                alert('Logs exported successfully!');
                              }
                            } else {
                              // Fallback to browser download
                              const blob = new Blob([logs], { type: 'text/plain;charset=utf-8' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.style.display = 'none';
                              a.href = url;
                              a.download = `mailvault-logs-${new Date().toISOString().split('T')[0]}.txt`;
                              document.body.appendChild(a);
                              a.click();
                              // Cleanup after a short delay
                              setTimeout(() => {
                                document.body.removeChild(a);
                                URL.revokeObjectURL(url);
                              }, 100);
                            }
                            console.log('Logs exported successfully');
                          } catch (error) {
                            console.error('Failed to export logs:', error);
                            alert('Failed to export logs: ' + (error.message || error));
                          }
                        }}
                        disabled={!logs || loadingLogs}
                        className="px-3 py-1.5 text-sm text-mail-text-muted hover:text-mail-text
                                  hover:bg-mail-border rounded-lg transition-colors flex items-center gap-2
                                  disabled:opacity-50"
                      >
                        <Download size={14} />
                        Export
                      </button>
                      <button
                        onClick={async () => {
                          console.log('Clear button clicked, invoke available:', !!invoke);
                          if (!invoke) {
                            alert('Clear logs is only available in the desktop app');
                            return;
                          }
                          try {
                            const { ask } = await import('@tauri-apps/plugin-dialog');
                            const confirmed = await ask('Are you sure you want to clear all logs?', {
                              title: 'Clear Logs',
                              kind: 'warning',
                            });
                            if (!confirmed) return;
                          } catch {
                            if (!confirm('Are you sure you want to clear all logs?')) return;
                          }
                          try {
                            setLoadingLogs(true);
                            console.log('Calling clear_logs...');
                            const result = await invoke('clear_logs');
                            console.log('clear_logs result:', result);
                            // Reload logs after clearing
                            await loadLogs();
                            alert(result || 'Logs cleared successfully');
                          } catch (error) {
                            console.error('Failed to clear logs:', error);
                            const errorMsg = typeof error === 'string' ? error : (error.message || JSON.stringify(error));
                            alert('Failed to clear logs: ' + errorMsg);
                            // Still try to reload logs
                            await loadLogs();
                          } finally {
                            setLoadingLogs(false);
                          }
                        }}
                        disabled={loadingLogs}
                        className="px-3 py-1.5 text-sm text-mail-danger hover:text-mail-danger
                                  hover:bg-mail-danger/10 rounded-lg transition-colors flex items-center gap-2"
                      >
                        <Trash2 size={14} />
                        Clear
                      </button>
                    </div>
                  </div>

                  <p className="text-sm text-mail-text-muted mb-4">
                    View recent application logs. Last 500 lines are shown.
                  </p>

                  <div className="flex-1 min-h-0 overflow-hidden">
                    {loadingLogs ? (
                      <div className="flex items-center justify-center h-full">
                        <Loader size={24} className="animate-spin text-mail-accent" />
                      </div>
                    ) : !invoke ? (
                      <div className="flex items-center justify-center h-full text-mail-text-muted">
                        <p>Logs are only available in the desktop app</p>
                      </div>
                    ) : (
                      <pre className="h-full overflow-auto bg-mail-bg p-4 rounded-lg text-xs
                                     font-mono text-mail-text-muted whitespace-pre-wrap break-words">
                        {logs || 'No logs available'}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </motion.div>

      {/* Export choice modal */}
      <AnimatePresence>
        {showExportChoice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
            onClick={() => setShowExportChoice(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-mail-bg border border-mail-border rounded-xl shadow-xl max-w-sm w-full mx-4 p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-mail-text mb-2">Export Backup</h3>
              <p className="text-sm text-mail-text-muted mb-5">
                Which emails would you like to export?
              </p>
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => doExport(true)}
                  className="w-full px-4 py-3 bg-mail-accent hover:bg-mail-accent-hover
                            text-white rounded-lg font-medium transition-colors text-left"
                >
                  <span className="block">Archived Emails</span>
                  <span className="block text-xs font-normal opacity-80 mt-0.5">Only emails you've explicitly saved to your device</span>
                </button>
                <button
                  onClick={() => setShowExportChoice(false)}
                  className="w-full px-4 py-2 text-sm text-mail-text-muted hover:text-mail-text
                            transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
