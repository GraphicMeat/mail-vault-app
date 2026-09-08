import React, { useState, useMemo, useEffect, useCallback, useRef, memo } from 'react';
import '../styles/sidebar-navigation.css';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Popover } from './ui/Popover';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { createPortal } from 'react-dom';
import { version } from '../../package.json';
import { useMailStore } from '../stores/mailStore';
import { useAccountStore } from '../stores/accountStore';
import { useMessageListStore } from '../stores/messageListStore';
import { useSyncStore } from '../stores/syncStore';
import { useUiStore } from '../stores/uiStore';
import { useThemeStore } from '../stores/themeStore';
import { useSettingsStore, getAccountInitial, getAccountColor, hasPremiumAccess } from '../stores/settingsStore';
import { useBackupStore } from '../stores/backupStore';
import * as api from '../services/api';
import { formatBytes } from '../utils/formatBytes';
import { lastDaysSeries } from '../utils/transferLimits';
import { t as tr, useT } from '../i18n/index.js';
import { FolderTree, FolderBubbles } from './FolderTree';
import { FolderContextMenu } from './FolderContextMenu';
import { FolderNameDialog } from './FolderNameDialog';
import { FocusTimerButton } from './FocusTimerButton';
import { buildMailboxTree, mailboxAncestors } from '../services/workflows/mailboxTree';
import { openFolder } from '../services/workflows/loadSubtree';
import { mailboxLabel } from '../utils/imapUtf7';
import {
  Inbox,
  Send,
  File,
  Trash2,
  Archive,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Plus,
  Settings,
  Bug,
  HardDrive,
  Cloud,
  Layers,
  PenSquare,
  Sun,
  Moon,
  RefreshCw,
  PanelLeftClose,
  PanelLeftOpen,
  Loader,
  Gift,
  ChevronDown,
  Search,
} from 'lucide-react';

const UNIFIED_FOLDERS = () => ([
  { id: 'INBOX', name: tr('sidebar.inbox'), icon: Inbox },
  { id: tr('list.sent'), name: tr('list.sent'), icon: Send, specialUse: '\\Sent' },
  { id: tr('sidebar.drafts'), name: tr('sidebar.drafts'), icon: File, specialUse: '\\Drafts' },
  { id: tr('settings.storage.trash'), name: tr('settings.storage.trash'), icon: Trash2, specialUse: '\\Trash' },
  { id: tr('common.archive'), name: tr('common.archive'), icon: Archive, specialUse: '\\Archive' },
]);

function UnifiedFolderList({ tagCloud = false, compact = false }) {
  const unifiedFolder = useAccountStore(s => s.unifiedFolder);
  const switchUnifiedFolder = useAccountStore(s => s.switchUnifiedFolder);

  if (compact) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto w-full py-2">
        {UNIFIED_FOLDERS().map(folder => {
          const Icon = folder.icon;
          return (
            <button key={folder.id} type="button" title={folder.name} aria-label={folder.name}
              aria-current={unifiedFolder === folder.id ? 'true' : undefined}
              onClick={() => switchUnifiedFolder(folder.id)}
              className={`flex items-center justify-center w-10 h-8 mx-auto mb-1 rounded-lg transition-colors ${unifiedFolder === folder.id ? 'bg-mail-accent-tint text-mail-accent-text' : 'text-mail-text-muted hover:bg-mail-surface-hover'}`}>
              <Icon size={16} />
            </button>
          );
        })}
      </div>
    );
  }

  if (tagCloud) {
    return (
      <div>
        <div className="flex flex-wrap gap-1.5">
          {UNIFIED_FOLDERS().map(folder => {
            const isActive = unifiedFolder === folder.id;
            const Icon = folder.icon;
            return (
              <button
                key={folder.id}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => switchUnifiedFolder(folder.id)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors border
                           ${isActive
                             ? 'bg-mail-accent-tint text-mail-accent-text border-mail-accent'
                             : 'text-mail-text border-mail-border hover:bg-mail-surface-hover'}`}
                title={folder.name}
              >
                <Icon size={12} />
                <span className="truncate max-w-[140px]">{folder.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div>
      {UNIFIED_FOLDERS().map(folder => {
        const isActive = unifiedFolder === folder.id;
        const Icon = folder.icon;
        return (
          <div
            key={folder.id}
            role="button" tabIndex={0} aria-current={isActive ? 'true' : undefined}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchUnifiedFolder(folder.id); } }}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors
                       ${isActive ? 'bg-mail-accent/10 text-mail-accent-text' : 'text-mail-text hover:bg-mail-surface-hover'}`}
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
  const t = useT();
  const backupState = useSettingsStore(s => s.backupState?.[accountId]);
  const backupGlobalEnabled = useSettingsStore(s => s.backupGlobalEnabled);
  const backupGlobalConfig = useSettingsStore(s => s.backupGlobalConfig);
  const schedule = useSettingsStore(s => s.backupSchedules?.[accountId]);
  const billingProfile = useSettingsStore(s => s.billingProfile);
  // No premium, no automatic runs — so no schedule health to report.
  if (!hasPremiumAccess(billingProfile)) return null;
  if (!schedule?.enabled && !backupGlobalEnabled) return null;

  const isFailed = backupState?.lastStatus === 'failed';
  const isSuccess = backupState?.lastStatus === 'success';
  // Partial run: the vault got most of it, but something did not arrive.
  const isDegraded = backupState?.lastStatus === 'degraded';
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
  const showWarning = isFailed || isDegraded || neverBackedUp || (isOverdue && !isSuccess);

  const icon = showWarning
    ? <AlertCircle size={12} className="text-mail-warning flex-shrink-0" />
    : <CheckCircle2 size={12} className="text-mail-success flex-shrink-0" />;

  const title = isFailed ? t('sidebar.backupFailedClickView')
    : isDegraded ? t('sidebar.backupIncompleteClickView')
    : neverBackedUp ? t('sidebar.neverBackedUpClickConfigure')
    : isOverdue && !isSuccess ? t('sidebar.backupOverdueClickView')
    : t('sidebar.backupUpDate');

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.(accountId); }}
      className="sidebar-backup-status hover:opacity-70 transition-opacity"
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
      <HardDrive size={16} className="text-mail-accent-text animate-pulse" />
    </button>
  );
}

function BackupIndicator({ onOpenBackup }) {
  const t = useT();
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
        isDone ? 'text-mail-success hover:bg-mail-success/10' : 'text-mail-accent-text hover:bg-mail-accent/10'
      }`}
    >
      {isDone ? (
        <CheckCircle2 size={12} className="flex-shrink-0" />
      ) : (
        <Loader size={12} className="animate-spin flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="truncate">
          {isDone ? t('sidebar.backupComplete') : t('sidebar.backingUp', { activeBackup: activeBackup.accountEmail })}
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
  account, label, isActive, color, initial, unifiedInbox, connectionStatus,
  unreadCount, onActivate, onActivateInbox, onOpenBackup
}) {
  const t = useT();
  return (
    <div className="relative">
      <button type="button"
        className={`relative p-1.5 rounded-lg transition-colors ${isActive && !unifiedInbox ? 'bg-mail-accent-tint' : 'hover:bg-mail-surface-hover'}`}
        onClick={onActivate}
        onDoubleClick={onActivateInbox}
        aria-label={label === account.email ? label : `${label}, ${account.email}`}
        aria-current={isActive && !unifiedInbox ? 'true' : undefined}
        title={label === account.email ? label : `${label} — ${account.email}`}>
        <span className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold select-none" style={{ backgroundColor: color }}>
          {initial}
        </span>
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-0.5 rounded-full bg-mail-danger-fill flex items-center justify-center">
            <span className="text-[11px] font-bold text-white leading-none">{unreadCount > 99 ? '99+' : unreadCount}</span>
          </span>
        )}
        {isActive && !unifiedInbox && (
          <span className={`absolute bottom-1 right-1 w-2.5 h-2.5 rounded-full border-2 border-mail-surface ${connectionStatus === 'connected' ? 'bg-mail-success' : connectionStatus === 'error' ? 'bg-mail-danger' : 'bg-mail-warning'}`}
            title={connectionStatus === 'connected' ? t('settings.accounts.connected') : connectionStatus === 'error' ? t('sidebar.connectionProblem') : t('sidebar.connecting')} />
        )}
      </button>
      <div className="sidebar-collapsed-backup"><BackupStatusIcon accountId={account.id} onClick={onOpenBackup} /></div>
    </div>
  );
});

/** Account identity is the same in both navigation styles. Folder style is independent. */
const ExpandedAccountRow = memo(function ExpandedAccountRow({
  account, label, isActive, color, initial, unifiedInbox, connectionStatus,
  unreadCount, onActivate, onActivateInbox, onOpenBackup,
}) {
  const t = useT();
  const selected = isActive && !unifiedInbox;
  const showAddress = label !== account.email;
  return (
    <div className={`sidebar-account-row ${selected ? 'sidebar-account-selected' : ''}`}>
      <button type="button" className="sidebar-account-open"
        aria-label={showAddress ? `${label}, ${account.email}` : account.email}
        aria-current={selected ? 'true' : undefined}
        title={showAddress ? `${label} — ${account.email}` : account.email}
        onClick={onActivate} onDoubleClick={onActivateInbox}>
        <span className="sidebar-account-avatar" style={{ backgroundColor: color }} aria-hidden="true">{initial}</span>
        <span className="sidebar-account-label">
          <span className="sidebar-account-name">{label}</span>
          {showAddress && <span className="sidebar-account-address">{account.email}</span>}
        </span>
        <span className="sidebar-account-indicators">
          {unreadCount > 0 && <span className="sidebar-unread-count">{unreadCount > 99 ? '99+' : unreadCount}</span>}
          {selected && connectionStatus !== 'connected' && (
            connectionStatus === 'error'
              ? <AlertCircle size={14} className="text-mail-warning" aria-label={t('sidebar.connectionProblem')} />
              : <Loader size={13} className="text-mail-text-muted animate-spin" aria-label={t('sidebar.connecting')} />
          )}
        </span>
      </button>
      <BackupStatusIcon accountId={account.id} onClick={onOpenBackup} />
    </div>
  );
});

/** A readable status and the next useful action. Technical repair lives in Details. */
export const ConnectionErrorCard = memo(function ConnectionErrorCard({
  account, connectionErrorType, activeMailbox, activateAccount,
  setShowErrorModal, onOpenAccounts, wrapperClassName = '',
}) {
  const t = useT();
  const needsPassword = connectionErrorType === 'passwordMissing';
  const needsSignIn = connectionErrorType === 'oauthExpired';
  const statusKey = needsPassword ? 'sidebar.passwordMissing'
    : needsSignIn ? 'sidebar.signInRequired'
    : connectionErrorType === 'offline' ? 'sidebar.noInternet'
    : connectionErrorType === 'outlookOAuth' ? 'sidebar.microsoftIssue'
    : connectionErrorType === 'timeout' ? 'sidebar.timedOut'
    : 'sidebar.connectionProblem';
  const repair = () => needsPassword || needsSignIn
    ? onOpenAccounts?.(account.id, 'connection')
    : activateAccount(account.id, activeMailbox);

  return (
    <div className={`sidebar-connection-notice ${wrapperClassName}`}>
      <p role="status"><AlertCircle size={13} aria-hidden="true" /><span>{t(statusKey)}</span></p>
      <div className="sidebar-connection-actions">
        <Button variant="link" size="xs" onClick={repair}>
          {t(needsPassword ? 'sidebar.enterPassword' : needsSignIn ? 'sidebar.reconnect' : 'common.retry')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => setShowErrorModal(true)} title={t('sidebar.viewErrorDetails')}>
          {t('sidebar.details')}
        </Button>
      </div>
    </div>
  );
});

// Module-level so the 30s cache survives re-renders (but not app reloads — that's fine).
const transferStatsHoverCache = new Map(); // accountId -> { data, ts }
const HOVER_DELAY_MS = 400;
const HOVER_CACHE_MS = 30_000;

const HOVER_CLOSE_MS = 220;
const HOVER_BUBBLE_HEIGHT = 230; // approximate, only used to keep the bubble on screen

function StatRow({ label, bucket }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between">
      <span className="text-mail-text-muted">{label}</span>
      <span className="text-mail-text font-medium">
        {t('sidebar.downUpBytes', { down: formatBytes(bucket?.down), up: formatBytes(bucket?.up) })}
      </span>
    </div>
  );
}

/** Portaled hover bubble: 7-day bar chart + totals, click opens Settings > Data Usage. */
function TransferStatsHoverBubble({ pos, stats, onClick, onMouseEnter, onMouseLeave }) {
  const t = useT();
  const week = stats ? lastDaysSeries(stats.days, 7) : [];
  const peak = Math.max(1, ...week.map(d => d.down + d.up));

  return createPortal(
    <div
      className="fixed z-[80] w-64 bg-mail-surface border border-mail-strong rounded-lg p-3 text-xs cursor-pointer"
      style={{ top: pos.top, left: pos.left }}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {stats ? (
        <>
          <div className="flex items-center justify-between mb-2">
            <span className="text-mail-text-muted">{t('sidebar.lastNDays', { n: 7 })}</span>
            <span className="flex items-center gap-2 text-[11px] text-mail-text-muted">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-mail-accent" />{t('sidebar.down')}</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-mail-accent/45" />{t('sidebar.up')}</span>
            </span>
          </div>

          <div className="flex items-end gap-1 h-16">
            {week.map(d => {
              const total = d.down + d.up;
              return (
                <div
                  key={d.key}
                  className="flex-1 h-full flex flex-col justify-end"
                  title={`${d.key}: ${tr('sidebar.downUpBytes', { down: formatBytes(d.down), up: formatBytes(d.up) })}`}
                >
                  <div
                    className="w-full flex flex-col justify-end rounded-t-sm overflow-hidden"
                    style={{ height: total > 0 ? `${Math.max(6, (total / peak) * 100)}%` : '2px' }}
                  >
                    {total > 0 ? (
                      <>
                        <div className="w-full bg-mail-accent/45" style={{ flexGrow: d.up }} />
                        <div className="w-full bg-mail-accent" style={{ flexGrow: d.down }} />
                      </>
                    ) : (
                      <div className="w-full h-full bg-mail-border" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex gap-1 mt-1 mb-2 text-[11px] text-mail-text-muted">
            {week.map(d => <div key={d.key} className="flex-1 text-center">{d.label}</div>)}
          </div>

          <div className="space-y-1.5 pt-2 border-t border-mail-border">
            <StatRow label="Today" bucket={stats.today} />
            <StatRow label="This week" bucket={stats.week} />
            <StatRow label="This month" bucket={stats.month} />
          </div>

          <div className="mt-2 pt-2 border-t border-mail-border text-mail-accent-text">
            {t('sidebar.clickToSeeMore')}
          </div>
        </>
      ) : (
        <div className="text-mail-text-muted">{t('sidebar.loading')}</div>
      )}
    </div>,
    document.body
  );
}

/** Searchable account selection stays anchored to the current account. */
function AccountChooser({ position, onClose, accounts, renderAccount, unifiedRow, onAddAccount }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const panelRef = useDialogA11y(true, onClose);
  const normalized = query.trim().toLocaleLowerCase();
  const matches = accounts.filter(({ label, account }) =>
    `${label} ${account.email}`.toLocaleLowerCase().includes(normalized));
  const showUnified = !!unifiedRow && (!normalized || t('sidebar.allInboxes').toLocaleLowerCase().includes(normalized));

  const moveFocus = (event) => {
    // Keyboard interaction belongs to this picker while it covers the mail
    // view, including printable keys on results that would delete or reply.
    event.stopPropagation();
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const fromInput = event.target.tagName === 'INPUT';
    if (fromInput && (event.key === 'Home' || event.key === 'End')) return;
    const choices = [...panelRef.current.querySelectorAll('[data-account-choice], .sidebar-account-open')];
    if (!choices.length) return;
    event.preventDefault();
    const current = choices.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % choices.length
        : current <= 0 ? choices.length - 1 : current - 1;
    choices[index].focus();
    choices[index].scrollIntoView?.({ block: 'nearest' });
  };

  return <Popover open onClose={onClose} ref={panelRef} variant="panel" role="dialog"
    aria-label={t('workspace.accounts')} aria-modal="true" className="sidebar-account-chooser"
    style={position} onKeyDown={moveFocus}>
    <label className="sidebar-find-field">
      <Search size={14} aria-hidden="true" />
      <input data-autofocus type="search" aria-label={t('sidebar.findAccount')}
        placeholder={t('sidebar.findAccount')} value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    <div className="sidebar-chooser-list">
      {showUnified && unifiedRow}
      {matches.map(({ account }) => renderAccount(account, true))}
      {matches.length === 0 && !showUnified && <p className="sidebar-no-results" role="status">{t('sidebar.noAccountsFound')}</p>}
    </div>
    <div className="sidebar-chooser-footer">
      <Button variant="primary" fullWidth size="sm" data-account-choice
        onClick={() => { onClose(); onAddAccount?.(); }}><Plus size={15} />{t('sidebar.addAccount')}</Button>
    </div>
  </Popover>;
}

export function Sidebar({ onAddAccount, onCompose, onOpenSettings, onOpenBackup, onOpenAccounts, onOpenDataUsage, onReportBug, onReferFriend }) {
  const t = useT();
  const accounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const mailboxes = useAccountStore(s => s.mailboxes);
  const activeMailbox = useAccountStore(s => s.activeMailbox);
  // STATUS counts for the folders that are not open. Keyed by account, and
  // `mailboxes` is the ACTIVE account's list, so that is the key to read.
  const folderStatus = useAccountStore(s => s.folderStatus);
  const viewMode = useUiStore(s => s.viewMode);
  const connectionStatus = useAccountStore(s => s.connectionStatus);
  const connectionError = useAccountStore(s => s.connectionError);
  const connectionErrorType = useAccountStore(s => s.connectionErrorType);
  const suspectEmptyServerData = useSyncStore(s => s.suspectEmptyServerData);
  const totalEmails = useMessageListStore(s => s.totalEmails);
  const cachedCount = useMessageListStore(s => s.cachedCount);
  const loading = useSyncStore(s => s.loading);
  const loadingMore = useSyncStore(s => s.loadingMore);
  const manualRefreshSpinning = useAccountStore(s => s.manualRefreshSpinning);
  const activateAccount = useAccountStore(s => s.activateAccount);

  // Single click resumes the folder you last read in that account; double click
  // is the shortcut straight to its Inbox. Bound on the row WRAPPER so all
  // three layouts (collapsed, tag cloud, expanded) get it from one place.
  //
  // Unconditional on purpose. A dblclick lands while the click's own activation
  // is still in flight, and the store it would be tested against is mid-switch:
  // a guard that skipped "already on this inbox" read the placeholder INBOX the
  // restore path paints first, returned, and let the click's real mailbox land
  // last. activateAccount aborts whatever is in flight, so the later call is
  // the one that wins — as long as it is actually made.
  const activateInbox = useCallback(
    (accountId) => activateAccount(accountId, 'INBOX'),
    [activateAccount],
  );
  const setViewMode = useUiStore(s => s.setViewMode);
  const retryKeychainAccess = useAccountStore(s => s.retryKeychainAccess);
  const unreadPerAccount = useSettingsStore(s => s.unreadPerAccount);
  const transferHoverEnabled = useSettingsStore(s => s.transferHoverEnabled);

  // Only the local cache lagging the mailbox is real, user-visible progress.
  // This used to read `emails.length / totalEmails` — the store window, which
  // legitimately drops to a first-window paint on every account switch, so the
  // count fell back and climbed again and looked like a reload each time.
  const cacheFilling = totalEmails > 0 && cachedCount > 0 && cachedCount < totalEmails;

  const { theme, toggleTheme } = useThemeStore();
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const displayNames = useSettingsStore(s => s.displayNames);
  const accountColors = useSettingsStore(s => s.accountColors);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const sidebarCollapsed = useSettingsStore(s => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useSettingsStore(s => s.toggleSidebarCollapsed);
  const sidebarStyle = useSettingsStore(s => s.sidebarStyle);
  const sidebarLayout = useSettingsStore(s => s.sidebarLayout) || 'stacked';
  const accountOrder = useSettingsStore(s => s.accountOrder);

  const storedExpanded = useSettingsStore(s => s.expandedFolders);
  const setStoredExpanded = useSettingsStore(s => s.setExpandedFolders);

  const [showErrorModal, setShowErrorModal] = useState(false);
  const [showError, setShowError] = useState(false);
  const [folderQuery, setFolderQuery] = useState('');
  const [chooserPosition, setChooserPosition] = useState(null);
  const accountTriggerRef = useRef(null);

  // Account hover bubble: today/month transfer stats, shown after a short delay
  const [hoverAccountId, setHoverAccountId] = useState(null);
  const [hoverStats, setHoverStats] = useState(null);
  const [hoverPos, setHoverPos] = useState(null);
  const hoverTimerRef = useRef(null);
  const hoverCloseTimerRef = useRef(null);
  const hoverRowRefs = useRef({});

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }, []);

  // Cancels a pending dismissal — this is what lets the pointer cross the gap
  // between the row and the bubble without the bubble unmounting underneath it.
  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  }, []);

  const handleAccountHoverEnd = useCallback(() => {
    clearHoverTimer();
    cancelHoverClose();
    setHoverAccountId(null);
    setHoverStats(null);
    setHoverPos(null);
  }, [clearHoverTimer, cancelHoverClose]);

  /** Leaving the row only schedules the close; entering the bubble cancels it. */
  const scheduleHoverClose = useCallback(() => {
    clearHoverTimer();
    cancelHoverClose();
    hoverCloseTimerRef.current = setTimeout(handleAccountHoverEnd, HOVER_CLOSE_MS);
  }, [clearHoverTimer, cancelHoverClose, handleAccountHoverEnd]);

  const handleAccountHoverStart = useCallback((accountId) => {
    clearHoverTimer();
    cancelHoverClose();
    if (!transferHoverEnabled) return;
    hoverTimerRef.current = setTimeout(async () => {
      const el = hoverRowRefs.current[accountId];
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - HOVER_BUBBLE_HEIGHT));
      setHoverPos({ top, left: rect.right + 8 });
      setHoverAccountId(accountId);

      const cached = transferStatsHoverCache.get(accountId);
      if (cached && Date.now() - cached.ts < HOVER_CACHE_MS) {
        setHoverStats(cached.data);
        return;
      }
      setHoverStats(null); // show "Loading..." while the fetch is in flight
      try {
        const res = await api.getTransferStats(accountId);
        const data = res?.accounts?.[accountId] || null;
        transferStatsHoverCache.set(accountId, { data, ts: Date.now() });
        setHoverStats(data);
      } catch (e) {
        console.warn('[Sidebar] transfer stats fetch failed:', e);
      }
    }, HOVER_DELAY_MS);
  }, [clearHoverTimer, cancelHoverClose, transferHoverEnabled]);

  // Timers outlive the component otherwise — a close firing after unmount is a
  // setState on a dead tree.
  useEffect(() => () => { clearHoverTimer(); cancelHoverClose(); }, [clearHoverTimer, cancelHoverClose]);

  const openHoveredAccountUsage = useCallback(() => {
    if (hoverAccountId) onOpenDataUsage?.(hoverAccountId);
    handleAccountHoverEnd();
  }, [hoverAccountId, onOpenDataUsage, handleAccountHoverEnd]);

  // Delay showing connection errors by 3 seconds — transient errors on launch resolve quickly
  useEffect(() => {
    setShowError(false);
    if (connectionStatus === 'error') {
      const timer = setTimeout(() => setShowError(true), 3000);
      return () => clearTimeout(timer);
    }
  }, [connectionStatus, activeAccountId]);

  const unifiedInbox = useAccountStore(s => s.unifiedInbox);
  const setUnifiedInbox = useAccountStore(s => s.setUnifiedInbox);

  useEffect(() => { setFolderQuery(''); }, [activeAccountId, unifiedInbox]);
  useEffect(() => { setChooserPosition(null); }, [sidebarLayout, sidebarCollapsed, activeAccountId, unifiedInbox]);

  const orderedAccounts = useMemo(
    () => getOrderedAccounts(accounts).filter(a => !hiddenAccounts[a.id]),
    [accounts, hiddenAccounts, getOrderedAccounts, accountOrder]
  );
  const collapsed = sidebarCollapsed;
  const showUnifiedInbox = orderedAccounts.length >= 2;
  const tagCloud = sidebarStyle === 'tagcloud';
  const Folders = tagCloud ? FolderBubbles : FolderTree;
  const activeAccount = orderedAccounts.find(a => a.id === activeAccountId);

  const folderTree = useMemo(() => buildMailboxTree(mailboxes), [mailboxes]);

  // Whatever was open last time, plus every folder that has to be open for the
  // one being read to be on screen — a hit opened from search can be five
  // levels down inside four collapsed parents.
  const expandedFolders = useMemo(() => {
    const set = new Set(storedExpanded[activeAccountId] || []);
    for (const p of mailboxAncestors(activeMailbox, folderTree)) set.add(p);
    return set;
  }, [storedExpanded, activeAccountId, activeMailbox, folderTree]);

  const toggleFolder = (path) => {
    const next = new Set(expandedFolders);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setStoredExpanded(activeAccountId, next);
  };

  // A folder with folders under it lists the whole branch; a leaf is an
  // ordinary folder and takes the ordinary path. The decision itself lives in
  // openFolder, because a remembered folder has to be restored the same way.
  const selectFolder = (path) => openFolder(activeAccountId, path);

  // ── Folder operations ──
  // `folderMenu` = { node, x, y }; `nameDialog` = { mode, node }; `confirmDelete`
  // = the node whose permanent delete still needs a yes.
  const [folderMenu, setFolderMenu] = useState(null);
  const [nameDialog, setNameDialog] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  /** Every folder op reports through the app's one error toast. */
  const runFolderOp = async (op, notice) => {
    try {
      await op();
      if (notice) useMailStore.setState({ error: notice, errorType: 'success', errorTypeFor: notice });
    } catch (e) {
      useMailStore.setState({ error: e?.message || String(e) });
    }
  };

  const submitFolderName = (name) => {
    const dialog = nameDialog;
    setNameDialog(null);
    if (!dialog) return;
    runFolderOp(() => (dialog.mode === 'rename'
      ? useMailStore.getState().renameFolder(dialog.node.path, name)
      : useMailStore.getState().createFolder(dialog.node?.path || null, name)));
  };

  const deleteFolder = (node, { permanent } = {}) => {
    // A move into Trash is reversible from Trash; a real DELETE is not, so only
    // that one stops for a confirmation.
    if (permanent) { setConfirmDelete(node); return; }
    runFolderOp(
      () => useMailStore.getState().deleteFolder(node.path),
      t('sidebar.folderMovedToTrash', { name: mailboxLabel(node.name) }),
    );
  };

  const folderOpsUi = (
    <>
      <FolderContextMenu
        menu={folderMenu}
        mailboxes={mailboxes}
        onClose={() => setFolderMenu(null)}
        onNewSubfolder={(node) => setNameDialog({ mode: 'create', node })}
        onRename={(node) => setNameDialog({ mode: 'rename', node })}
        onDelete={deleteFolder}
      />
      <FolderNameDialog
        open={!!nameDialog}
        title={t(nameDialog?.mode === 'rename' ? 'sidebar.folderRenameTitle' : 'sidebar.folderCreateTitle')}
        initial={nameDialog?.mode === 'rename' ? mailboxLabel(nameDialog.node.name) : ''}
        confirmLabel={t(nameDialog?.mode === 'rename' ? 'common.rename' : 'common.create')}
        onSubmit={submitFolderName}
        onClose={() => setNameDialog(null)}
      />
      <Dialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        role="alertdialog"
        size="sm"
        title={t('sidebar.deleteFolderForever')}
        description={confirmDelete
          ? t('sidebar.deleteFolderConfirm', { name: mailboxLabel(confirmDelete.name) })
          : null}
        footer={
          <>
            <Button variant="secondary" fullWidth onClick={() => setConfirmDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              fullWidth
              data-testid="confirm-delete-folder"
              onClick={() => {
                const node = confirmDelete;
                setConfirmDelete(null);
                runFolderOp(() => useMailStore.getState().deleteFolder(node.path));
              }}
            >
              {t('common.delete')}
            </Button>
          </>
        }
      />
    </>
  );

  const onFolderContextMenu = (node, at) => setFolderMenu({ node, ...at });

  // Shared hover bubble (rendered in both collapsed and expanded views)
  const hoverBubble = hoverAccountId && hoverPos && (
    <TransferStatsHoverBubble
      pos={hoverPos}
      stats={hoverStats}
      onClick={openHoveredAccountUsage}
      onMouseEnter={cancelHoverClose}
      onMouseLeave={scheduleHoverClose}
    />
  );

  // Recovery details stay out of navigation, but every existing repair remains available.
  const errorModal = (
    <Dialog
      open={Boolean(showErrorModal && activeAccount)}
      onClose={() => setShowErrorModal(false)}
      size="sm"
      title={t('sidebar.accountConnection')}
      description={activeAccount?.email}
    >
      {connectionError && <p className="text-sm text-mail-text-muted whitespace-pre-wrap break-words">{connectionError}</p>}
      {connectionErrorType === 'passwordMissing' && (
        <Button variant="secondary" size="sm" onClick={retryKeychainAccess}>
          <RefreshCw size={14} />{t('common.retry')}
        </Button>
      )}
      {activeAccount?.authType !== 'oauth2' && ['passwordMissing', 'oauthExpired', 'serverError'].includes(connectionErrorType) && (
        <div className="pt-3 border-t border-mail-border">
          <p className="text-xs text-mail-text-muted mb-2">{t('sidebar.switchedProviders')}</p>
          <Button variant="secondary" size="sm" title={t('sidebar.repointAccount')}
            onClick={() => { setShowErrorModal(false); useSettingsStore.getState().openChangeServer(activeAccount.id); }}>
            {t('sidebar.changeServer')}
          </Button>
        </div>
      )}
      {connectionErrorType === 'outlookOAuth' && (
        <button
          onClick={async () => {
            const url = 'https://mailvaultapp.com/faq.html#microsoft-outlook-oauth2';
            if (window.__TAURI__) {
              const { open } = await import('@tauri-apps/plugin-shell');
              await open(url);
            } else window.open(url, '_blank');
          }}
          className="text-sm text-mail-accent-text hover:underline"
        >{t('sidebar.learnMoreFaq')}</button>
      )}
    </Dialog>
  );

  // --- COLLAPSED SIDEBAR ---
  if (collapsed) {
    return (
      <div className="w-14 h-full bg-mail-surface border-r border-mail-border flex flex-col items-center relative">
        {/* Expand button */}
        <div data-tauri-drag-region className="w-full py-3 flex justify-center border-b border-mail-border flex-shrink-0">
          <Button variant="ghost" icon size="md"
            onClick={toggleSidebarCollapsed}
            title={t('sidebar.expandSidebar')}
          >
            <PanelLeftOpen size={18} className="text-mail-text-muted" />
          </Button>
        </div>

        {/* Compose */}
        <div className="w-full py-2 flex justify-center border-b border-mail-border shrink-0">
          <button
            onClick={onCompose}
            className="p-2.5 bg-mail-accent-fill hover:bg-mail-accent-hover text-white rounded-lg transition-colors"
            title={t('sidebar.compose')}
          >
            <PenSquare size={16} />
          </button>
        </div>

        {/* All Inboxes (collapsed) */}
        {showUnifiedInbox && (
          <div className="w-full py-2 border-b border-mail-border flex justify-center shrink-0">
            <button
              data-testid="all-inboxes-btn"
              onClick={() => setUnifiedInbox(true)}
              className={`p-2 rounded-lg transition-all
                         ${unifiedInbox
                           ? 'bg-mail-accent/10 text-mail-accent-text'
                           : 'text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover'}`}
              title={t('sidebar.allInboxes')}
            >
              <Inbox size={16} />
            </button>
          </div>
        )}

        {/* Account icons */}
        <div className="w-full py-2 border-b border-mail-border flex flex-col items-center gap-1 flex-1 min-h-0 overflow-y-auto">
          {orderedAccounts.map(account => (
            <div
              key={account.id}
              ref={el => { hoverRowRefs.current[account.id] = el; }}
              onMouseEnter={() => handleAccountHoverStart(account.id)}
              onMouseLeave={scheduleHoverClose}
            >
              <CollapsedAccountButton
                account={account}
                label={displayNames[account.id] || account.name || account.email}
                isActive={account.id === activeAccountId}
                color={getAccountColor(accountColors, account)}
                initial={getAccountInitial(account, displayNames[account.id])}
                unifiedInbox={unifiedInbox}
                connectionStatus={connectionStatus}
                unreadCount={unreadPerAccount[account.id] || 0}
                onActivateInbox={() => activateInbox(account.id)}
                onActivate={() => {
                  const lastMailbox = useSettingsStore.getState().getLastMailbox(account.id);
                  openFolder(account.id, lastMailbox || 'INBOX');
                }}
                onOpenBackup={onOpenBackup}
              />
            </div>
          ))}
          {orderedAccounts.length === 0 && (
            <button
              data-testid="add-account-btn"
              onClick={onAddAccount}
              className="p-1.5 hover:bg-mail-surface-hover rounded-lg transition-all"
              title={t('sidebar.addAccount')}
            >
              <Plus size={16} className="text-mail-text-muted" />
            </button>
          )}
        </div>

        {/* Folder icons with expandable children — hidden in unified inbox mode */}
        {unifiedInbox && <UnifiedFolderList compact />}
        {!unifiedInbox && <div className="flex-1 min-h-0 overflow-y-auto w-full py-2 text-sm">
          <FolderTree
            compact
            mailboxes={mailboxes}
            activeMailbox={activeMailbox}
            expanded={expandedFolders}
            onToggle={toggleFolder}
            onSelect={selectFolder}
            counts={folderStatus?.[activeAccountId]}
            onContextMenu={onFolderContextMenu}
          />
        </div>}

        {/* Footer icons */}
        <div className="w-full py-2 border-t border-mail-border flex flex-col items-center gap-0.5 shrink-0">
          <Button variant="ghost" icon size="sm"
            onClick={toggleTheme}
            title={theme === 'dark' ? t('sidebar.switchLightMode') : t('sidebar.switchDarkMode')}
          >
            {theme === 'dark' ? (
              <Sun size={15} className="text-mail-text-muted" />
            ) : (
              <Moon size={15} className="text-mail-text-muted" />
            )}
          </Button>
          <Button variant="ghost" icon size="sm"
            onClick={refreshCurrentView}
            title={t('sidebar.refreshEmails')}
          >
            <RefreshCw size={15} className={`text-mail-text-muted ${loading || loadingMore || manualRefreshSpinning ? 'animate-spin' : ''}`} />
          </Button>
          {/* Backup in progress indicator (collapsed) */}
          <CollapsedBackupIcon onOpenBackup={onOpenBackup} />
          <Button variant="ghost" icon size="sm"
            onClick={onOpenSettings}
            data-testid="open-settings"
            title={t('sidebar.settings')}
          >
            <Settings size={15} className="text-mail-text-muted" />
          </Button>
          <FocusTimerButton collapsed onUpgrade={() => onOpenSettings('billing')} />
          <Button variant="ghost" icon size="sm"
            onClick={onReportBug}
            title={t('sidebar.reportABug')}
          >
            <Bug size={15} className="text-mail-text-muted" />
          </Button>
          <Button variant="ghost" icon size="sm"
            onClick={onReferFriend}
            title={t('sidebar.referAFriend')}
          >
            <Gift size={15} className="text-mail-text-muted" />
          </Button>
          {totalEmails > 0 && (
            <div
              className="p-2"
              title={cacheFilling
                ? t('sidebar.emailsDownloaded', { cachedCount: cachedCount.toLocaleString(), totalEmails: totalEmails.toLocaleString() })
                : t('sidebar.emails', { totalEmails: totalEmails.toLocaleString() })}
            >
              {(loading || cacheFilling) ? (
                <RefreshCw size={14} className="animate-spin text-mail-accent-text" />
              ) : (
                <HardDrive size={14} className="text-mail-text-muted" />
              )}
            </div>
          )}
        </div>

        {errorModal}
        {hoverBubble}
        {folderOpsUi}
      </div>
    );
  }

  // --- EXPANDED SIDEBAR ---
  const closeChooser = () => setChooserPosition(null);
  const openChooser = () => {
    handleAccountHoverEnd();
    const rect = accountTriggerRef.current.getBoundingClientRect();
    // Keep the selected account as the visual anchor; shared Popover clamps
    // the complete panel if a short window cannot fit it underneath.
    accountTriggerRef.current.focus();
    setChooserPosition({ left: rect.left, top: rect.bottom + 6, width: Math.max(280, rect.width) });
  };
  const useSwitcher = sidebarLayout === 'switcher';
  const renderUnifiedRow = (chooser = false) => showUnifiedInbox && (
    <button type="button" data-account-choice data-testid="all-inboxes-btn" aria-current={unifiedInbox ? 'true' : undefined}
      className={`sidebar-account-row sidebar-unified-row ${unifiedInbox ? 'sidebar-account-selected' : ''}`}
      onClick={() => { if (chooser) closeChooser(); setUnifiedInbox(true); }}>
      <span className="sidebar-unified-icon"><Inbox size={17} /></span>
      <span>{t('sidebar.allInboxes')}</span>
    </button>
  );
  const renderAccount = (account, chooser = false) => (
    <div key={account.id}
      ref={el => { if (!chooser) hoverRowRefs.current[account.id] = el; }}
      onMouseEnter={chooser ? undefined : () => handleAccountHoverStart(account.id)}
      onMouseLeave={chooser ? undefined : scheduleHoverClose}>
      <ExpandedAccountRow account={account} label={displayNames[account.id] || account.name || account.email}
        isActive={account.id === activeAccountId} color={getAccountColor(accountColors, account)}
        initial={getAccountInitial(account, displayNames[account.id])} unifiedInbox={unifiedInbox}
        connectionStatus={connectionStatus} unreadCount={unreadPerAccount[account.id] || 0}
        onActivateInbox={() => { if (chooser) closeChooser(); activateInbox(account.id); }}
        onActivate={() => {
          if (chooser) closeChooser();
          const lastMailbox = useSettingsStore.getState().getLastMailbox(account.id);
          openFolder(account.id, lastMailbox || 'INBOX');
        }}
        onOpenBackup={id => { if (chooser) closeChooser(); onOpenBackup?.(id); }} />
    </div>
  );
  const renderAccountNotice = account => account && <>
    {suspectEmptyServerData?.accountId === account.id && (
      <div data-testid="cached-data-banner" className="sidebar-connection-notice">
        <p role="status"><AlertTriangle size={13} aria-hidden="true" /><span>{t('sidebar.showingCachedData')}</span></p>
        <p className="sidebar-cache-explanation">{suspectEmptyServerData.message}</p>
        <Button variant="link" size="xs" onClick={refreshCurrentView} title={t('sidebar.retryConnection')}>{t('common.retry')}</Button>
      </div>
    )}
    {showError && connectionStatus === 'error' && (
      <ConnectionErrorCard account={account} connectionErrorType={connectionErrorType}
        activeMailbox={activeMailbox} activateAccount={activateAccount}
        setShowErrorModal={setShowErrorModal} onOpenAccounts={onOpenAccounts} />
    )}
  </>;
  const selectedAccountLabel = unifiedInbox ? t('sidebar.allInboxes')
    : activeAccount ? displayNames[activeAccount.id] || activeAccount.name || activeAccount.email : t('sidebar.addAccount');

  return (
    <div className="mail-sidebar w-64 h-full bg-mail-surface border-r border-mail-border flex flex-col relative">
      <div data-tauri-drag-region data-testid="sidebar-header" className="sidebar-header">
        <h1 className="sidebar-brand font-display font-bold">
          <span className="text-mail-accent-text">{t('sidebar.mail')}</span><span>{t('sidebar.vault')}</span>
        </h1>
        <div className="sidebar-header-tools">
          <Button variant="ghost" icon size="sm" onClick={refreshCurrentView} title={t('sidebar.refreshEmails')}>
            <RefreshCw size={16} className={loading || loadingMore || manualRefreshSpinning ? 'animate-spin' : ''} />
          </Button>
          <Button variant="ghost" icon size="sm" onClick={onOpenSettings} title={t('sidebar.settings')} aria-label={t('sidebar.settings')} data-testid="open-settings">
            <Settings size={16} />
          </Button>
          <Button variant="ghost" icon size="sm" onClick={toggleSidebarCollapsed} title={t('sidebar.collapseSidebar')}>
            <PanelLeftClose size={16} />
          </Button>
        </div>
      </div>

      {/* Compose Button */}
      <div className="px-3 pt-3 pb-2">
        <button
          onClick={onCompose}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                     bg-mail-accent-fill hover:bg-mail-accent-hover text-white
                     font-medium rounded-lg transition-colors"
        >
          <PenSquare size={18} />
          {t('sidebar.compose')}
        </button>
      </div>

      <div className="sidebar-navigation-scroll" data-sidebar-layout={sidebarLayout}>
        <section className={`sidebar-account-section ${useSwitcher ? 'sidebar-switcher-section' : ''}`} aria-label={t('workspace.accounts')}>
          {useSwitcher ? <>
            <div className="sidebar-section-heading"><h2>{t('workspace.accounts')}</h2>
              <Button variant="accentTint" icon size="xs" onClick={onAddAccount} title={t('sidebar.addAccount')} aria-label={t('sidebar.addAccount')}><Plus size={14} /></Button>
            </div>
            <button type="button" ref={accountTriggerRef} className="sidebar-account-switcher"
              aria-label={`${t('sidebar.switchAccount')}: ${selectedAccountLabel}`}
              aria-haspopup="dialog" aria-expanded={!!chooserPosition}
              onClick={chooserPosition ? closeChooser : openChooser}
              onDoubleClick={() => { if (activeAccount && !unifiedInbox) activateInbox(activeAccount.id); }}>
              {unifiedInbox ? <span className="sidebar-unified-icon"><Inbox size={17} /></span>
                : activeAccount ? <span className="sidebar-account-avatar" style={{ backgroundColor: getAccountColor(accountColors, activeAccount) }} aria-hidden="true">
                  {getAccountInitial(activeAccount, displayNames[activeAccount.id])}
                </span> : <Plus size={17} />}
              <span className="sidebar-account-label"><span className="sidebar-account-name">{selectedAccountLabel}</span>
                {!unifiedInbox && activeAccount && selectedAccountLabel !== activeAccount.email && <span className="sidebar-account-address">{activeAccount.email}</span>}
              </span>
              {!unifiedInbox && activeAccount && unreadPerAccount[activeAccount.id] > 0 && <span className="sidebar-unread-count">{unreadPerAccount[activeAccount.id] > 99 ? '99+' : unreadPerAccount[activeAccount.id]}</span>}
              {!unifiedInbox && activeAccount && connectionStatus !== 'connected' && (connectionStatus === 'error'
                ? <AlertCircle size={14} className="text-mail-warning shrink-0" aria-label={t('sidebar.connectionProblem')} />
                : <Loader size={13} className="text-mail-text-muted animate-spin shrink-0" aria-label={t('sidebar.connecting')} />)}
              <ChevronDown size={15} className="shrink-0 text-mail-text-muted" aria-hidden="true" />
            </button>
            {!unifiedInbox && renderAccountNotice(activeAccount)}
            <BackupIndicator onOpenBackup={onOpenBackup} />
          </> : <>
            <div className="sidebar-section-heading">
              <h2>{t('workspace.accounts')}</h2>
              <Button variant="accentTint" icon size="xs" onClick={onAddAccount} title={t('sidebar.addAccount')} aria-label={t('sidebar.addAccount')}><Plus size={14} /></Button>
            </div>
            <div className="sidebar-account-list" data-testid="sidebar-account-list">
              {renderUnifiedRow()}
              {orderedAccounts.map(account => <React.Fragment key={account.id}>
                {renderAccount(account)}
                {account.id === activeAccountId && renderAccountNotice(account)}
              </React.Fragment>)}
              {orderedAccounts.length === 0 && <Button variant="ghost" fullWidth className="justify-start" size="sm" onClick={onAddAccount} data-testid="add-account-btn"><Plus size={16} />{t('sidebar.addAccount')}</Button>}
              <BackupIndicator onOpenBackup={onOpenBackup} />
            </div>
          </>}
        </section>

        <section className="sidebar-folder-section" aria-label={t('sidebar.folders')}>
          <div className="sidebar-section-heading">
            <h2>{t('sidebar.folders')}</h2>
            {!unifiedInbox && <Button variant="ghost" icon size="xs" data-testid="new-folder-btn" aria-label={t('sidebar.newFolder')} title={t('sidebar.newFolder')} onClick={() => setNameDialog({ mode: 'create', node: null })}><Plus size={14} /></Button>}
          </div>
          <div className="sidebar-source-filter" role="group" aria-label={t('sidebar.mailSource')}>
            {[
              { id: 'all', icon: Layers, label: t('sidebar.allMail') },
              { id: 'server', icon: Cloud, label: t('sidebar.viewServer') },
              { id: 'local', icon: HardDrive, label: t('sidebar.viewVault') },
            ].map(mode => (
              <button key={mode.id} type="button" onClick={() => setViewMode(mode.id)} aria-pressed={viewMode === mode.id}
                title={t(`workspace.sourceHint.${mode.id}`)}>
                <mode.icon size={13} aria-hidden="true" /><span>{mode.label}</span>
              </button>
            ))}
          </div>
          {!unifiedInbox && (mailboxes.length >= 10 || folderQuery) && <label className="sidebar-find-field">
            <Search size={14} aria-hidden="true" />
            <input type="search" value={folderQuery} onChange={event => setFolderQuery(event.target.value)}
              aria-label={t('sidebar.findFolder')} placeholder={t('sidebar.findFolder')} />
          </label>}
          <div className="sidebar-folder-list" data-testid="sidebar-folder-list">
            {unifiedInbox ? <UnifiedFolderList tagCloud={tagCloud} /> : (
              <Folders mailboxes={mailboxes} activeMailbox={activeMailbox} expanded={expandedFolders}
                onToggle={toggleFolder} onSelect={selectFolder} counts={folderStatus?.[activeAccountId]}
                onContextMenu={onFolderContextMenu} searchQuery={folderQuery} />
            )}
          </div>
        </section>
      </div>
      {chooserPosition && useSwitcher && <AccountChooser position={chooserPosition} onClose={closeChooser}
        accounts={orderedAccounts.map(account => ({ account, label: displayNames[account.id] || account.name || account.email }))}
        renderAccount={renderAccount} unifiedRow={renderUnifiedRow(true)} onAddAccount={onAddAccount} />}

      <div className="sidebar-footer">
        <div className="sidebar-footer-tools">
          <div className="flex-1 min-w-0"><FocusTimerButton onUpgrade={() => onOpenSettings('billing')} /></div>
          <Button variant="ghost" icon size="sm" onClick={onReportBug} title={t('sidebar.reportABug')} aria-label={t('sidebar.reportABug')}><Bug size={14} /></Button>
          <Button variant="ghost" icon size="sm" onClick={onReferFriend} title={t('sidebar.referAFriend')} aria-label={t('sidebar.referAFriend')}><Gift size={14} /></Button>
        </div>
        <div className="sidebar-footer-meta">
          <div className="min-w-0">
            {totalEmails > 0 && <div className="sidebar-mail-count">
              <HardDrive size={12} />
              <span>{cacheFilling
                ? t('sidebar.emailsDownloaded', { cachedCount: cachedCount.toLocaleString(), totalEmails: totalEmails.toLocaleString() })
                : t('sidebar.emails', { totalEmails: totalEmails.toLocaleString() })}</span>
              {(loading || cacheFilling) && <RefreshCw size={10} className="animate-spin text-mail-accent-text" />}
            </div>}
            <div className="sidebar-version">{t('sidebar.mailvaultVersion', { version })}</div>
          </div>
          <Button variant="ghost" icon size="sm" onClick={toggleTheme}
            title={theme === 'dark' ? t('sidebar.switchLightMode') : t('sidebar.switchDarkMode')}>
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </Button>
        </div>
      </div>

      {errorModal}
      {hoverBubble}
      {folderOpsUi}
    </div>
  );
}
