import React, { useState, useEffect } from 'react';
import { useSettingsStore, getAccountInitial, getAccountColor } from '../../stores/settingsStore';
import { getNotificationDecisions, clearNotificationDecisions } from '../../stores/focusStore';
import { reasonI18nKey } from '../../utils/notificationPolicy.js';
import { ToggleSwitch } from '../ui/ToggleSwitch';
import { Bell, ChevronUp, ChevronDown, HardDrive, Mail, Volume2, Star, History, Trash2 } from 'lucide-react';
import { decodeImapUtf7 } from '../../utils/imapUtf7';
import { useT } from '../../i18n/index.js';
import { NOTIFICATION_SOUNDS, normalizeNotificationSound } from '../../utils/notificationSounds';
import { previewNotificationSound } from '../../services/api';

const DEFAULT_QUIET_HOURS = { enabled: false, start: '22:00', end: '07:00' };

export function NotificationSettings({ accounts }) {
  const t = useT();
  const {
    notificationSettings,
    setNotificationEnabled,
    setNotificationShowPreview,
    setNotificationSound,
    setAccountNotificationEnabled,
    setAccountNotificationFolders,
    setAccountQuietHours,
    addImportantSender,
    removeImportantSender,
    setImportantSenderThroughQuietHours,
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
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [newSender, setNewSender] = useState('');
  const [decisions, setDecisions] = useState([]);
  const isMac = typeof navigator !== 'undefined' && navigator.platform?.startsWith('Mac');
  const selectedSound = normalizeNotificationSound(notificationSettings.sound);
  const importantSenders = notificationSettings.importantSenders || [];

  // The log is a plain in-memory ring, not a store — refresh on open and on
  // demand. // ponytail: not live-updating; good enough for a settings panel.
  const refreshDecisions = () => setDecisions(getNotificationDecisions().slice().reverse());
  useEffect(() => { refreshDecisions(); }, []);

  const addSender = (e) => {
    e.preventDefault();
    if (!newSender.trim()) return;
    addImportantSender(newSender.trim());
    setNewSender('');
  };

  const previewSound = async () => {
    setPreviewing(true);
    setPreviewError(false);
    try {
      await previewNotificationSound(selectedSound);
    } catch {
      setPreviewError(true);
    } finally {
      setPreviewing(false);
    }
  };

  const orderedAccounts = getOrderedAccounts(accounts);

  return (
    <>
      {/* Notifications */}
      <div data-testid="settings-notifications" className="settings-section">
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
              label={t('settings.notifications.enableDesktopNotifications')} active={notificationSettings.enabled}
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
                  label={t('settings.notifications.showEmailPreview')} active={notificationSettings.showPreview}
                  onClick={() => setNotificationShowPreview(!notificationSettings.showPreview)}
                />
              </div>

              {isMac && (
                <div className="py-2">
                  <label htmlFor="new-email-sound" className="block font-medium text-mail-text">
                    {t('settings.notifications.newEmailSound')}
                  </label>
                  <p id="new-email-sound-hint" className="text-sm text-mail-text-muted mt-1 mb-3">
                    {t('settings.notifications.newEmailSoundHint')}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      id="new-email-sound"
                      aria-describedby="new-email-sound-hint"
                      value={selectedSound}
                      disabled={previewing}
                      onChange={(e) => {
                        setNotificationSound(e.target.value);
                        setPreviewError(false);
                      }}
                      className="min-w-0 flex-1 px-3 py-2 bg-mail-bg border border-mail-border rounded-lg text-sm text-mail-text cursor-pointer disabled:opacity-50"
                    >
                      <option value="none">{t('settings.notifications.soundOff')}</option>
                      {NOTIFICATION_SOUNDS.map(sound => <option key={sound} value={sound}>{sound}</option>)}
                    </select>
                    <button
                      type="button"
                      onClick={previewSound}
                      disabled={selectedSound === 'none' || previewing}
                      aria-label={t('settings.notifications.previewSound')}
                      aria-busy={previewing}
                      className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-mail-border text-sm text-mail-text hover:bg-mail-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <Volume2 size={16} aria-hidden="true" />
                      {t('settings.notifications.previewSound')}
                    </button>
                  </div>
                  {previewError && (
                    <p role="alert" className="text-sm text-mail-danger mt-2">
                      {t('settings.notifications.soundPreviewFailed')}
                    </p>
                  )}
                </div>
              )}

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
                            label={`${t('settings.notifications.notifications')}: ${displayName}`} active={acctConfig.enabled}
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

                            {/* Per-account quiet hours */}
                            <div className="mt-3 pt-3 border-t border-mail-border">
                              <div className="flex items-center justify-between">
                                <span className="text-xs text-mail-text-muted">{t('notifyPolicy.quietHours.title')}</span>
                                <ToggleSwitch
                                  label={t('notifyPolicy.quietHours.title')}
                                  active={!!acctConfig.quietHours?.enabled}
                                  onClick={() => setAccountQuietHours(account.id, {
                                    ...(acctConfig.quietHours || DEFAULT_QUIET_HOURS),
                                    enabled: !acctConfig.quietHours?.enabled,
                                  })}
                                />
                              </div>
                              {acctConfig.quietHours?.enabled && (
                                <div className="flex items-center gap-2 mt-2">
                                  <span className="text-xs text-mail-text-muted">{t('common.from')}</span>
                                  <input
                                    type="time"
                                    aria-label={`${t('notifyPolicy.quietHours.title')}: ${t('common.from')}`}
                                    value={acctConfig.quietHours?.start || DEFAULT_QUIET_HOURS.start}
                                    onChange={(e) => setAccountQuietHours(account.id, { ...acctConfig.quietHours, start: e.target.value })}
                                    className="px-2 py-1 bg-mail-bg border border-mail-border rounded text-sm text-mail-text"
                                  />
                                  <span className="text-xs text-mail-text-muted">{t('common.to')}</span>
                                  <input
                                    type="time"
                                    aria-label={`${t('notifyPolicy.quietHours.title')}: ${t('common.to')}`}
                                    value={acctConfig.quietHours?.end || DEFAULT_QUIET_HOURS.end}
                                    onChange={(e) => setAccountQuietHours(account.id, { ...acctConfig.quietHours, end: e.target.value })}
                                    className="px-2 py-1 bg-mail-bg border border-mail-border rounded text-sm text-mail-text"
                                  />
                                </div>
                              )}
                              <p className="text-xs text-mail-text-muted mt-1">{t('notifyPolicy.quietHours.hint')}</p>
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

      {/* Priority senders */}
      <div className="settings-section" data-testid="settings-notification-allowlist">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Star size={18} className="text-mail-accent-text" />
          {t('notifyPolicy.allowlist.title')}
        </h4>
        <p className="text-sm text-mail-text-muted mb-4">{t('notifyPolicy.allowlist.hint')}</p>

        <div className="space-y-2">
          {importantSenders.map(entry => (
            <div key={entry.match} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-mail-border">
              <span className="text-sm text-mail-text truncate">{entry.match}</span>
              <div className="flex items-center gap-3 flex-shrink-0">
                <label className="flex items-center gap-1.5 text-xs text-mail-text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={entry.throughQuietHours !== false}
                    onChange={() => setImportantSenderThroughQuietHours(entry.match, entry.throughQuietHours === false)}
                    className="rounded border-mail-border text-mail-accent-text focus:ring-mail-accent"
                  />
                  {t('notifyPolicy.allowlist.throughQuietHours')}
                </label>
                <button
                  type="button"
                  onClick={() => removeImportantSender(entry.match)}
                  aria-label={`${t('common.remove')}: ${entry.match}`}
                  className="text-mail-text-muted hover:text-mail-danger transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
          {importantSenders.length === 0 && (
            <p className="text-sm text-mail-text-muted">{t('notifyPolicy.allowlist.empty')}</p>
          )}
        </div>

        <form className="flex items-center gap-2 mt-3" onSubmit={addSender}>
          <input
            value={newSender}
            onChange={(e) => setNewSender(e.target.value)}
            placeholder={t('notifyPolicy.allowlist.placeholder')}
            aria-label={t('notifyPolicy.allowlist.placeholder')}
            className="flex-1 min-w-0 px-3 py-2 bg-mail-bg border border-mail-border rounded-lg text-sm text-mail-text"
          />
          <button
            type="submit"
            className="px-3 py-2 rounded-lg border border-mail-border text-sm text-mail-text hover:bg-mail-surface-hover transition-colors"
          >
            {t('notifyPolicy.allowlist.add')}
          </button>
        </form>
      </div>

      {/* Recent notification decisions */}
      <div className="settings-section" data-testid="settings-notification-decision-log">
        <div className="flex items-center justify-between mb-4">
          <h4 className="font-semibold text-mail-text flex items-center gap-2">
            <History size={18} className="text-mail-accent-text" />
            {t('notifyPolicy.log.title')}
          </h4>
          <div className="flex items-center gap-3">
            <button type="button" onClick={refreshDecisions} className="text-xs text-mail-text-muted hover:text-mail-text transition-colors">
              {t('notifyPolicy.log.refresh')}
            </button>
            <button
              type="button"
              onClick={() => { clearNotificationDecisions(); refreshDecisions(); }}
              className="text-xs text-mail-text-muted hover:text-mail-danger transition-colors"
            >
              {t('common.clear')}
            </button>
          </div>
        </div>
        <p className="text-sm text-mail-text-muted mb-4">{t('notifyPolicy.log.hint')}</p>

        {decisions.length === 0 ? (
          <p className="text-sm text-mail-text-muted">{t('notifyPolicy.log.empty')}</p>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {decisions.map((d, i) => (
              <div key={i} className="flex items-center justify-between gap-3 py-1.5 text-sm border-b border-mail-border last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="text-mail-text truncate">{d.subject}</div>
                  <div className="text-xs text-mail-text-muted truncate">{d.from} · {new Date(d.ts).toLocaleTimeString()}</div>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${d.deliver ? 'text-mail-success bg-mail-success-tint' : 'text-mail-text-muted bg-mail-surface-hover'}`}>
                  {t(reasonI18nKey(d.reason))}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Backup Notifications */}
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent-text" />
          {t('settings.notifications.backupNotifications')}
        </h4>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">{t('settings.notifications.notifyWhenBackupCompletes')}</span>
            <ToggleSwitch label={t('settings.notifications.notifyWhenBackupCompletes')} active={backupNotifyOnSuccess} onClick={() => setBackupNotifyOnSuccess(!backupNotifyOnSuccess)} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">{t('settings.notifications.notifyWhenBackupFails')}</span>
            <ToggleSwitch label={t('settings.notifications.notifyWhenBackupFails')} active={backupNotifyOnFailure} onClick={() => setBackupNotifyOnFailure(!backupNotifyOnFailure)} />
          </div>
        </div>
      </div>

      {/* Badge */}
      <div className="settings-section">
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
              label={t('settings.notifications.showBadgeCount')} active={badgeEnabled}
              onClick={() => setBadgeEnabled(!badgeEnabled)}
            />
          </div>

          {badgeEnabled && (
            <div>
              <label className="block text-sm font-medium text-mail-text mb-2">
                {t('settings.notifications.badgeShows')}
              </label>
              <select aria-label={t('settings.notifications.badgeShows')}
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
