// Settings > Mail preferences > Behavior as a view: sync, attachments, sending, marking read,
// swipes, deleting and search history.
//
// `values`: the settings by key (`refreshOnLaunch`, `refreshInterval`, `lastRefreshTime`,
// `autoDownloadAttachments`, `attachmentReminder`, `sendDelay`, `markAsReadMode`, `markAsReadDelay`,
// `trackpadSwipeEnabled`, `swipeLeftAction`, `swipeRightAction`, `confirmBeforeDelete`,
// `afterDeleteSelect`, `afterDeleteSameAccount`, `closeToTray`, `searchHistoryLimit`,
// `filterHistoryPeriodDays`, `topFiltersLimit`); `onChange(key, value)` sets one.
// `rows`: the optional parts this app has (`closeToTray`, `refreshInterval`, `search`).
// `swipeActions`: `[{ value, labelKey }]` a swipe can do; `afterDeleteModes`: what can open after a
// delete; `sameAccountApplies`: whether that choice picks a row (so "same account" means something);
// `attachmentReminderLocked`: the reminder is Premium here and this account has none.
// Search history: `searchHistoryCount`, `filterUsageCount`, `onClearSearchHistory`,
// `onClearFilterHistory`. Desktop-only blocks come in as nodes: `defaultMailApp`, `composeOpenMode`,
// `updateTrack`. `copy`: a row's text in the app's own
// words where desktop's names a computer part (`refreshOnLaunchHint`, `autoDownloadHint`,
// `swipeLabel`, `swipeHint`); `sendDelayWarning: false` drops the "stay awake" warning.
import React from 'react';
import { RefreshCw, SendHorizontal, Eye, Search, Clock, Filter, Paperclip, Trash2, MoveHorizontal, Lock } from 'lucide-react';
import { Button } from '../../ui/Button';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { SettingRow } from '../../ui/SettingRow';
import { AfterDeletePreviewView } from './PreviewViews';
import { useT } from './viewContext';

const AFTER_DELETE_HINTS = {
  none: 'settings.behavior.afterDeleteNothingHint',
  next: 'settings.behavior.afterDeleteNextHint',
  previous: 'settings.behavior.afterDeletePreviousHint',
  nextUnread: 'settings.behavior.afterDeleteUnreadHint',
  previousUnread: 'settings.behavior.afterDeleteUnreadHint',
};
export const AFTER_DELETE_MODES = ['none', 'next', 'previous', 'nextUnread', 'previousUnread'];
/** The send delays offered, in seconds. */
const SEND_DELAYS = [0, 15, 30, 60, 120, 180, 240, 300];
export const BEHAVIOR_ROWS = ['closeToTray', 'refreshInterval', 'search'];

export function BehaviorView({ values, onChange, rows = BEHAVIOR_ROWS, swipeActions, afterDeleteModes = AFTER_DELETE_MODES,
  sameAccountApplies, attachmentReminderLocked = false, searchHistoryCount = 0, filterUsageCount = 0,
  onClearSearchHistory, onClearFilterHistory, defaultMailApp = null, composeOpenMode = null, updateTrack = null,
  copy = {}, sendDelayWarning = true }) {
  const t = useT();
  const shown = new Set(rows);
  const {
    refreshInterval, refreshOnLaunch, lastRefreshTime, markAsReadMode, markAsReadDelay, confirmBeforeDelete,
    afterDeleteSelect, afterDeleteSameAccount, trackpadSwipeEnabled, swipeLeftAction, swipeRightAction,
    autoDownloadAttachments, attachmentReminder, searchHistoryLimit, filterHistoryPeriodDays, topFiltersLimit,
    sendDelay, closeToTray,
  } = values;

  return (
    <>
      {defaultMailApp}

      {/* Windows/Linux: the close button quits unless this is on. On macOS
          closing the window never quits, so there is nothing to choose. */}
      {shown.has('closeToTray') && (
        <div className="settings-section">
          <SettingRow label={t('settings.behavior.closeToTray')} description={t('settings.behavior.closeToTrayDesc')}>
            <ToggleSwitch
              label={t('settings.behavior.closeToTray')} active={!!closeToTray}
              onClick={() => onChange('closeToTray', !closeToTray)}
              testId="toggle-close-to-tray"
            />
          </SettingRow>
        </div>
      )}

      {/* Email Sync (Behavior) */}
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <RefreshCw size={18} className="text-mail-accent-text" />
          {t('settings.behavior.emailSync')}
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.behavior.automaticallyCheckNewEmailsRegular')}
        </p>

        <div className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="font-medium text-mail-text">{t('settings.behavior.refreshAppLaunch')}</div>
              <div className="text-sm text-mail-text-muted">
                {copy.refreshOnLaunchHint ?? t('settings.behavior.checkNewEmailsWhenApp')}
              </div>
            </div>
            <ToggleSwitch
              label={t('settings.behavior.refreshAppLaunch')} active={refreshOnLaunch}
              onClick={() => onChange('refreshOnLaunch', !refreshOnLaunch)}
            />
          </div>

          {shown.has('refreshInterval') && <div>
            <label className="block text-sm font-medium text-mail-text mb-2">
              {t('settings.behavior.autoRefreshInterval')}
            </label>
            <select aria-label={t('settings.behavior.autoRefreshInterval')}
              value={refreshInterval}
              onChange={(e) => onChange('refreshInterval', parseInt(e.target.value))}
              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                        text-mail-text focus:border-mail-accent transition-all
                        cursor-pointer"
            >
              <option value={0}>{t('settings.behavior.never')}</option>
              <option value={1}>{t('settings.behavior.everyMinute')}</option>
              <option value={5}>{t('settings.behavior.every5Minutes')}</option>
              <option value={15}>{t('settings.behavior.every15Minutes')}</option>
              <option value={30}>{t('settings.behavior.every30Minutes')}</option>
              <option value={60}>{t('settings.behavior.everyHour')}</option>
              <option value={120}>{t('settings.behavior.every2Hours')}</option>
              <option value={360}>{t('settings.behavior.every6Hours')}</option>
              <option value={720}>{t('settings.behavior.every12Hours')}</option>
              <option value={1440}>{t('settings.behavior.every24Hours')}</option>
            </select>
          </div>}

          {lastRefreshTime && (
            <div className="flex items-center gap-2 p-3 bg-mail-bg rounded-lg text-sm text-mail-text-muted">
              <RefreshCw size={14} />
              <span>
                {t('settings.behavior.lastRefreshed')} {(() => {
                  const diff = Date.now() - lastRefreshTime;
                  const minutes = Math.floor(diff / 60000);
                  if (minutes < 1) return t('util.emailParser.justNow');
                  if (minutes === 1) return t('settings.behavior.oneMinuteAgo');
                  if (minutes < 60) return t('settings.behavior.minutesAgo', { minutes });
                  const hours = Math.floor(minutes / 60);
                  if (hours === 1) return t('settings.behavior.oneHourAgo');
                  if (hours < 24) return t('settings.behavior.hoursAgo', { hours });
                  const days = Math.floor(hours / 24);
                  if (days === 1) return t('settings.behavior.oneDayAgo');
                  return t('settings.behavior.daysAgo', { days });
                })()}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Attachments */}
      <div data-testid="settings-attachments" className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Paperclip size={18} className="text-mail-accent-text" />
          {t('email.original.attachments')}
        </h4>
        <div className="flex items-center justify-between py-2">
          <div>
            <div className="font-medium text-mail-text">{t('settings.behavior.autoDownloadAttachments')}</div>
            <div className="text-sm text-mail-text-muted">
              {copy.autoDownloadHint ?? t('settings.behavior.autoDownloadAttachmentsDesc')}
            </div>
          </div>
          <ToggleSwitch
            label={t('settings.behavior.autoDownloadAttachments')} active={autoDownloadAttachments}
            onClick={() => onChange('autoDownloadAttachments', !autoDownloadAttachments)}
            testId="toggle-auto-download-attachments"
          />
        </div>
        <div className="flex items-center justify-between py-2">
          <div>
            <div className="font-medium text-mail-text">{t('settings.behavior.attachmentReminder')}</div>
            <div className="text-sm text-mail-text-muted">
              {t('settings.behavior.attachmentReminderDesc')}
            </div>
          </div>
          {!attachmentReminderLocked ? (
            <ToggleSwitch
              label={t('settings.behavior.attachmentReminder')} active={attachmentReminder !== false}
              onClick={() => onChange('attachmentReminder', attachmentReminder === false)}
              testId="toggle-attachment-reminder"
            />
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-mail-text-muted shrink-0">
              <Lock size={13} />
              {t('common.premium')}
            </div>
          )}
        </div>
      </div>

      {composeOpenMode}

      {/* Sending */}
      <div data-testid="settings-undo-send" className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <SendHorizontal size={18} className="text-mail-accent-text" />
          {t('settings.behavior.sending')}
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.behavior.configureSendBehaviorUndoOptions')}
        </p>

        <div className="space-y-4">
          <div>
            <label className="block font-medium text-mail-text mb-1">{t('settings.behavior.sendDelay')}</label>
            <div className="text-sm text-mail-text-muted mb-3">
              {copy.sendDelayHint ?? t('settings.behavior.delayOutgoingEmailsSoCan')}
            </div>
            <select aria-label={t('settings.behavior.sendDelay')}
              value={sendDelay ?? 0}
              onChange={(e) => onChange('sendDelay', Number(e.target.value))}
              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                        text-mail-text focus:border-mail-accent transition-all cursor-pointer"
            >
              <option value={0}>{t('settings.behavior.offSendImmediately')}</option>
              <option value={15}>{t('settings.behavior.seconds15')}</option>
              <option value={30}>{t('settings.behavior.seconds30')}</option>
              <option value={60}>{t('settings.behavior.minute1')}</option>
              <option value={120}>{t('settings.behavior.minutes2')}</option>
              <option value={180}>{t('settings.behavior.minutes3')}</option>
              <option value={240}>{t('settings.behavior.minutes4')}</option>
              <option value={300}>{t('settings.behavior.minutes5')}</option>
              {/* A delay stored elsewhere (an older phone choice) stays listed. */}
              {!SEND_DELAYS.includes(sendDelay ?? 0) && <option value={sendDelay}>{t('common.secondCount', { count: sendDelay })}</option>}
            </select>
            {sendDelayWarning && (sendDelay ?? 0) > 0 && (
              <p className="mt-2 text-xs text-mail-warning flex items-center gap-1.5">
                <span>⚠</span>
                {t('settings.behavior.computerMustStayAwakeDuring')}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Mark as Read */}
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Eye size={18} className="text-mail-accent-text" />
          {t('settings.behavior.markRead')}
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.behavior.chooseWhenOpenedEmailsMarked')}
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-mail-text mb-2">
              {t('settings.behavior.markEmailsRead')}
            </label>
            <select aria-label={t('settings.behavior.markEmailsRead')}
              value={markAsReadMode}
              onChange={(e) => onChange('markAsReadMode', e.target.value)}
              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                        text-mail-text focus:border-mail-accent transition-all
                        cursor-pointer"
            >
              <option value="delay">{t('settings.behavior.afterShortDelay')}</option>
              <option value="auto">{t('settings.behavior.immediatelyWhenOpened')}</option>
              <option value="manual">{t('settings.behavior.manuallyOnly')}</option>
            </select>
            <p className="text-xs text-mail-text-muted mt-1">
              {markAsReadMode === 'delay'
                ? t('settings.behavior.emailsMarkedReadAfterSeconds', { markAsReadDelay })
                : markAsReadMode === 'auto'
                ? t('settings.behavior.emailsMarkedReadInstantlyWhen')
                : t('settings.behavior.useMarkReadButtonMark')}
            </p>
          </div>

          {markAsReadMode === 'delay' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-mail-text">
                  {t('settings.behavior.delayBeforeMarkingRead')}
                </label>
                <span className="text-sm font-medium text-mail-accent-text">
                  {t('common.secondCount', { count: markAsReadDelay })}
                </span>
              </div>
              <input aria-label={t('settings.behavior.delayBeforeMarkingRead')}
                type="range"
                min="1"
                max="10"
                step="1"
                value={markAsReadDelay}
                onChange={(e) => onChange('markAsReadDelay', parseInt(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between mt-1 px-1">
                <span className="text-xs text-mail-text-muted">{t('settings.behavior.secs1')}</span>
                <span className="text-xs text-mail-text-muted">{t('settings.behavior.secs5')}</span>
                <span className="text-xs text-mail-text-muted">{t('settings.behavior.secs10')}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Trackpad swipe */}
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <MoveHorizontal size={18} className="text-mail-accent-text" />
          {t('settings.behavior.swipe.title')}
        </h4>
        <div className="flex items-center justify-between py-2">
          <div>
            <div className="font-medium text-mail-text">{copy.swipeLabel ?? t('settings.behavior.swipe.enabled')}</div>
            <div className="text-sm text-mail-text-muted">{copy.swipeHint ?? t('settings.behavior.swipe.enabledDesc')}</div>
          </div>
          <ToggleSwitch
            label={copy.swipeLabel ?? t('settings.behavior.swipe.enabled')} active={trackpadSwipeEnabled}
            onClick={() => onChange('trackpadSwipeEnabled', !trackpadSwipeEnabled)}
            testId="toggle-trackpad-swipe"
          />
        </div>
        {trackpadSwipeEnabled && ['left', 'right'].map(side => (
          <div key={side} className="mt-4">
            <label className="block text-sm font-medium text-mail-text mb-2">
              {side === 'left' ? t('settings.behavior.swipe.left') : t('settings.behavior.swipe.right')}
            </label>
            <select aria-label={side === 'left' ? t('settings.behavior.swipe.left') : t('settings.behavior.swipe.right')}
              data-testid={`swipe-${side}-select`}
              value={side === 'left' ? swipeLeftAction : swipeRightAction}
              onChange={(e) => onChange(side === 'left' ? 'swipeLeftAction' : 'swipeRightAction', e.target.value)}
              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                        text-mail-text focus:border-mail-accent transition-all
                        cursor-pointer"
            >
              {swipeActions.map(({ value: action, labelKey }) => (
                <option key={action} value={action}>{t(labelKey)}</option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {/* Deleting */}
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Trash2 size={18} className="text-mail-accent-text" />
          {t('settings.behavior.deleting')}
        </h4>

        <div className="mb-6">
          <label className="block text-sm font-medium text-mail-text mb-2">
            {t('settings.behavior.confirmBeforeDelete')}
          </label>
          <select aria-label={t('settings.behavior.confirmBeforeDelete')}
            data-testid="confirm-before-delete-select"
            value={confirmBeforeDelete ? 'ask' : 'skip'}
            onChange={(e) => onChange('confirmBeforeDelete', e.target.value === 'ask')}
            className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                      text-mail-text focus:border-mail-accent transition-all
                      cursor-pointer"
          >
            <option value="ask">{t('settings.behavior.confirmDeleteAsk')}</option>
            <option value="skip">{t('settings.behavior.confirmDeleteSkip')}</option>
          </select>
          <p className="text-xs text-mail-text-muted mt-1">
            {confirmBeforeDelete
              ? t('settings.behavior.confirmDeleteAskHint')
              : t('settings.behavior.confirmDeleteSkipHint')}
          </p>
        </div>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.behavior.chooseWhatOpensAfterDelete')}
        </p>

        <div>
          <label className="block text-sm font-medium text-mail-text mb-2">
            {t('settings.behavior.whenAnEmailIsDeleted')}
          </label>
          <select aria-label={t('settings.behavior.whenAnEmailIsDeleted')}
            data-testid="after-delete-select"
            value={afterDeleteSelect}
            onChange={(e) => onChange('afterDeleteSelect', e.target.value)}
            className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                      text-mail-text focus:border-mail-accent transition-all
                      cursor-pointer"
          >
            {afterDeleteModes.includes('none') && <option value="none">{t('settings.behavior.afterDeleteSelectNothing')}</option>}
            {afterDeleteModes.includes('next') && <option value="next">{t('settings.behavior.afterDeleteSelectNext')}</option>}
            {afterDeleteModes.includes('previous') && <option value="previous">{t('settings.behavior.afterDeleteSelectPrevious')}</option>}
            {afterDeleteModes.includes('nextUnread') && <option value="nextUnread">{t('settings.behavior.afterDeleteSelectNextUnread')}</option>}
            {afterDeleteModes.includes('previousUnread') && <option value="previousUnread">{t('settings.behavior.afterDeleteSelectPreviousUnread')}</option>}
          </select>
          <p className="text-xs text-mail-text-muted mt-1">
            {t(AFTER_DELETE_HINTS[afterDeleteSelect] || AFTER_DELETE_HINTS.none)}
          </p>
          {sameAccountApplies && (
            <SettingRow label={t('settings.behavior.afterDeleteSameAccount')} description={t('settings.behavior.afterDeleteSameAccountDesc')}>
              <ToggleSwitch
                label={t('settings.behavior.afterDeleteSameAccount')} active={!!afterDeleteSameAccount}
                onClick={() => onChange('afterDeleteSameAccount', !afterDeleteSameAccount)}
                testId="after-delete-same-account"
              />
            </SettingRow>
          )}
          <AfterDeletePreviewView value={afterDeleteSelect} />
        </div>
      </div>

      {updateTrack}

      {/* Search Settings */}
      {shown.has('search') && <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Search size={18} className="text-mail-accent-text" />
          {t('settings.behavior.search')}
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.behavior.configureSearchBehaviorHistorySettings')}
        </p>

        <div className="space-y-4">
          {/* Search history limit */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-mail-text">
                {t('settings.behavior.searchHistoryLimit')}
              </label>
              <span className="text-sm font-medium text-mail-accent-text">
                {t('settings.behavior.searchesCount', { count: searchHistoryLimit })}
              </span>
            </div>
            <input aria-label={t('settings.behavior.searchHistoryLimit')}
              type="range"
              min="20"
              max="500"
              step="10"
              value={searchHistoryLimit}
              onChange={(e) => onChange('searchHistoryLimit', parseInt(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between mt-1 px-1">
              <span className="text-xs text-mail-text-muted">20</span>
              <span className="text-xs text-mail-text-muted">250</span>
              <span className="text-xs text-mail-text-muted">500</span>
            </div>
          </div>

          {/* Popular filters period */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-mail-text">
                {t('settings.behavior.popularFiltersPeriod')}
              </label>
              <span className="text-sm font-medium text-mail-accent-text">
                {filterHistoryPeriodDays >= 30 && filterHistoryPeriodDays < 60
                  ? t('settings.behavior.month1')
                  : filterHistoryPeriodDays >= 60 && filterHistoryPeriodDays < 90
                  ? t('settings.behavior.months2')
                  : filterHistoryPeriodDays >= 90 && filterHistoryPeriodDays < 180
                  ? t('settings.behavior.months3')
                  : filterHistoryPeriodDays >= 180 && filterHistoryPeriodDays < 365
                  ? t('settings.behavior.months6')
                  : t('settings.behavior.year1')}
              </span>
            </div>
            <input aria-label={t('settings.behavior.popularFiltersPeriod')}
              type="range"
              min="30"
              max="365"
              step="30"
              value={filterHistoryPeriodDays}
              onChange={(e) => onChange('filterHistoryPeriodDays', parseInt(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between mt-1 px-1">
              <span className="text-xs text-mail-text-muted">{t('settings.behavior.month1')}</span>
              <span className="text-xs text-mail-text-muted">{t('settings.behavior.months6')}</span>
              <span className="text-xs text-mail-text-muted">{t('settings.behavior.year1')}</span>
            </div>
          </div>

          {/* Top filters limit */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-mail-text">
                {t('settings.behavior.numberPopularFiltersShow')}
              </label>
              <span className="text-sm font-medium text-mail-accent-text">
                {t('settings.behavior.filtersCount', { count: topFiltersLimit })}
              </span>
            </div>
            <input aria-label={t('settings.behavior.numberPopularFiltersShow')}
              type="range"
              min="5"
              max="50"
              step="5"
              value={topFiltersLimit}
              onChange={(e) => onChange('topFiltersLimit', parseInt(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between mt-1 px-1">
              <span className="text-xs text-mail-text-muted">5</span>
              <span className="text-xs text-mail-text-muted">25</span>
              <span className="text-xs text-mail-text-muted">50</span>
            </div>
          </div>

          {/* Search history */}
          <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
            <div className="flex items-center gap-2">
              <Clock size={14} className="text-mail-text-muted" />
              <div>
                <div className="text-sm text-mail-text">{t('settings.behavior.searchHistory')}</div>
                <div className="text-xs text-mail-text-muted">
                  {t('settings.behavior.savedSearches', { count: searchHistoryCount })}
                </div>
              </div>
            </div>
            <Button variant="ghost" size="sm" className="hover:bg-mail-border"
              onClick={onClearSearchHistory}
              disabled={searchHistoryCount === 0}
            >
              {t('common.clear')}
            </Button>
          </div>

          {/* Filter usage history */}
          <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
            <div className="flex items-center gap-2">
              <Filter size={14} className="text-mail-text-muted" />
              <div>
                <div className="text-sm text-mail-text">{t('settings.behavior.filterHistory')}</div>
                <div className="text-xs text-mail-text-muted">
                  {t('settings.behavior.filterUsesTracked', { count: filterUsageCount })}
                </div>
              </div>
            </div>
            <Button variant="ghost" size="sm" className="hover:bg-mail-border"
              onClick={onClearFilterHistory}
              disabled={filterUsageCount === 0}
            >
              {t('common.clear')}
            </Button>
          </div>
        </div>
      </div>}
    </>
  );
}
