import React, { useState, useMemo, useEffect, memo } from 'react';
import { version } from '../../package.json';
import { useMailStore } from '../stores/mailStore';
import { useAccountStore } from '../stores/accountStore';
import { useMessageListStore } from '../stores/messageListStore';
import { useSyncStore } from '../stores/syncStore';
import { useUiStore } from '../stores/uiStore';
import { useThemeStore } from '../stores/themeStore';
import { useSettingsStore, getAccountInitial, getAccountColor, hasPremiumAccess } from '../stores/settingsStore';
import { useBackupStore } from '../stores/backupStore';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Inbox,
  Send,
  File,
  Trash2,
  Star,
  Archive,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Plus,
  ChevronDown,
  ChevronRight,
  Settings,
  HardDrive,
  Cloud,
  Layers,
  PenSquare,
  Sun,
  Moon,
  WifiOff,
  Key,
  ServerOff,
  RefreshCw,
  Info,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Loader,
} from 'lucide-react';

const MAILBOX_ICONS = {
  INBOX: Inbox,
  '\\Sent': Send,
  '\\Drafts': File,
  '\\Trash': Trash2,
  '\\Junk': Trash2,
  '\\Starred': Star,
  '\\Important': AlertCircle,
  '\\Archive': Archive,
  '\\All': Archive
};

function getMailboxIcon(mailbox) {
  const Icon = MAILBOX_ICONS[mailbox.specialUse] || MAILBOX_ICONS[mailbox.path] || Inbox;
  return Icon;
}

function getMailboxDisplayName(name) {
  if (!name) return name;
  const match = name.match(/^inbox\./i);
  if (match) return name.slice(match[0].length);
  return name;
}

const UNIFIED_FOLDERS = [
  { id: 'INBOX', name: 'Inbox', icon: Inbox },
  { id: 'Sent', name: 'Sent', icon: Send, specialUse: '\\Sent' },
  { id: 'Drafts', name: 'Drafts', icon: File, specialUse: '\\Drafts' },
  { id: 'Trash', name: 'Trash', icon: Trash2, specialUse: '\\Trash' },
  { id: 'Archive', name: 'Archive', icon: Archive, specialUse: '\\Archive' },
];

function UnifiedFolderList() {
  const unifiedFolder = useAccountStore(s => s.unifiedFolder);
  const switchUnifiedFolder = useAccountStore(s => s.switchUnifiedFolder);

  return (
    <div className="overflow-y-auto p-3 flex-1" style={{ minHeight: 60 }}>
      <div className="text-xs text-mail-text-muted uppercase tracking-wide mb-2">
        All Accounts
      </div>
      {UNIFIED_FOLDERS.map(folder => {
        const isActive = unifiedFolder === folder.id;
        const Icon = folder.icon;
        return (
          <div
            key={folder.id}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors
                       ${isActive ? 'bg-mail-accent/10 text-mail-accent' : 'text-mail-text hover:bg-mail-surface-hover'}`}
            onClick={() => switchUnifiedFolder(folder.id)}
          >
            <Icon size={16} />
            <span className="text-sm truncate">{folder.name}</span>
          </div>
        );
      })}
    </div>
  );
}

function BackupStatusIcon({ accountId, onClick }) {
  const backupState = useSettingsStore(s => s.backupState?.[accountId]);
  const backupGlobalEnabled = useSettingsStore(s => s.backupGlobalEnabled);
  const backupGlobalConfig = useSettingsStore(s => s.backupGlobalConfig);
  const schedule = useSettingsStore(s => s.backupSchedules?.[accountId]);
  if (!schedule?.enabled && !backupGlobalEnabled) return null;

  const isFailed = backupState?.lastStatus === 'failed';
  const isSuccess = backupState?.lastStatus === 'success';
  const lastBackup = backupState?.lastBackupTime || 0;
  const neverBackedUp = lastBackup === 0;

  // Determine if overdue based on configured interval (idle backups don't use nextRunTime)
  const interval = backupGlobalEnabled ? backupGlobalConfig?.interval : schedule?.interval;
  const intervalMs = interval === 'hourly' ? 3600_000 : interval === 'weekly' ? 7 * 24 * 3600_000 : 24 * 3600_000;
  // Give 50% grace period before showing overdue (e.g. daily = 36 hours grace)
  const isOverdue = lastBackup > 0 && (Date.now() - lastBackup) > intervalMs * 1.5;

  // Show green if last backup succeeded — even if slightly overdue, it means the backup
  // ran fine and the scheduler just hasn't had a chance to run again yet.
  // Show amber only for failures, never-backed-up, or overdue WITHOUT a success status.
  const showWarning = isFailed || neverBackedUp || (isOverdue && !isSuccess);

  const icon = showWarning
    ? <AlertCircle size={12} className="text-amber-500 flex-shrink-0" />
    : <CheckCircle2 size={12} className="text-emerald-500 flex-shrink-0" />;

  const title = isFailed ? 'Backup failed — click to view'
    : neverBackedUp ? 'Never backed up — click to configure'
    : isOverdue && !isSuccess ? 'Backup overdue — click to view'
    : 'Backup up to date';

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.(accountId); }}
      className="hover:opacity-70 transition-opacity"
      title={title}
    >
      {icon}
    </button>
  );
}

function refreshCurrentView() {
  return useMailStore.getState().refreshCurrentView();
}

function CollapsedBackupIcon({ onOpenBackup }) {
  const ab = useBackupStore(s => s.activeBackup);
  if (!ab?.active) return null;
  return (
    <button onClick={onOpenBackup} className="p-2 hover:bg-mail-accent/10 rounded-lg transition-colors" title={`Backing up ${ab.accountEmail}...`}>
      <HardDrive size={16} className="text-mail-accent animate-pulse" />
    </button>
  );
}

function BackupIndicator({ onOpenBackup }) {
  const activeBackup = useBackupStore(s => s.activeBackup);
  if (!activeBackup || !activeBackup.active) return null;

  const isDone = activeBackup.done;
  const percent = activeBackup.totalFolders > 0
    ? Math.round((activeBackup.completedFolders / activeBackup.totalFolders) * 100)
    : 0;

  return (
    <button
      onClick={onOpenBackup}
      className={`w-full mt-1 flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors ${
        isDone ? 'text-mail-success hover:bg-mail-success/10' : 'text-mail-accent hover:bg-mail-accent/10'
      }`}
    >
      {isDone ? (
        <CheckCircle2 size={12} className="flex-shrink-0" />
      ) : (
        <Loader size={12} className="animate-spin flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="truncate">
          {isDone ? 'Backup complete' : `Backing up ${activeBackup.accountEmail}`}
          {!isDone && activeBackup.queueLength > 0 && <span className="text-mail-text-muted"> +{activeBackup.queueLength}</span>}
        </div>
        {!isDone && activeBackup.totalFolders > 0 && (
          <div className="h-0.5 rounded-full bg-mail-border mt-1 overflow-hidden">
            <div className="h-0.5 rounded-full bg-mail-accent transition-all" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
    </button>
  );
}

/** Collapsed sidebar: one button per account — memoized so backup badge changes only rerender this row */
const CollapsedAccountButton = memo(function CollapsedAccountButton({
  account, isActive, color, initial, unifiedInbox, connectionStatus, connectionError,
  unreadCount, onActivate, onOpenBackup
}) {
  return (
    <button
      className={`relative p-1.5 rounded-lg transition-all
                 ${isActive && !unifiedInbox
                   ? 'ring-2 ring-offset-1 ring-offset-mail-surface'
                   : 'hover:bg-mail-surface-hover'}`}
      style={isActive && !unifiedInbox ? { '--tw-ring-color': color } : undefined}
      onClick={onActivate}
      title={account.name || account.email}
    >
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold select-none"
        style={{ backgroundColor: color }}
      >
        {initial}
      </div>
      <div className="absolute -top-0.5 -right-0.5">
        <BackupStatusIcon accountId={account.id} onClick={onOpenBackup} />
      </div>
      {unreadCount > 0 && (
        <div className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-0.5 rounded-full bg-red-500 flex items-center justify-center">
          <span className="text-[9px] font-bold text-white leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        </div>
      )}
      {isActive && !unifiedInbox && (
        <div
          className={`absolute bottom-1 right-1 w-2.5 h-2.5 rounded-full border-2 border-mail-surface
                     ${connectionStatus === 'connected' ? 'bg-mail-success' :
                       connectionStatus === 'error' ? 'bg-mail-danger' : 'bg-mail-warning'}`}
          title={
            connectionStatus === 'connected' ? 'Connected' :
            connectionStatus === 'error' ? (connectionError || 'Connection error — retrying...') :
            'Reconnecting...'
          }
        />
      )}
    </button>
  );
});

/** Expanded sidebar: one row per account — memoized so backup badge changes only rerender this row */
const ExpandedAccountRow = memo(function ExpandedAccountRow({
  account, isActive, color, initial, unifiedInbox, connectionStatus, connectionError,
  unreadCount, onActivate, onOpenBackup
}) {
  return (
    <div
      className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all
                 ${isActive && !unifiedInbox
                   ? 'bg-mail-accent/10 text-mail-accent'
                   : 'hover:bg-mail-surface-hover text-mail-text'}`}
      onClick={onActivate}
    >
      <div className="relative flex-shrink-0">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold select-none"
          style={{ backgroundColor: color }}
        >
          {initial}
        </div>
        {unreadCount > 0 && (
          <div className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 flex items-center justify-center">
            <span className="text-[10px] font-bold text-white leading-none">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          </div>
        )}
        {isActive && !unifiedInbox && (
          <div
            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-mail-surface
                       ${connectionStatus === 'connected' ? 'bg-mail-success' :
                         connectionStatus === 'error' ? 'bg-mail-danger' : 'bg-mail-warning'}`}
            title={connectionStatus === 'connected' ? 'Connected' :
                   connectionStatus === 'error' ? `Offline: ${connectionError}` : 'Connecting...'}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        {account.name ? (
          <>
            <div className="text-sm font-medium truncate">
              {account.name}
            </div>
            <div className="text-xs text-mail-text-muted truncate">
              {account.email}
            </div>
          </>
        ) : (
          <div className="text-sm font-medium truncate">
            {account.email}
          </div>
        )}
      </div>
      <BackupStatusIcon accountId={account.id} onClick={onOpenBackup} />
    </div>
  );
});

export function Sidebar({ onAddAccount, onCompose, onOpenSettings, onOpenBackup, onOpenAccounts }) {
  const accounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const mailboxes = useAccountStore(s => s.mailboxes);
  const activeMailbox = useAccountStore(s => s.activeMailbox);
  const viewMode = useUiStore(s => s.viewMode);
  const connectionStatus = useAccountStore(s => s.connectionStatus);
  const connectionError = useAccountStore(s => s.connectionError);
  const connectionErrorType = useAccountStore(s => s.connectionErrorType);
  const suspectEmptyServerData = useSyncStore(s => s.suspectEmptyServerData);
  const emails = useMessageListStore(s => s.emails);
  const totalEmails = useMessageListStore(s => s.totalEmails);
  const loading = useSyncStore(s => s.loading);
  const loadingMore = useSyncStore(s => s.loadingMore);
  const hasMoreEmails = useMessageListStore(s => s.hasMoreEmails);
  const activateAccount = useAccountStore(s => s.activateAccount);
  const setViewMode = useUiStore(s => s.setViewMode);
  const retryKeychainAccess = useAccountStore(s => s.retryKeychainAccess);
  const unreadPerAccount = useSettingsStore(s => s.unreadPerAccount);

  const { theme, toggleTheme } = useThemeStore();
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const getDisplayName = useSettingsStore(s => s.getDisplayName);
  const accountColors = useSettingsStore(s => s.accountColors);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const sidebarCollapsed = useSettingsStore(s => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useSettingsStore(s => s.toggleSidebarCollapsed);
  const accountOrder = useSettingsStore(s => s.accountOrder);
  const sidebarAccountsRatio = useSettingsStore(s => s.sidebarAccountsRatio);
  const setSidebarAccountsRatio = useSettingsStore(s => s.setSidebarAccountsRatio);

  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPremium = hasPremiumAccess(billingProfile);

  const [expandedFolders, setExpandedFolders] = useState(new Set(['INBOX']));
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [showError, setShowError] = useState(false);

  // Delay showing connection errors by 3 seconds — transient errors on launch resolve quickly
  useEffect(() => {
    if (connectionStatus === 'error') {
      const timer = setTimeout(() => setShowError(true), 3000);
      return () => clearTimeout(timer);
    }
    setShowError(false);
  }, [connectionStatus, activeAccountId]);

  const unifiedInbox = useAccountStore(s => s.unifiedInbox);
  const setUnifiedInbox = useAccountStore(s => s.setUnifiedInbox);

  const orderedAccounts = useMemo(
    () => getOrderedAccounts(accounts).filter(a => !hiddenAccounts[a.id]),
    [accounts, hiddenAccounts, getOrderedAccounts, accountOrder]
  );
  const collapsed = sidebarCollapsed;
  const showUnifiedInbox = orderedAccounts.length >= 2;

  // Sort mailboxes: INBOX first, then alphabetically; children sorted alphabetically too
  const sortedMailboxes = useMemo(() => {
    const sorted = [...mailboxes].sort((a, b) => {
      if (a.path === 'INBOX') return -1;
      if (b.path === 'INBOX') return 1;
      return a.name.localeCompare(b.name);
    });
    return sorted.map(m => m.children?.length > 0
      ? { ...m, children: [...m.children].sort((a, b) => a.name.localeCompare(b.name)) }
      : m
    );
  }, [mailboxes]);

  const toggleFolder = (path) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Shared error modal (rendered in both collapsed and expanded views)
  const errorModal = (
    <AnimatePresence>
      {showErrorModal && connectionError && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowErrorModal(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="bg-mail-bg border border-mail-border rounded-xl shadow-xl max-w-md w-full mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
              <h3 className="text-sm font-semibold text-mail-text">Error Details</h3>
              <button
                onClick={() => setShowErrorModal(false)}
                className="p-1 hover:bg-mail-surface-hover rounded transition-colors"
              >
                <X size={14} className="text-mail-text-muted" />
              </button>
            </div>
            <div className="p-4">
              <p className="text-sm text-mail-text-muted whitespace-pre-wrap break-words">
                {connectionError}
              </p>
              {connectionErrorType === 'outlookOAuth' && (
                <button
                  onClick={async () => {
                    const url = 'https://mailvaultapp.com/faq.html#microsoft-outlook-oauth2';
                    if (window.__TAURI__) {
                      const { open } = await import('@tauri-apps/plugin-shell');
                      await open(url);
                    } else {
                      window.open(url, '_blank');
                    }
                  }}
                  className="mt-3 text-sm text-mail-accent hover:text-mail-accent-hover transition-colors underline"
                >
                  Learn more in our FAQ
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  // --- COLLAPSED SIDEBAR ---
  if (collapsed) {
    return (
      <div className="w-14 h-full bg-mail-surface border-r border-mail-border flex flex-col items-center relative transition-all duration-200">
        {/* Expand button */}
        <div data-tauri-drag-region className="w-full py-3 flex justify-center border-b border-mail-border flex-shrink-0">
          <button
            onClick={toggleSidebarCollapsed}
            className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            title="Expand sidebar"
          >
            <PanelLeftOpen size={18} className="text-mail-text-muted" />
          </button>
        </div>

        {/* Compose */}
        <div className="w-full py-2 flex justify-center border-b border-mail-border">
          <button
            onClick={onCompose}
            className="p-2.5 bg-mail-accent hover:bg-mail-accent-hover text-white rounded-lg transition-all shadow-glow hover:shadow-glow-lg"
            title="Compose"
          >
            <PenSquare size={16} />
          </button>
        </div>

        {/* All Inboxes (collapsed) */}
        {showUnifiedInbox && (
          <div className="w-full py-2 border-b border-mail-border flex justify-center">
            <button
              data-testid="all-inboxes-btn"
              onClick={() => setUnifiedInbox(true)}
              className={`p-2 rounded-lg transition-all
                         ${unifiedInbox
                           ? 'bg-mail-accent/10 text-mail-accent'
                           : 'text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover'}`}
              title="All Inboxes"
            >
              <Inbox size={16} />
            </button>
          </div>
        )}

        {/* Account icons */}
        <div className="w-full py-2 border-b border-mail-border flex flex-col items-center gap-1">
          {orderedAccounts.map(account => (
            <CollapsedAccountButton
              key={account.id}
              account={account}
              isActive={account.id === activeAccountId}
              color={getAccountColor(accountColors, account)}
              initial={getAccountInitial(account, getDisplayName(account.id))}
              unifiedInbox={unifiedInbox}
              connectionStatus={connectionStatus}
              connectionError={connectionError}
              unreadCount={unreadPerAccount[account.id] || 0}
              onActivate={() => {
                const lastMailbox = useSettingsStore.getState().getLastMailbox(account.id);
                activateAccount(account.id, lastMailbox || 'INBOX');
              }}
              onOpenBackup={onOpenBackup}
            />
          ))}
          {orderedAccounts.length === 0 && (
            <button
              data-testid="add-account-btn"
              onClick={onAddAccount}
              className="p-1.5 hover:bg-mail-surface-hover rounded-lg transition-all"
              title="Add Account"
            >
              <Plus size={16} className="text-mail-text-muted" />
            </button>
          )}
        </div>

        {/* Folder icons with expandable children — hidden in unified inbox mode */}
        {unifiedInbox && <div className="flex-1" />}
        {!unifiedInbox && <div className="flex-1 overflow-y-auto w-full py-2 flex flex-col items-center gap-0.5">
          {sortedMailboxes.map(mailbox => {
            const Icon = getMailboxIcon(mailbox);
            const isActive = activeMailbox === mailbox.path;
            const hasChildren = mailbox.children?.length > 0;
            const isExpanded = expandedFolders.has(mailbox.path);
            return (
              <div key={mailbox.path} className="w-full flex flex-col items-center">
                <button
                  className={`p-2 rounded-lg transition-all
                             ${isActive && !mailbox.noselect
                               ? 'bg-mail-accent/10 text-mail-accent'
                               : 'text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover'}`}
                  onClick={() => {
                    if (mailbox.noselect && hasChildren) {
                      toggleFolder(mailbox.path);
                    } else if (!mailbox.noselect) {
                      activateAccount(activeAccountId, mailbox.path);
                      if (hasChildren) toggleFolder(mailbox.path);
                    }
                  }}
                  title={getMailboxDisplayName(mailbox.name)}
                >
                  <Icon size={16} />
                </button>
                {hasChildren && isExpanded && mailbox.children.map(child => {
                  const ChildIcon = getMailboxIcon(child);
                  const isChildActive = activeMailbox === child.path;
                  return (
                    <button
                      key={child.path}
                      className={`p-1.5 rounded-lg transition-all
                                 ${isChildActive
                                   ? 'bg-mail-accent/10 text-mail-accent'
                                   : 'text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover'}`}
                      onClick={() => activateAccount(activeAccountId, child.path)}
                      title={getMailboxDisplayName(child.name)}
                    >
                      <ChildIcon size={13} />
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>}

        {/* Footer icons */}
        <div className="w-full py-2 border-t border-mail-border flex flex-col items-center gap-1">
          <button
            onClick={toggleTheme}
            className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? (
              <Sun size={16} className="text-mail-text-muted" />
            ) : (
              <Moon size={16} className="text-mail-text-muted" />
            )}
          </button>
          <button
            onClick={refreshCurrentView}
            className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            title="Refresh emails"
          >
            <RefreshCw size={16} className={`text-mail-text-muted ${loading || loadingMore ? 'animate-spin' : ''}`} />
          </button>
          {/* Backup in progress indicator (collapsed) */}
          <CollapsedBackupIcon onOpenBackup={onOpenBackup} />
          <button
            onClick={onOpenSettings}
            className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            title="Settings"
          >
            <Settings size={16} className="text-mail-text-muted" />
          </button>
          {totalEmails > 0 && (
            <div
              className="p-2"
              title={loading || loadingMore || hasMoreEmails
                ? `${emails.length.toLocaleString()} / ${totalEmails.toLocaleString()} emails`
                : `${totalEmails.toLocaleString()} emails`}
            >
              {(loading || loadingMore || hasMoreEmails) ? (
                <RefreshCw size={14} className="animate-spin text-mail-accent" />
              ) : (
                <HardDrive size={14} className="text-mail-text-muted" />
              )}
            </div>
          )}
        </div>

        {errorModal}
      </div>
    );
  }

  // --- EXPANDED SIDEBAR ---
  return (
    <div className="w-64 h-full bg-mail-surface border-r border-mail-border flex flex-col relative transition-all duration-200">
      {/* Logo */}
      <div data-tauri-drag-region className="px-4 py-3 border-b border-mail-border flex items-center justify-between flex-shrink-0">
        <h1 className="text-xl font-display font-bold">
          <span className="text-mail-accent">Mail</span>
          <span className="text-mail-text">Vault</span>
        </h1>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleTheme}
            className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? (
              <Sun size={18} className="text-mail-text-muted" />
            ) : (
              <Moon size={18} className="text-mail-text-muted" />
            )}
          </button>
          <button
            onClick={refreshCurrentView}
            className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            title="Refresh emails"
          >
            <RefreshCw size={18} className={`text-mail-text-muted ${loading || loadingMore ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={toggleSidebarCollapsed}
            className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            title="Collapse sidebar"
          >
            <PanelLeftClose size={18} className="text-mail-text-muted" />
          </button>
        </div>
      </div>

      {/* Compose Button */}
      <div className="p-3 border-b border-mail-border">
        <button
          onClick={onCompose}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                     bg-mail-accent hover:bg-mail-accent-hover text-white
                     font-medium rounded-lg transition-all shadow-glow hover:shadow-glow-lg"
        >
          <PenSquare size={18} />
          Compose
        </button>
      </div>

      {/* Account Selector */}
      <div className="p-3 overflow-y-auto flex-shrink-0" style={{ flex: `0 0 ${sidebarAccountsRatio * 100}%`, minHeight: 60, maxHeight: 'calc(100% - 340px)' }}>
        <div className="relative">
          {/* All Inboxes (expanded) */}
          {showUnifiedInbox && (
            <div
              data-testid="all-inboxes-btn"
              className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all mb-1
                         ${unifiedInbox
                           ? 'bg-mail-accent/10 text-mail-accent'
                           : 'hover:bg-mail-surface-hover text-mail-text'}`}
              onClick={() => setUnifiedInbox(true)}
            >
              <div className="w-8 h-8 rounded-full flex items-center justify-center bg-mail-accent/15">
                <Inbox size={16} className={unifiedInbox ? 'text-mail-accent' : 'text-mail-text-muted'} />
              </div>
              <div className="text-sm font-medium">All Inboxes</div>
            </div>
          )}

          {orderedAccounts.map(account => {
            const color = getAccountColor(accountColors, account);
            const initial = getAccountInitial(account, getDisplayName(account.id));
            return (
            <React.Fragment key={account.id}>
              <ExpandedAccountRow
                account={account}
                isActive={account.id === activeAccountId}
                color={color}
                initial={initial}
                unifiedInbox={unifiedInbox}
                connectionStatus={connectionStatus}
                connectionError={connectionError}
                unreadCount={unreadPerAccount[account.id] || 0}
                onActivate={() => {
                  const lastMailbox = useSettingsStore.getState().getLastMailbox(account.id);
                  activateAccount(account.id, lastMailbox || 'INBOX');
                }}
                onOpenBackup={onOpenBackup}
              />

              {/* Suspect empty data warning — server returned empty but cache had data */}
              {account.id === activeAccountId && suspectEmptyServerData?.accountId === account.id && (
                <div className="mt-1 mb-1 p-2 rounded-lg border bg-mail-warning/10 border-mail-warning/20">
                  <div className="flex items-center justify-between text-xs text-mail-warning">
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={14} />
                      <span>Showing cached data</span>
                    </div>
                    <button
                      onClick={() => activateAccount(activeAccountId, activeMailbox)}
                      className="p-1 hover:bg-mail-warning/20 rounded transition-colors"
                      title="Retry connection"
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                  <p className="mt-1 text-[10px] text-mail-text-muted leading-tight">
                    {suspectEmptyServerData.message}
                  </p>
                </div>
              )}

              {/* Inline error banner — shown directly below the account that has the error */}
              {account.id === activeAccountId && showError && connectionStatus === 'error' && (
                <div className={`mt-1 mb-1 p-2 rounded-lg border ${
                  connectionErrorType === 'passwordMissing'
                    ? 'bg-mail-warning/10 border-mail-warning/20'
                    : 'bg-mail-danger/10 border-mail-danger/20'
                }`}>
                  {connectionErrorType === 'passwordMissing' ? (
                    <div className="text-xs text-mail-warning">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Key size={14} />
                          <span>Password missing</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={retryKeychainAccess}
                            className="p-1 hover:bg-mail-warning/20 rounded transition-colors"
                            title="Retry"
                          >
                            <RefreshCw size={12} />
                          </button>
                        </div>
                      </div>
                      <button
                        onClick={() => onOpenAccounts?.(account.id)}
                        className="mt-1.5 w-full px-2 py-1 text-xs font-medium bg-mail-warning/20
                                   hover:bg-mail-warning/30 rounded transition-colors text-center"
                      >
                        Re-enter Password in Settings
                      </button>
                    </div>
                  ) : (
                    <div className={`flex items-center justify-between text-xs ${
                      connectionErrorType === 'passwordMissing' ? 'text-mail-warning' : 'text-mail-danger'
                    }`}>
                      <div className="flex items-center gap-2">
                        {connectionErrorType === 'offline' ? (
                          <><WifiOff size={14} /><span>No internet</span></>
                        ) : connectionErrorType === 'outlookOAuth' ? (
                          <><ServerOff size={14} /><span>Microsoft issue</span></>
                        ) : connectionErrorType === 'oauthExpired' ? (
                          <><Key size={14} /><span>OAuth2 expired</span></>
                        ) : connectionErrorType === 'timeout' ? (
                          <><RefreshCw size={14} /><span>Timed out</span></>
                        ) : (
                          <><ServerOff size={14} /><span>Server error</span></>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setShowErrorModal(true)}
                          className="p-1 hover:bg-mail-danger/20 rounded transition-colors"
                          title="View error details"
                        >
                          <Info size={12} />
                        </button>
                        <button
                          onClick={() => activateAccount(activeAccountId, activeMailbox)}
                          className="p-1 hover:bg-mail-danger/20 rounded transition-colors"
                          title="Retry connection"
                        >
                          <RefreshCw size={12} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </React.Fragment>
            );
          })}

          {orderedAccounts.length === 0 && (
            <button
              data-testid="add-account-btn"
              onClick={onAddAccount}
              className="w-full mt-2 flex items-center gap-2 p-2 text-sm text-mail-text-muted
                        hover:text-mail-text hover:bg-mail-surface-hover rounded-lg transition-all"
            >
              <Plus size={16} />
              Add Account
            </button>
          )}
        </div>

        {/* Backup progress indicator */}
        <BackupIndicator onOpenBackup={onOpenBackup} />
      </div>

      {/* Drag divider between accounts and folders */}
      <div
        className="h-1 border-y border-mail-border cursor-row-resize hover:bg-mail-accent/20 active:bg-mail-accent/30 transition-colors flex-shrink-0"
        onMouseDown={(e) => {
          e.preventDefault();
          const sidebar = e.currentTarget.closest('.flex.flex-col');
          if (!sidebar) return;
          const sidebarRect = sidebar.getBoundingClientRect();
          // Get fixed heights (logo + compose + view mode + footer)
          const fixedHeight = 200; // approximate fixed sections height
          const availableHeight = sidebarRect.height - fixedHeight;

          const handleMouseMove = (moveEvent) => {
            const relativeY = moveEvent.clientY - sidebarRect.top - 120; // offset for logo+compose
            const ratio = relativeY / availableHeight;
            setSidebarAccountsRatio(ratio);
          };
          const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
          };
          document.addEventListener('mousemove', handleMouseMove);
          document.addEventListener('mouseup', handleMouseUp);
        }}
        title="Drag to resize"
      />

      {/* View Mode Toggle */}
      <div className="p-3 border-b border-mail-border flex-shrink-0">
        <div className="text-xs text-mail-text-muted uppercase tracking-wide mb-2">
          View Mode
        </div>
        <div className="flex gap-1 bg-mail-bg rounded-lg p-1">
          {[
            { id: 'all', icon: Layers, label: 'All' },
            { id: 'server', icon: Cloud, label: 'Server' },
            { id: 'local', icon: HardDrive, label: 'Local' }
          ].map(mode => (
            <button
              key={mode.id}
              onClick={() => setViewMode(mode.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2
                         rounded-md text-xs font-medium transition-all
                         ${viewMode === mode.id
                           ? 'bg-mail-accent text-white'
                           : 'text-mail-text-muted hover:text-mail-text'}`}
            >
              <mode.icon size={12} />
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      {/* Mailboxes — show common folders in unified mode, full tree otherwise */}
      {unifiedInbox && (
        <UnifiedFolderList />
      )}
      {!unifiedInbox && <div className="overflow-y-auto p-3 flex-1" style={{ minHeight: 60 }}>
        <div className="text-xs text-mail-text-muted uppercase tracking-wide mb-2">
          Folders
        </div>

        {sortedMailboxes.map(mailbox => {
          const Icon = getMailboxIcon(mailbox);
          const hasChildren = mailbox.children?.length > 0;
          const isExpanded = expandedFolders.has(mailbox.path);
          const isActive = activeMailbox === mailbox.path;

          return (
            <div key={mailbox.path}>
              <div
                className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors
                           ${mailbox.noselect ? 'cursor-default' : 'cursor-pointer'}
                           ${isActive && !mailbox.noselect
                             ? 'bg-mail-accent/10 text-mail-accent'
                             : 'text-mail-text hover:bg-mail-surface-hover'}`}
                onClick={() => {
                  if (mailbox.noselect && hasChildren) {
                    toggleFolder(mailbox.path);
                  } else if (!mailbox.noselect) {
                    activateAccount(activeAccountId, mailbox.path);
                  }
                }}
              >
                {hasChildren && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFolder(mailbox.path);
                    }}
                    className="p-0.5"
                  >
                    {isExpanded ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </button>
                )}
                {!hasChildren && <div className="w-5" />}
                <Icon size={16} />
                <span className="text-sm flex-1 truncate">{getMailboxDisplayName(mailbox.name)}</span>
              </div>

              {hasChildren && isExpanded && (
                <div className="ml-4">
                  {mailbox.children.map(child => {
                    const ChildIcon = getMailboxIcon(child);
                    const isChildActive = activeMailbox === child.path;

                    return (
                      <div
                        key={child.path}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg
                                   cursor-pointer transition-colors ${isChildActive
                                     ? 'bg-mail-accent/10 text-mail-accent'
                                     : 'text-mail-text hover:bg-mail-surface-hover'}`}
                        onClick={() => activateAccount(activeAccountId, child.path)}
                      >
                        <div className="w-5" />
                        <ChildIcon size={14} />
                        <span className="text-sm truncate">{getMailboxDisplayName(child.name)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>}

      {/* Footer */}
      <div className="p-3 border-t border-mail-border space-y-0.5">
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2 p-2 text-sm text-mail-text-muted
                    hover:text-mail-text hover:bg-mail-surface-hover rounded-lg transition-all"
        >
          <Settings size={16} />
          Settings
        </button>
        {totalEmails > 0 && (
          <div className="flex items-center gap-1.5 px-2 mt-1 text-xs text-mail-text-muted">
            <HardDrive size={12} />
            {loading || loadingMore || hasMoreEmails ? (
              <span>{emails.length.toLocaleString()} / {totalEmails.toLocaleString()} emails</span>
            ) : (
              <span>{totalEmails.toLocaleString()} emails</span>
            )}
            {(loading || loadingMore || hasMoreEmails) && (
              <RefreshCw size={10} className="animate-spin text-mail-accent" />
            )}
          </div>
        )}
        <div className="text-xs text-mail-text-muted text-center mt-2">
          MailVault v{version}
        </div>
      </div>

      {errorModal}
    </div>
  );
}
