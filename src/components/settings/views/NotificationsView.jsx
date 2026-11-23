// Settings > Mail preferences > Notifications as a view: the switch, the preview and sound, each
// account's switch, folders and quiet hours, the priority senders, and (where the app has them) the
// decision log, backup notifications and the badge.
//
// `enabled`/`onEnabled(next)` (`enabledBusy` while the app asks the system), `showPreview`/
// `onShowPreview(next)`. `sound`: `{ kind: 'choice', value, sounds, onChange, onPreview, previewing,
// previewError }` (desktop's named sounds), `{ kind: 'switch', on, onChange }` (the system's sound,
// on or off), or null. `accounts`: `[{ id, name, color, initial, config: { enabled, folders,
// quietHours }, folderOptions: [{ path, label }] }]`, with `onAccountEnabled(id, next)`,
// `onAccountFolders(id, folders)`, `onAccountQuietHours(id, quietHours)` and `onAccountExpand(id)`
// (an app that loads an account's folders on demand). Priority senders: `importantSenders`
// (`[{ match, throughQuietHours }]`), `onAddSender(match)`, `onRemoveSender(match)`,
// `onSenderThroughQuietHours(match, through)`. Optional sections: `decisionLog` (`{ decisions,
// onRefresh, onClear }`), `backup` (`{ onSuccess, onFailure, setOnSuccess, setOnFailure }`),
// `badge` (`{ enabled, mode, onEnabled, onMode }`). `notice`: shown under the switch (the phone's
// "turned off in the system settings"). `copy`: a row's text in the app's own words where desktop's
// names the desktop or the dock (`enableLabel`, `enableHint`, `soundHint`, `badgeHint`,
// `badgeDescription`, null to leave it out).
import React, { useState } from 'react';
import { Bell, ChevronUp, ChevronDown, HardDrive, Mail, Volume2, Star, History, Trash2 } from 'lucide-react';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { useT, useViewEnv } from './viewContext';

// The decision log's label for each reason the daemon's policy answers
// (src-core/src/notify_policy.rs REASONS), plus notify()'s own fallback.
const REASON_I18N_KEY = {
  'focus-hold': 'notifyPolicy.reason.focusHold',
  'notifications-off': 'notifyPolicy.reason.notificationsOff',
  'priority-allowlist': 'notifyPolicy.reason.priorityAllowlist',
  'quiet-hours': 'notifyPolicy.reason.quietHours',
  'view-muted': 'notifyPolicy.reason.viewMuted',
  'account-muted': 'notifyPolicy.reason.accountMuted',
  'folder-not-watched': 'notifyPolicy.reason.folderNotWatched',
  'delivered-default': 'notifyPolicy.reason.deliveredDefault',
  'already-announced': 'notifyPolicy.reason.alreadyAnnounced',
  'policy-unavailable': 'notifyPolicy.reason.policyUnavailable',
};
const reasonI18nKey = (reason) => REASON_I18N_KEY[reason] || reason;

export const DEFAULT_QUIET_HOURS = { enabled: false, start: '22:00', end: '07:00' };

export function NotificationsView({ enabled, onEnabled, enabledBusy = false, showPreview, onShowPreview, sound = null,
  accounts, onAccountEnabled, onAccountFolders, onAccountQuietHours, onAccountExpand,
  importantSenders, onAddSender, onRemoveSender, onSenderThroughQuietHours,
  decisionLog = null, backup = null, badge = null, notice = null, copy = {} }) {
  const t = useT();
  const { Private, privateAttr } = useViewEnv();
  const [expandedNotifAccounts, setExpandedNotifAccounts] = useState({});
  const [newSender, setNewSender] = useState('');
  const expand = (id) => {
    if (!expandedNotifAccounts[id]) onAccountExpand?.(id);
    setExpandedNotifAccounts(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const addSender = (e) => {
    e.preventDefault();
    if (!newSender.trim()) return;
    onAddSender(newSender.trim());
    setNewSender('');
  };

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
              <div className="font-medium text-mail-text">{copy.enableLabel ?? t('settings.notifications.enableDesktopNotifications')}</div>
              <div className="text-sm text-mail-text-muted">
                {copy.enableHint ?? t('settings.notifications.showDesktopNotificationsNewEmails')}
              </div>
            </div>
            <ToggleSwitch
              label={copy.enableLabel ?? t('settings.notifications.enableDesktopNotifications')} active={enabled}
              disabled={enabledBusy}
              onClick={() => onEnabled(!enabled)}
            />
          </div>
          {notice}

          {enabled && (
            <>
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="font-medium text-mail-text">{t('settings.notifications.showEmailPreview')}</div>
                  <div className="text-sm text-mail-text-muted">
                    {t('settings.notifications.showSenderSubjectNotifications')}
                  </div>
                </div>
                <ToggleSwitch
                  label={t('settings.notifications.showEmailPreview')} active={showPreview}
                  onClick={() => onShowPreview(!showPreview)}
                />
              </div>

              {sound?.kind === 'choice' && (
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
                      value={sound.value}
                      disabled={sound.previewing}
                      onChange={(e) => sound.onChange(e.target.value)}
                      className="min-w-0 flex-1 px-3 py-2 bg-mail-bg border border-mail-border rounded-lg text-sm text-mail-text cursor-pointer disabled:opacity-50"
                    >
                      <option value="none">{t('settings.notifications.soundOff')}</option>
                      {sound.sounds.map(name => <option key={name} value={name}>{name}</option>)}
                    </select>
                    <button
                      type="button"
                      onClick={sound.onPreview}
                      disabled={sound.value === 'none' || sound.previewing}
                      aria-label={t('settings.notifications.previewSound')}
                      aria-busy={sound.previewing}
                      className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-mail-border text-sm text-mail-text hover:bg-mail-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <Volume2 size={16} aria-hidden="true" />
                      {t('settings.notifications.previewSound')}
                    </button>
                  </div>
                  {sound.previewError && (
                    <p role="alert" className="text-sm text-mail-danger mt-2">
                      {t('settings.notifications.soundPreviewFailed')}
                    </p>
                  )}
                </div>
              )}

              {sound?.kind === 'switch' && (
                <div className="flex items-center justify-between py-2">
                  <div>
                    <div className="font-medium text-mail-text">{t('settings.notifications.newEmailSound')}</div>
                    <div className="text-sm text-mail-text-muted">{copy.soundHint ?? t('settings.notifications.newEmailSoundHint')}</div>
                  </div>
                  <ToggleSwitch label={t('settings.notifications.newEmailSound')} active={sound.on} onClick={() => sound.onChange(!sound.on)} />
                </div>
              )}

              {/* Per-account notification settings */}
              <div className="border-t border-mail-border pt-3">
                <div className="text-sm font-medium text-mail-text mb-3">{t('settings.notifications.perAccountSettings')}</div>
                <div className="space-y-1">
                  {accounts.map(account => {
                    const acctConfig = account.config;
                    const isExpanded = expandedNotifAccounts[account.id];
                    const displayName = account.name;

                    return (
                      <div key={account.id} className="rounded-lg border border-mail-border overflow-hidden">
                        <div className="flex items-center gap-3 px-3 py-2.5">
                          {/* Account avatar */}
                          <div
                            className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0"
                            style={{ backgroundColor: account.color }}
                          >
                            {account.initial}
                          </div>

                          {/* Account name + expand toggle */}
                          <button
                            className="flex-1 text-left min-w-0"
                            onClick={() => expand(account.id)}
                          >
                            <div className="text-sm font-medium text-mail-text truncate"><Private kind="name">{displayName}</Private></div>
                          </button>

                          {/* Expand chevron */}
                          {acctConfig.enabled && (
                            <button
                              className="p-1 text-mail-text-muted hover:text-mail-text transition-colors"
                              onClick={() => expand(account.id)}
                              title={t('settings.notifications.configureFolders')}
                            >
                              {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                            </button>
                          )}

                          {/* Account toggle */}
                          <ToggleSwitch
                            label={`${t('settings.notifications.notifications')}: ${privateAttr(displayName, 'name')}`} active={acctConfig.enabled}
                            onClick={() => onAccountEnabled(account.id, !acctConfig.enabled)}
                          />
                        </div>

                        {/* Expanded folder list */}
                        {acctConfig.enabled && isExpanded && (
                          <div className="px-3 pb-3 pt-1 border-t border-mail-border bg-mail-bg/50">
                            <div className="text-xs text-mail-text-muted mb-2">{t('settings.notifications.notifyTheseFolders')}</div>
                            <div className="space-y-1.5">
                              {(account.folderOptions || []).map(({ path: folder, label: folderLabel }) => {
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
                                        onAccountFolders(account.id, newFolders);
                                      }}
                                      className="rounded border-mail-border text-mail-accent-text focus:ring-mail-accent"
                                    />
                                    <span className="text-sm text-mail-text group-hover:text-mail-accent-text transition-colors">
                                      {folderLabel}
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
                                  onClick={() => onAccountQuietHours(account.id, {
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
                                    onChange={(e) => onAccountQuietHours(account.id, { ...acctConfig.quietHours, start: e.target.value })}
                                    className="px-2 py-1 bg-mail-bg border border-mail-border rounded text-sm text-mail-text"
                                  />
                                  <span className="text-xs text-mail-text-muted">{t('common.to')}</span>
                                  <input
                                    type="time"
                                    aria-label={`${t('notifyPolicy.quietHours.title')}: ${t('common.to')}`}
                                    value={acctConfig.quietHours?.end || DEFAULT_QUIET_HOURS.end}
                                    onChange={(e) => onAccountQuietHours(account.id, { ...acctConfig.quietHours, end: e.target.value })}
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
              <span className="text-sm text-mail-text truncate"><Private kind="text">{entry.match}</Private></span>
              <div className="flex items-center gap-3 flex-shrink-0">
                <label className="flex items-center gap-1.5 text-xs text-mail-text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={entry.throughQuietHours !== false}
                    onChange={() => onSenderThroughQuietHours(entry.match, entry.throughQuietHours === false)}
                    className="rounded border-mail-border text-mail-accent-text focus:ring-mail-accent"
                  />
                  {t('notifyPolicy.allowlist.throughQuietHours')}
                </label>
                <button
                  type="button"
                  onClick={() => onRemoveSender(entry.match)}
                  aria-label={`${t('common.remove')}: ${privateAttr(entry.match, 'text')}`}
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
            disabled={!newSender.trim()}
            className="px-3 py-2 rounded-lg border border-mail-border text-sm text-mail-text hover:bg-mail-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('notifyPolicy.allowlist.add')}
          </button>
        </form>
      </div>

      {/* Recent notification decisions */}
      {decisionLog && <div className="settings-section" data-testid="settings-notification-decision-log">
        <div className="flex items-center justify-between mb-4">
          <h4 className="font-semibold text-mail-text flex items-center gap-2">
            <History size={18} className="text-mail-accent-text" />
            {t('notifyPolicy.log.title')}
          </h4>
          <div className="flex items-center gap-3">
            <button type="button" onClick={decisionLog.onRefresh} className="text-xs text-mail-text-muted hover:text-mail-text transition-colors">
              {t('notifyPolicy.log.refresh')}
            </button>
            <button
              type="button"
              onClick={decisionLog.onClear}
              className="text-xs text-mail-text-muted hover:text-mail-danger transition-colors"
            >
              {t('common.clear')}
            </button>
          </div>
        </div>
        <p className="text-sm text-mail-text-muted mb-4">{t('notifyPolicy.log.hint')}</p>

        {decisionLog.decisions.length === 0 ? (
          <p className="text-sm text-mail-text-muted">{t('notifyPolicy.log.empty')}</p>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {decisionLog.decisions.map((d, i) => (
              <div key={i} className="flex items-center justify-between gap-3 py-1.5 text-sm border-b border-mail-border last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="text-mail-text truncate"><Private kind="text">{d.subject}</Private></div>
                  <div className="text-xs text-mail-text-muted truncate"><Private kind="email">{d.from}</Private> · {new Date(d.ts).toLocaleTimeString()}</div>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${d.deliver ? 'text-mail-success bg-mail-success-tint' : 'text-mail-text-muted bg-mail-surface-hover'}`}>
                  {t(reasonI18nKey(d.reason))}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>}

      {/* Backup Notifications */}
      {backup && <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent-text" />
          {t('settings.notifications.backupNotifications')}
        </h4>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">{t('settings.notifications.notifyWhenBackupCompletes')}</span>
            <ToggleSwitch label={t('settings.notifications.notifyWhenBackupCompletes')} active={backup.onSuccess} onClick={() => backup.setOnSuccess(!backup.onSuccess)} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">{t('settings.notifications.notifyWhenBackupFails')}</span>
            <ToggleSwitch label={t('settings.notifications.notifyWhenBackupFails')} active={backup.onFailure} onClick={() => backup.setOnFailure(!backup.onFailure)} />
          </div>
        </div>
      </div>}

      {/* Badge */}
      {badge && <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Mail size={18} className="text-mail-accent-text" />
          {t('settings.notifications.badge')}
        </h4>

        {copy.badgeDescription !== null && <p className="text-sm text-mail-text-muted mb-4">
          {copy.badgeDescription ?? t('settings.notifications.configureDockIconBadgeCounter')}
        </p>}

        <div className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="font-medium text-mail-text">{t('settings.notifications.showBadgeCount')}</div>
              <div className="text-sm text-mail-text-muted">
                {copy.badgeHint ?? t('settings.notifications.displayEmailCountDockIcon')}
              </div>
            </div>
            <ToggleSwitch
              label={t('settings.notifications.showBadgeCount')} active={badge.enabled}
              onClick={() => badge.onEnabled(!badge.enabled)}
            />
          </div>

          {badge.enabled && (
            <div>
              <label className="block text-sm font-medium text-mail-text mb-2">
                {t('settings.notifications.badgeShows')}
              </label>
              <select aria-label={t('settings.notifications.badgeShows')}
                value={badge.mode}
                onChange={(e) => badge.onMode(e.target.value)}
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
      </div>}
    </>
  );
}
