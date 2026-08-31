import React, { useState, useMemo, useEffect, useCallback, useRef, memo } from 'react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
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
import { motion } from 'framer-motion';
import * as api from '../services/api';
import { formatBytes } from '../utils/formatBytes';
import { mailboxLabel } from '../utils/imapUtf7';
import { lastDaysSeries } from '../utils/transferLimits';
import { t as tr, t, useT   } from '../i18n/index.js';
import { compareNames } from '../utils/collation.js';
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
  Bug,
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
  Gift,
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

const UNIFIED_FOLDERS = () => ([
  { id: 'INBOX', name: tr('sidebar.inbox'), icon: Inbox },
  { id: tr('list.sent'), name: tr('list.sent'), icon: Send, specialUse: '\\Sent' },
  { id: tr('sidebar.drafts'), name: tr('sidebar.drafts'), icon: File, specialUse: '\\Drafts' },
  { id: tr('settings.storage.trash'), name: tr('settings.storage.trash'), icon: Trash2, specialUse: '\\Trash' },
  { id: tr('common.archive'), name: tr('common.archive'), icon: Archive, specialUse: '\\Archive' },
]);

function UnifiedFolderList({ tagCloud = false }) {
  const t = useT();
  const unifiedFolder = useAccountStore(s => s.unifiedFolder);
  const switchUnifiedFolder = useAccountStore(s => s.switchUnifiedFolder);

  if (tagCloud) {
    return (
      <div className="overflow-y-auto p-3 flex-1" style={{ minHeight: 60 }}>
        <div className="text-xs text-mail-text-muted uppercase tracking-wide mb-2">
          {t('sidebar.allAccounts')}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {UNIFIED_FOLDERS().map(folder => {
            const isActive = unifiedFolder === folder.id;
            const Icon = folder.icon;
            return (
              <button
                key={folder.id}
                onClick={() => switchUnifiedFolder(folder.id)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors border
                           ${isActive
                             ? 'bg-mail-accent-fill text-white border-mail-accent'
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
    <div className="overflow-y-auto p-3 flex-1" style={{ minHeight: 60 }}>
      <div className="text-xs text-mail-text-muted uppercase tracking-wide mb-2">
        {t('sidebar.allAccounts')}
      </div>
      {UNIFIED_FOLDERS().map(folder => {
        const isActive = unifiedFolder === folder.id;
        const Icon = folder.icon;
        return (
          <div
            key={folder.id}
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
  account, isActive, color, initial, unifiedInbox, connectionStatus, connectionError,
  unreadCount, onActivate, onOpenBackup
}) {
  const t = useT();
  return (
    // Same active marker as the expanded rail: the identity spine over a 10%
    // wash of the same colour. A ring here was the last box-shadow in the
    // app's own chrome, and it said "active" in a language nothing else
    // in the client speaks. (The email-body iframe keeps its own.)
    <button
      className={`relative p-1.5 rounded-lg transition-colors
                 ${isActive && !unifiedInbox ? '' : 'hover:bg-mail-surface-hover'}`}
      style={isActive && !unifiedInbox
        ? { backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }
        : undefined}
      onClick={onActivate}
      aria-label={account.name || account.email}
      aria-current={isActive && !unifiedInbox ? 'true' : undefined}
      title={account.name || account.email}
    >
      {isActive && !unifiedInbox && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
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
        <div className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-0.5 rounded-full bg-mail-danger-fill flex items-center justify-center">
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
            connectionStatus === 'connected' ? t('settings.accounts.connected') :
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
  const t = useT();
  // The active account is marked by its own identity colour, not by a generic
  // accent: a 3px spine at the rail edge over a 10% wash of the same colour.
  // color-mix keeps one source of truth (the account colour) instead of a
  // second stored tint that could drift out of sync with it.
  return (
    <div
      className={`relative flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all text-mail-text
                 ${isActive && !unifiedInbox ? '' : 'hover:bg-mail-surface-hover'}`}
      style={isActive && !unifiedInbox
        ? { backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }
        : undefined}
      onClick={onActivate}
    >
      {isActive && !unifiedInbox && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-0 bottom-0 w-[3px] rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
      <div className="relative flex-shrink-0">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold select-none"
          style={{ backgroundColor: color }}
        >
          {initial}
        </div>
        {unreadCount > 0 && (
          <div className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-mail-danger-fill flex items-center justify-center">
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
            title={connectionStatus === 'connected' ? t('settings.accounts.connected') :
                   connectionStatus === 'error' ? t('sidebar.offline', { connectionError }) : t('sidebar.connecting')}
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

/** Password-missing / connection-error card with retry + change-server actions.
 * Shared between the tag-cloud (collapsed) and expanded sidebar layouts so
 * both stay in sync (see feedback_virtualized_list_portal-style parity note). */
export const ConnectionErrorCard = memo(function ConnectionErrorCard({
  account, connectionErrorType, activeMailbox, activateAccount,
  retryKeychainAccess, setShowErrorModal, onOpenAccounts, wrapperClassName = 'mt-2',
}) {
  const t = useT();
  return (
    <div className={`${wrapperClassName} p-2 rounded-lg border ${
      connectionErrorType === 'passwordMissing'
        ? 'bg-mail-warning/10 border-mail-warning/20'
        : 'bg-mail-danger/10 border-mail-danger/20'
    }`}>
      {connectionErrorType === 'passwordMissing' ? (
        <div className="text-xs text-mail-warning">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Key size={14} />
              <span>{t('sidebar.passwordMissing')}</span>
            </div>
            <Button variant="ghost" icon size="xs" className="hover:bg-mail-warning/20"
              onClick={retryKeychainAccess}
              title={t('common.retry')}
            >
              <RefreshCw size={12} />
            </Button>
          </div>
          <button
            onClick={() => onOpenAccounts?.(account.id)}
            className="mt-1.5 w-full px-2 py-1 text-xs font-medium bg-mail-warning/20
                       hover:bg-mail-warning/30 rounded transition-colors text-center"
          >
            {t('sidebar.reenterPassword')}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between text-xs text-mail-danger">
          <div className="flex items-center gap-2">
            {connectionErrorType === 'offline' ? (
              <><WifiOff size={14} /><span>{t('sidebar.noInternet')}</span></>
            ) : connectionErrorType === 'outlookOAuth' ? (
              <><ServerOff size={14} /><span>{t('sidebar.microsoftIssue')}</span></>
            ) : connectionErrorType === 'oauthExpired' ? (
              <><Key size={14} /><span>{t('sidebar.oauth2Expired')}</span></>
            ) : connectionErrorType === 'timeout' ? (
              <><RefreshCw size={14} /><span>{t('sidebar.timedOut')}</span></>
            ) : (
              <><ServerOff size={14} /><span>{t('sidebar.serverError')}</span></>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" icon size="xs" className="hover:bg-mail-danger/20"
              onClick={() => setShowErrorModal(true)}
              title={t('sidebar.viewErrorDetails')}
            >
              <Info size={12} />
            </Button>
            <Button variant="ghost" icon size="xs" className="hover:bg-mail-danger/20"
              onClick={() => activateAccount(account.id, activeMailbox)}
              title={t('sidebar.retryConnection')}
            >
              <RefreshCw size={12} />
            </Button>
          </div>
        </div>
      )}
      {account.authType !== 'oauth2' && (connectionErrorType === 'passwordMissing' ||
        connectionErrorType === 'oauthExpired' ||
        connectionErrorType === 'serverError') && (
        <div className="mt-1.5">
          <div className="text-[11px] text-mail-text-muted text-center mb-1">
            {t('sidebar.switchedProviders')}
          </div>
          <button
            onClick={() => useSettingsStore.getState().openChangeServer(account.id)}
            className="w-full px-2 py-1 text-[11px] font-medium text-mail-text-muted
                       hover:text-mail-text hover:bg-mail-surface-hover rounded transition-colors text-center"
            title={t('sidebar.repointAccount')}
          >
            {t('sidebar.changeServer')}
          </button>
        </div>
      )}
    </div>
  );
});

/** Tag-cloud account bubble — compact pill form of ExpandedAccountRow */
const TagCloudAccountBubble = memo(function TagCloudAccountBubble({
  account, isActive, color, initial, unifiedInbox, connectionStatus,
  unreadCount, label, onActivate,
}) {
  const t = useT();
  return (
    <button
      onClick={onActivate}
      title={account.name ? `${account.name} — ${account.email}` : account.email}
      className={`relative inline-flex items-center gap-1.5 pl-0.5 pr-2.5 py-0.5 rounded-full text-xs transition-all border max-w-full min-w-0
                 ${isActive && !unifiedInbox
                   ? 'bg-mail-accent-fill text-white border-mail-accent'
                   : 'text-mail-text border-mail-border hover:bg-mail-surface-hover'}`}
    >
      <span
        className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold select-none flex-shrink-0"
        style={{ backgroundColor: color }}
      >
        {initial}
      </span>
      <span className="truncate min-w-0">{label}</span>
      {unreadCount > 0 && (
        <span className="min-w-[16px] h-4 px-1 rounded-full bg-mail-danger-fill text-[9px] font-bold text-white flex items-center justify-center leading-none">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
      {isActive && !unifiedInbox && (
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0
                     ${connectionStatus === 'connected' ? 'bg-mail-success' :
                       connectionStatus === 'error' ? 'bg-mail-danger' : 'bg-mail-warning'}`}
        />
      )}
    </button>
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
            <span className="flex items-center gap-2 text-[10px] text-mail-text-muted">
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
          <div className="flex gap-1 mt-1 mb-2 text-[10px] text-mail-text-muted">
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

export function Sidebar({ onAddAccount, onCompose, onOpenSettings, onOpenBackup, onOpenAccounts, onOpenDataUsage, onReportBug, onReferFriend }) {
  const t = useT();
  const accounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const mailboxes = useAccountStore(s => s.mailboxes);
  const activeMailbox = useAccountStore(s => s.activeMailbox);
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
  const getDisplayName = useSettingsStore(s => s.getDisplayName);
  const accountColors = useSettingsStore(s => s.accountColors);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const sidebarCollapsed = useSettingsStore(s => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useSettingsStore(s => s.toggleSidebarCollapsed);
  const sidebarStyle = useSettingsStore(s => s.sidebarStyle);
  const accountOrder = useSettingsStore(s => s.accountOrder);
  const sidebarAccountsRatio = useSettingsStore(s => s.sidebarAccountsRatio);
  const setSidebarAccountsRatio = useSettingsStore(s => s.setSidebarAccountsRatio);

  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPremium = hasPremiumAccess(billingProfile);

  const [expandedFolders, setExpandedFolders] = useState(new Set(['INBOX']));
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [showError, setShowError] = useState(false);

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
  const tagCloud = sidebarStyle === 'tagcloud';
  const activeAccount = orderedAccounts.find(a => a.id === activeAccountId);

  // Sort mailboxes: INBOX first, then alphabetically; children sorted alphabetically too
  const sortedMailboxes = useMemo(() => {
    const sorted = [...mailboxes].sort((a, b) => {
      if (a.path === 'INBOX') return -1;
      if (b.path === 'INBOX') return 1;
      return compareNames(a.name, b.name);
    });
    return sorted.map(m => m.children?.length > 0
      ? { ...m, children: [...m.children].sort((a, b) => compareNames(a.name, b.name)) }
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

  // Shared error modal (rendered in both collapsed and expanded views)
  const errorModal = (
        <Dialog
          open={Boolean(showErrorModal && connectionError)}
          onClose={() => setShowErrorModal(false)}
          padded={false}
          aria-label={t('sidebar.errorDetailsLabel')}
          panelClassName="overflow-hidden"
        >
            <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
              <h3 className="text-sm font-semibold text-mail-text">{t('sidebar.errorDetails')}</h3>
              <Button
                variant="ghost"
                icon
                size="xs"
                onClick={() => setShowErrorModal(false)}
                aria-label={t('common.close')}
              >
                <X size={14} />
              </Button>
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
                  className="mt-3 text-sm text-mail-accent-text hover:text-mail-accent-hover transition-colors underline"
                >
                  {t('sidebar.learnMoreFaq')}
                </button>
              )}
            </div>
        </Dialog>
  );

  // --- COLLAPSED SIDEBAR ---
  if (collapsed) {
    return (
      <div className="w-14 h-full bg-mail-surface border-r border-mail-border flex flex-col items-center relative transition-all duration-200">
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
        <div className="w-full py-2 flex justify-center border-b border-mail-border">
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
          <div className="w-full py-2 border-b border-mail-border flex justify-center">
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
        <div className="w-full py-2 border-b border-mail-border flex flex-col items-center gap-1">
          {orderedAccounts.map(account => (
            <div
              key={account.id}
              ref={el => { hoverRowRefs.current[account.id] = el; }}
              onMouseEnter={() => handleAccountHoverStart(account.id)}
              onMouseLeave={scheduleHoverClose}
              onDoubleClick={() => activateInbox(account.id)}
            >
              <CollapsedAccountButton
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
                               ? 'bg-mail-accent/10 text-mail-accent-text'
                               : 'text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover'}`}
                  onClick={() => {
                    if (mailbox.noselect && hasChildren) {
                      toggleFolder(mailbox.path);
                    } else if (!mailbox.noselect) {
                      activateAccount(activeAccountId, mailbox.path);
                      if (hasChildren) toggleFolder(mailbox.path);
                    }
                  }}
                  title={mailboxLabel(mailbox.name)}
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
                                   ? 'bg-mail-accent/10 text-mail-accent-text'
                                   : 'text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover'}`}
                      onClick={() => activateAccount(activeAccountId, child.path)}
                      title={mailboxLabel(child.name)}
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
        <div className="w-full py-2 border-t border-mail-border flex flex-col items-center gap-0.5">
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
      </div>
    );
  }

  // --- EXPANDED SIDEBAR ---
  return (
    <div className="w-64 h-full bg-mail-surface border-r border-mail-border flex flex-col relative transition-all duration-200">
      {/* Logo */}
      <div data-tauri-drag-region className="px-4 py-3 border-b border-mail-border flex items-center justify-between flex-shrink-0">
        <h1 className="text-xl font-display font-bold">
          <span className="text-mail-accent-text">{t('sidebar.mail')}</span>
          <span className="text-mail-text">{t('sidebar.vault')}</span>
        </h1>
        <div className="flex items-center gap-1">
          <Button variant="ghost" icon size="md"
            onClick={toggleTheme}
            title={theme === 'dark' ? t('sidebar.switchLightMode') : t('sidebar.switchDarkMode')}
          >
            {theme === 'dark' ? (
              <Sun size={18} className="text-mail-text-muted" />
            ) : (
              <Moon size={18} className="text-mail-text-muted" />
            )}
          </Button>
          <Button variant="ghost" icon size="md"
            onClick={refreshCurrentView}
            title={t('sidebar.refreshEmails')}
          >
            <RefreshCw size={18} className={`text-mail-text-muted ${loading || loadingMore || manualRefreshSpinning ? 'animate-spin' : ''}`} />
          </Button>
          <Button variant="ghost" icon size="md"
            onClick={toggleSidebarCollapsed}
            title={t('sidebar.collapseSidebar')}
          >
            <PanelLeftClose size={18} className="text-mail-text-muted" />
          </Button>
        </div>
      </div>

      {/* Compose Button */}
      <div className="p-3 border-b border-mail-border">
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

      {/* Account Selector */}
      <div className="p-3 overflow-y-auto flex-shrink-0" style={{ flex: `0 0 ${sidebarAccountsRatio * 100}%`, minHeight: 60, maxHeight: 'calc(100% - 260px)' }}>
        <div className="relative">
          {tagCloud && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {showUnifiedInbox && (
                  <button
                    data-testid="all-inboxes-btn"
                    onClick={() => setUnifiedInbox(true)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors border
                               ${unifiedInbox
                                 ? 'bg-mail-accent-fill text-white border-mail-accent'
                                 : 'text-mail-text border-mail-border hover:bg-mail-surface-hover'}`}
                    title={t('sidebar.allInboxes')}
                  >
                    <Inbox size={12} />
                    <span>{t('sidebar.allInboxes')}</span>
                  </button>
                )}
                {orderedAccounts.map(account => (
                  <div
                    key={account.id}
                    ref={el => { hoverRowRefs.current[account.id] = el; }}
                    onMouseEnter={() => handleAccountHoverStart(account.id)}
                    onMouseLeave={scheduleHoverClose}
                    onDoubleClick={() => activateInbox(account.id)}
                  >
                    <TagCloudAccountBubble
                      account={account}
                      isActive={account.id === activeAccountId}
                      color={getAccountColor(accountColors, account)}
                      initial={getAccountInitial(account, getDisplayName(account.id))}
                      label={getDisplayName(account.id) || account.name || account.email}
                      unifiedInbox={unifiedInbox}
                      connectionStatus={connectionStatus}
                      unreadCount={unreadPerAccount[account.id] || 0}
                      onActivate={() => {
                        const lastMailbox = useSettingsStore.getState().getLastMailbox(account.id);
                        activateAccount(account.id, lastMailbox || 'INBOX');
                      }}
                    />
                  </div>
                ))}
              </div>

              {activeAccount && suspectEmptyServerData?.accountId === activeAccount.id && (
                <div data-testid="cached-data-banner" className="mt-2 p-2 rounded-lg border bg-mail-warning/10 border-mail-warning/20">
                  <div className="flex items-center justify-between text-xs text-mail-warning">
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={14} />
                      <span>{t('sidebar.showingCachedData')}</span>
                    </div>
                    <Button variant="ghost" icon size="xs" className="hover:bg-mail-warning/20"
                      // Not activateAccount: that lands in the sync probe's 10s
                      // "checked moments ago" window and returns without asking
                      // the server anything, which is why this button was
                      // reported as doing nothing. refreshCurrentView clears the
                      // probe first, so an explicit retry always reaches the server.
                      onClick={refreshCurrentView}
                      title={t('sidebar.retryConnection')}
                    >
                      <RefreshCw size={12} />
                    </Button>
                  </div>
                  <p className="mt-1 text-[10px] text-mail-text-muted leading-tight">
                    {suspectEmptyServerData.message}
                  </p>
                </div>
              )}

              {activeAccount && showError && connectionStatus === 'error' && (
                <ConnectionErrorCard
                  account={activeAccount}
                  connectionErrorType={connectionErrorType}
                  activeMailbox={activeMailbox}
                  activateAccount={activateAccount}
                  retryKeychainAccess={retryKeychainAccess}
                  setShowErrorModal={setShowErrorModal}
                  onOpenAccounts={onOpenAccounts}
                  wrapperClassName="mt-2"
                />
              )}
            </>
          )}

          {/* All Inboxes (expanded) */}
          {!tagCloud && showUnifiedInbox && (
            <div
              data-testid="all-inboxes-btn"
              className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all mb-1
                         ${unifiedInbox
                           ? 'bg-mail-accent/10 text-mail-accent-text'
                           : 'hover:bg-mail-surface-hover text-mail-text'}`}
              onClick={() => setUnifiedInbox(true)}
            >
              <div className="w-8 h-8 rounded-full flex items-center justify-center bg-mail-accent/15">
                <Inbox size={16} className={unifiedInbox ? 'text-mail-accent-text' : 'text-mail-text-muted'} />
              </div>
              <div className="text-sm font-medium">{t('sidebar.allInboxes')}</div>
            </div>
          )}

          {!tagCloud && orderedAccounts.map(account => {
            const color = getAccountColor(accountColors, account);
            const initial = getAccountInitial(account, getDisplayName(account.id));
            return (
            <React.Fragment key={account.id}>
              <div
                ref={el => { hoverRowRefs.current[account.id] = el; }}
                onMouseEnter={() => handleAccountHoverStart(account.id)}
                onMouseLeave={scheduleHoverClose}
                onDoubleClick={() => activateInbox(account.id)}
              >
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
              </div>

              {/* Suspect empty data warning — server returned empty but cache had data */}
              {account.id === activeAccountId && suspectEmptyServerData?.accountId === account.id && (
                <div data-testid="cached-data-banner" className="mt-1 mb-1 p-2 rounded-lg border bg-mail-warning/10 border-mail-warning/20">
                  <div className="flex items-center justify-between text-xs text-mail-warning">
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={14} />
                      <span>{t('sidebar.showingCachedData')}</span>
                    </div>
                    <Button variant="ghost" icon size="xs" className="hover:bg-mail-warning/20"
                      // Not activateAccount: that lands in the sync probe's 10s
                      // "checked moments ago" window and returns without asking
                      // the server anything, which is why this button was
                      // reported as doing nothing. refreshCurrentView clears the
                      // probe first, so an explicit retry always reaches the server.
                      onClick={refreshCurrentView}
                      title={t('sidebar.retryConnection')}
                    >
                      <RefreshCw size={12} />
                    </Button>
                  </div>
                  <p className="mt-1 text-[10px] text-mail-text-muted leading-tight">
                    {suspectEmptyServerData.message}
                  </p>
                </div>
              )}

              {/* Inline error banner — shown directly below the account that has the error */}
              {account.id === activeAccountId && showError && connectionStatus === 'error' && (
                <ConnectionErrorCard
                  account={account}
                  connectionErrorType={connectionErrorType}
                  activeMailbox={activeMailbox}
                  activateAccount={activateAccount}
                  retryKeychainAccess={retryKeychainAccess}
                  setShowErrorModal={setShowErrorModal}
                  onOpenAccounts={onOpenAccounts}
                  wrapperClassName="mt-1 mb-1"
                />
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
              {t('sidebar.addAccount')}
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
          const sidebarHeight = sidebar.getBoundingClientRect().height;
          if (sidebarHeight <= 0) return;
          const startY = e.clientY;
          const startRatio = useSettingsStore.getState().sidebarAccountsRatio;
          const prevUserSelect = document.body.style.userSelect;
          document.body.style.userSelect = 'none';

          const handleMouseMove = (moveEvent) => {
            const delta = (moveEvent.clientY - startY) / sidebarHeight;
            setSidebarAccountsRatio(startRatio + delta);
          };
          const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.style.userSelect = prevUserSelect;
          };
          document.addEventListener('mousemove', handleMouseMove);
          document.addEventListener('mouseup', handleMouseUp);
        }}
        title={t('sidebar.dragToResize')}
      />

      {/* View Mode Toggle */}
      <div className="p-3 border-b border-mail-border flex-shrink-0">
        <div className="text-xs text-mail-text-muted uppercase tracking-wide mb-2">
          {t('sidebar.viewMode')}
        </div>
        <div className="flex gap-1 bg-mail-bg rounded-lg p-1">
          {[
            // Labels, not ids: the `local` filter shows exactly what the vault
            // holds, and the product calls that place the vault everywhere
            // else — on the row glyph, in every delete confirmation, on the
            // website. "Local" was the one surface still using another word
            // for it. The id stays `local`; only what the user reads changed.
            { id: 'all', icon: Layers, label: t('sidebar.viewAll') },
            { id: 'server', icon: Cloud, label: t('sidebar.viewServer') },
            { id: 'local', icon: HardDrive, label: t('sidebar.viewVault') }
          ].map(mode => (
            <button
              key={mode.id}
              onClick={() => setViewMode(mode.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2
                         rounded-md text-xs font-medium transition-all
                         ${viewMode === mode.id
                           ? 'bg-mail-accent-fill text-white'
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
        <UnifiedFolderList tagCloud={tagCloud} />
      )}
      {!unifiedInbox && tagCloud && (
        <div className="overflow-y-auto p-3 flex-1" style={{ minHeight: 60 }}>
          <div className="text-xs text-mail-text-muted uppercase tracking-wide mb-2">
            {t('sidebar.folders')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sortedMailboxes.flatMap(mailbox => {
              const bubbles = [];
              if (!mailbox.noselect) {
                const Icon = getMailboxIcon(mailbox);
                const isActive = activeMailbox === mailbox.path;
                bubbles.push(
                  <button
                    key={mailbox.path}
                    onClick={() => activateAccount(activeAccountId, mailbox.path)}
                    title={mailboxLabel(mailbox.name)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors border
                               ${isActive
                                 ? 'bg-mail-accent-fill text-white border-mail-accent'
                                 : 'text-mail-text border-mail-border hover:bg-mail-surface-hover'}`}
                  >
                    <Icon size={12} />
                    <span className="truncate max-w-[140px]">{mailboxLabel(mailbox.name)}</span>
                  </button>
                );
              }
              if (mailbox.children?.length > 0) {
                mailbox.children.forEach(child => {
                  if (child.noselect) return;
                  const ChildIcon = getMailboxIcon(child);
                  const isChildActive = activeMailbox === child.path;
                  bubbles.push(
                    <button
                      key={child.path}
                      onClick={() => activateAccount(activeAccountId, child.path)}
                      title={mailboxLabel(child.name)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors border
                                 ${isChildActive
                                   ? 'bg-mail-accent-fill text-white border-mail-accent'
                                   : 'text-mail-text-muted border-mail-border hover:bg-mail-surface-hover hover:text-mail-text'}`}
                    >
                      <ChildIcon size={12} />
                      <span className="truncate max-w-[140px]">{mailboxLabel(child.name)}</span>
                    </button>
                  );
                });
              }
              return bubbles;
            })}
          </div>
        </div>
      )}
      {!unifiedInbox && !tagCloud && <div className="overflow-y-auto p-3 flex-1" style={{ minHeight: 60 }}>
        <div className="text-xs text-mail-text-muted uppercase tracking-wide mb-2">
          {t('sidebar.folders')}
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
                             ? 'bg-mail-accent/10 text-mail-accent-text'
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
                <span className="text-sm flex-1 truncate">{mailboxLabel(mailbox.name)}</span>
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
                                     ? 'bg-mail-accent/10 text-mail-accent-text'
                                     : 'text-mail-text hover:bg-mail-surface-hover'}`}
                        onClick={() => activateAccount(activeAccountId, child.path)}
                      >
                        <div className="w-5" />
                        <ChildIcon size={14} />
                        <span className="text-sm truncate">{mailboxLabel(child.name)}</span>
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
        <Button variant="ghost" fullWidth size="xs" className="justify-start"
          onClick={onOpenSettings}
          data-testid="open-settings"
        >
          <Settings size={14} />
          {t('sidebar.settings')}
        </Button>
        <Button variant="ghost" fullWidth size="xs" className="justify-start"
          onClick={onReportBug}
          title={t('sidebar.reportABug')}
        >
          <Bug size={14} />
          {t('sidebar.reportABug')}
        </Button>
        <Button variant="ghost" fullWidth size="xs" className="justify-start"
          onClick={onReferFriend}
          title={t('sidebar.referAFriend')}
        >
          <Gift size={14} />
          {t('sidebar.referAFriend')}
        </Button>
        {totalEmails > 0 && (
          <div className="flex items-center gap-1 px-2 mt-1 text-xs text-mail-text-muted">
            <span className="w-3.5 flex justify-center"><HardDrive size={12} /></span>
            {cacheFilling ? (
              <span>{t('sidebar.emailsDownloaded', { cachedCount: cachedCount.toLocaleString(), totalEmails: totalEmails.toLocaleString() })}</span>
            ) : (
              <span>{t('sidebar.emails', { totalEmails: totalEmails.toLocaleString() })}</span>
            )}
            {(loading || cacheFilling) && (
              <RefreshCw size={10} className="animate-spin text-mail-accent-text" />
            )}
          </div>
        )}
        <div className="text-xs text-mail-text-muted text-center mt-2">
          {t('sidebar.mailvaultVersion', { version })}
        </div>
      </div>

      {errorModal}
      {hoverBubble}
    </div>
  );
}
