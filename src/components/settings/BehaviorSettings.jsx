import { Button } from '../ui/Button';
import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { ToggleSwitch } from './ToggleSwitch';
import { DefaultMailApp } from './DefaultMailApp';
import { RefreshCw, SendHorizontal, Eye, Search, Clock, Filter } from 'lucide-react';
import { t, useT  } from '../../i18n/index.js';

export function BehaviorSettings() {
  const t = useT();
  const {
    refreshInterval,
    setRefreshInterval,
    refreshOnLaunch,
    setRefreshOnLaunch,
    lastRefreshTime,
    markAsReadMode,
    setMarkAsReadMode,
    markAsReadDelay,
    setMarkAsReadDelay,
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
    sendDelay,
    setSendDelay,
  } = useSettingsStore();

  return (
    <>
      <DefaultMailApp />

      {/* Email Sync (Behavior) */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
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
                {t('settings.behavior.checkNewEmailsWhenApp')}
              </div>
            </div>
            <ToggleSwitch
              active={refreshOnLaunch}
              onClick={() => setRefreshOnLaunch(!refreshOnLaunch)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-mail-text mb-2">
              {t('settings.behavior.autoRefreshInterval')}
            </label>
            <select
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(parseInt(e.target.value))}
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
          </div>

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

      {/* Sending */}
      <div data-testid="settings-undo-send" className="bg-mail-surface border border-mail-border rounded-xl p-5">
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
              {t('settings.behavior.delayOutgoingEmailsSoCan')}
            </div>
            <select
              value={sendDelay ?? 0}
              onChange={(e) => setSendDelay(Number(e.target.value))}
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
            </select>
            {(sendDelay ?? 0) > 0 && (
              <p className="mt-2 text-xs text-mail-warning flex items-center gap-1.5">
                <span>⚠</span>
                {t('settings.behavior.computerMustStayAwakeDuring')}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Mark as Read */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
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
            <select
              value={markAsReadMode}
              onChange={(e) => setMarkAsReadMode(e.target.value)}
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
              <input
                type="range"
                min="1"
                max="10"
                step="1"
                value={markAsReadDelay}
                onChange={(e) => setMarkAsReadDelay(parseInt(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between mt-1 px-1">
                <span className="text-[10px] text-mail-text-muted">{t('settings.behavior.secs1')}</span>
                <span className="text-[10px] text-mail-text-muted">{t('settings.behavior.secs5')}</span>
                <span className="text-[10px] text-mail-text-muted">{t('settings.behavior.secs10')}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Search Settings */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
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
              <span className="text-[10px] text-mail-text-muted">{t('settings.behavior.month1')}</span>
              <span className="text-[10px] text-mail-text-muted">{t('settings.behavior.months6')}</span>
              <span className="text-[10px] text-mail-text-muted">{t('settings.behavior.year1')}</span>
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
                <div className="text-sm text-mail-text">{t('settings.behavior.searchHistory')}</div>
                <div className="text-xs text-mail-text-muted">
                  {t('settings.behavior.savedSearches', { count: searchHistory.length })}
                </div>
              </div>
            </div>
            <Button variant="ghost" size="sm" className="hover:bg-mail-border"
              onClick={clearSearchHistory}
              disabled={searchHistory.length === 0}
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
                  {t('settings.behavior.filterUsesTracked', { count: filterUsageHistory.length })}
                </div>
              </div>
            </div>
            <Button variant="ghost" size="sm" className="hover:bg-mail-border"
              onClick={clearFilterHistory}
              disabled={filterUsageHistory.length === 0}
            >
              {t('common.clear')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
