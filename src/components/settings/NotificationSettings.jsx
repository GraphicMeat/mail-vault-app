import React, { useState } from 'react';
import { useSettingsStore, getAccountInitial, getAccountColor } from '../../stores/settingsStore';
import { ToggleSwitch } from './ToggleSwitch';
import { Bell, ChevronUp, ChevronDown, HardDrive, Mail } from 'lucide-react';
import { decodeImapUtf7 } from '../../utils/imapUtf7';
import { useT } from '../../i18n/index.js';

export function NotificationSettings({ accounts }) {
  const t = useT();
  const {
    notificationSettings,
    setNotificationEnabled,
    setNotificationShowPreview,
    setAccountNotificationEnabled,
    setAccountNotificationFolders,
    badgeEnabled,
    setBadgeEnabled,
    badgeMode,
    setBadgeMode,
    accountColors,
    isAccountHidden,
    getDisplayName,
    getOrderedAccounts,
    backupNotifyOnSuccess,
    backupNotifyOnFailure,
    setBackupNotifyOnSuccess,
    setBackupNotifyOnFailure,
  } = useSettingsStore();

  const [expandedNotifAccounts, setExpandedNotifAccounts] = useState({});

  const orderedAccounts = getOrderedAccounts(accounts);

  return (
    <>
      {/* Notifications */}
      <div data-testid="settings-notifications" className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Bell size={18} className="text-mail-accent-text" />
          {t('settings.notifications.notifications')}
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.notifications.getNotifiedWhenNewEmails')}
        </p>

        <div className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="font-medium text-mail-text">{t('settings.notifications.enableDesktopNotifications')}</div>
              <div className="text-sm text-mail-text-muted">
                {t('settings.notifications.showDesktopNotificationsNewEmails')}
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
                  <div className="font-medium text-mail-text">{t('settings.notifications.showEmailPreview')}</div>
                  <div className="text-sm text-mail-text-muted">
                    {t('settings.notifications.showSenderSubjectNotifications')}
                  </div>
                </div>
                <ToggleSwitch
                  active={notificationSettings.showPreview}
                  onClick={() => setNotificationShowPreview(!notificationSettings.showPreview)}
                />
              </div>

              {/* Per-account notification settings */}
              <div className="border-t border-mail-border pt-3">
                <div className="text-sm font-medium text-mail-text mb-3">{t('settings.notifications.perAccountSettings')}</div>
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
                              title={t('settings.notifications.configureFolders')}
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
                            <div className="text-xs text-mail-text-muted mb-2">{t('settings.notifications.notifyTheseFolders')}</div>
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
                                      className="rounded border-mail-border text-mail-accent-text focus:ring-mail-accent"
                                    />
                                    <span className="text-sm text-mail-text group-hover:text-mail-accent-text transition-colors">
                                      {decodeImapUtf7(folder)}
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

        </div>
      </div>

      {/* Backup Notifications */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent-text" />
          {t('settings.notifications.backupNotifications')}
        </h4>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">{t('settings.notifications.notifyWhenBackupCompletes')}</span>
            <ToggleSwitch active={backupNotifyOnSuccess} onClick={() => setBackupNotifyOnSuccess(!backupNotifyOnSuccess)} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">{t('settings.notifications.notifyWhenBackupFails')}</span>
            <ToggleSwitch active={backupNotifyOnFailure} onClick={() => setBackupNotifyOnFailure(!backupNotifyOnFailure)} />
          </div>
        </div>
      </div>

      {/* Badge */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Mail size={18} className="text-mail-accent-text" />
          {t('settings.notifications.badge')}
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.notifications.configureDockIconBadgeCounter')}
        </p>

        <div className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="font-medium text-mail-text">{t('settings.notifications.showBadgeCount')}</div>
              <div className="text-sm text-mail-text-muted">
                {t('settings.notifications.displayEmailCountDockIcon')}
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
                {t('settings.notifications.badgeShows')}
              </label>
              <select
                value={badgeMode}
                onChange={(e) => setBadgeMode(e.target.value)}
                className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                          text-mail-text focus:border-mail-accent transition-all
                          cursor-pointer"
              >
                <option value="unread">{t('settings.notifications.unreadMessages')}</option>
                <option value="total">{t('settings.notifications.totalMessages')}</option>
              </select>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
