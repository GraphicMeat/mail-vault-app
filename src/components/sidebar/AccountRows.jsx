import React, { memo } from 'react';
import { AlertCircle, CheckCircle2, Loader } from 'lucide-react';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { useAccountHoverStore } from '../../stores/accountHoverStore';
import { useT } from '../../i18n/index.js';
import { Private } from '../privacy/Private';
import { usePrivateAttr } from '../../hooks/usePrivacy';

export function BackupStatusIcon({ accountId, onClick }) {
  const t = useT();
  const backupState = useSettingsStore(s => s.backupState?.[accountId]);
  const backupGlobalEnabled = useSettingsStore(s => s.backupGlobalEnabled);
  const backupGlobalConfig = useSettingsStore(s => s.backupGlobalConfig);
  const schedule = useSettingsStore(s => s.backupSchedules?.[accountId]);
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const location = useSettingsStore(s => s.sidebarBackupStatusLocation);
  // No premium, no automatic runs — so no schedule health to report.
  if (!hasPremiumAccess(billingProfile)) return null;
  if (!schedule?.enabled && !backupGlobalEnabled) return null;
  if (location === 'hidden') return null;

  const isFailed = backupState?.lastStatus === 'failed';
  const isSuccess = backupState?.lastStatus === 'success';
  // Partial run: the vault got most of it, but something did not arrive.
  const isDegraded = backupState?.lastStatus === 'degraded';
  // Stopped at the daily download limit: healthy, carries on after midnight UTC.
  const isLimitPaused = backupState?.lastStatus === 'limit';
  const lastBackup = backupState?.lastBackupTime || 0;
  const neverBackedUp = lastBackup === 0;

  // Determine if overdue based on configured interval (idle backups don't use nextRunTime)
  const interval = backupGlobalEnabled ? backupGlobalConfig?.interval : schedule?.interval;
  const intervalMs = interval === 'hourly' ? 3600_000 : interval === 'weekly' ? 7 * 24 * 3600_000 : 24 * 3600_000;
  // Give 50% grace period before showing overdue (e.g. daily = 36 hours grace)
  const isOverdue = lastBackup > 0 && (Date.now() - lastBackup) > intervalMs * 1.5;

  // Show a healthy status if the last backup succeeded — even if slightly overdue, it means the backup
  // ran fine and the scheduler just hasn't had a chance to run again yet.
  // Show amber only for failures, never-backed-up, or overdue WITHOUT a success status.
  const showWarning = !isLimitPaused && (isFailed || isDegraded || neverBackedUp || (isOverdue && !isSuccess));

  const icon = showWarning
    ? <AlertCircle size={12} aria-hidden="true" />
    : <CheckCircle2 size={12} aria-hidden="true" />;

  const title = isLimitPaused ? t('sidebar.backupPausedAtDailyLimit')
    : isFailed ? t('sidebar.backupFailedClickView')
    : isDegraded ? t('sidebar.backupIncompleteClickView')
    : neverBackedUp ? t('sidebar.neverBackedUpClickConfigure')
    : isOverdue && !isSuccess ? t('sidebar.backupOverdueClickView')
    : t('sidebar.backupUpDate');

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.(accountId); }}
      onDoubleClick={e => e.stopPropagation()}
      className="sidebar-backup-status hover:opacity-70 transition-opacity"
      data-location={location}
      data-health={showWarning ? 'warning' : 'success'}
      aria-label={title}
      title={title}
    >
      {icon}
    </button>
  );
}

/** Collapsed sidebar: one button per account — memoized so backup badge changes only rerender this row */
export const CollapsedAccountButton = memo(function CollapsedAccountButton({
  account, label, isActive, color, initial, unifiedInbox, connectionStatus,
  unreadCount, onActivate, onActivateInbox, onOpenBackup, insightsOpen = false
}) {
  const t = useT();
  const pa = usePrivateAttr();
  // A list row in a spanning view is pointing at this account.
  const pointed = useAccountHoverStore(s => s.accountId === account.id);
  return (
    <div className="relative">
      <button type="button"
        data-pointed={pointed || undefined}
        className={`relative p-1.5 rounded-lg transition-colors ${isActive && !unifiedInbox && !insightsOpen ? 'bg-mail-accent-tint' : pointed ? 'bg-mail-surface-hover ring-1 ring-mail-accent' : 'hover:bg-mail-surface-hover'}`}
        onClick={onActivate}
        onDoubleClick={onActivateInbox}
        aria-label={label === account.email ? pa(label, 'email') : `${pa(label, 'name')}, ${pa(account.email, 'email')}`}
        aria-current={isActive && !unifiedInbox && !insightsOpen ? 'true' : undefined}
        title={label === account.email ? pa(label, 'email') : `${pa(label, 'name')} - ${pa(account.email, 'email')}`}>
        <span className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold select-none" style={{ backgroundColor: color }}>
          {initial}
        </span>
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-0.5 rounded-full bg-mail-danger-fill flex items-center justify-center">
            <span className="text-[11px] font-bold text-white leading-none">{unreadCount > 99 ? '99+' : unreadCount}</span>
          </span>
        )}
        {isActive && !unifiedInbox && !insightsOpen && (
          <span className={`absolute bottom-1 right-1 w-2.5 h-2.5 rounded-full border-2 border-mail-surface ${connectionStatus === 'connected' ? 'bg-mail-success' : connectionStatus === 'error' ? 'bg-mail-danger' : 'bg-mail-warning'}`}
            title={connectionStatus === 'connected' ? t('settings.accounts.connected') : connectionStatus === 'error' ? t('sidebar.connectionProblem') : t('sidebar.connecting')} />
        )}
      </button>
      <div className="sidebar-collapsed-backup"><BackupStatusIcon accountId={account.id} onClick={onOpenBackup} /></div>
    </div>
  );
});

/** Account identity is the same in both navigation styles. Folder style is independent. */
export const ExpandedAccountRow = memo(function ExpandedAccountRow({
  account, label, isActive, color, initial, unifiedInbox, connectionStatus,
  unreadCount, onActivate, onActivateInbox, onOpenBackup, insightsOpen = false, trailing = null,
}) {
  const t = useT();
  const pa = usePrivateAttr();
  const selected = isActive && !unifiedInbox && !insightsOpen;
  const showAddress = label !== account.email;
  // A list row in a spanning view is pointing at this account.
  const pointed = useAccountHoverStore(s => s.accountId === account.id);
  return (
    <div className={`sidebar-account-row ${selected ? 'sidebar-account-selected' : ''}${pointed ? ' sidebar-account-pointed' : ''}`}>
      <button type="button" className="sidebar-account-open"
        aria-label={showAddress ? `${pa(label, 'name')}, ${pa(account.email, 'email')}` : pa(account.email, 'email')}
        aria-current={selected ? 'true' : undefined}
        title={showAddress ? `${pa(label, 'name')} - ${pa(account.email, 'email')}` : pa(account.email, 'email')}
        onClick={onActivate} onDoubleClick={onActivateInbox}>
        <span className="sidebar-account-avatar" style={{ backgroundColor: color }} aria-hidden="true">{initial}</span>
        <span className="sidebar-account-label">
          <span className="sidebar-account-name"><Private kind="name">{label}</Private></span>
          {showAddress && <span className="sidebar-account-address"><Private kind="email">{account.email}</Private></span>}
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
      {trailing}
    </div>
  );
});

