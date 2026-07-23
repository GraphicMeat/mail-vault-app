import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { ToggleSwitch } from './ToggleSwitch';
import { RefreshCw, SendHorizontal, Eye, Search, Clock, Filter } from 'lucide-react';

export function BehaviorSettings() {
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
      {/* Email Sync (Behavior) */}
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
          <div>
            <label className="block font-medium text-mail-text mb-1">Send Delay</label>
            <div className="text-sm text-mail-text-muted mb-3">
              Delay outgoing emails so you can undo before they're sent. You can override this per-email in the compose window.
            </div>
            <select
              value={sendDelay ?? 0}
              onChange={(e) => setSendDelay(Number(e.target.value))}
              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                        text-mail-text focus:border-mail-accent transition-all cursor-pointer"
            >
              <option value={0}>Off — send immediately</option>
              <option value={15}>15 seconds</option>
              <option value={30}>30 seconds</option>
              <option value={60}>1 minute</option>
              <option value={120}>2 minutes</option>
              <option value={180}>3 minutes</option>
              <option value={240}>4 minutes</option>
              <option value={300}>5 minutes</option>
            </select>
            {(sendDelay ?? 0) > 0 && (
              <p className="mt-2 text-xs text-amber-500 flex items-center gap-1.5">
                <span>⚠</span>
                Your computer must stay awake during the delay. If it sleeps, the email will be sent when it wakes.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Mark as Read */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Eye size={18} className="text-mail-accent" />
          Mark as Read
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          Choose when opened emails are marked as read.
        </p>

        <div className="space-y-4">
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
              <option value="delay">After a short delay</option>
              <option value="auto">Immediately when opened</option>
              <option value="manual">Manually only</option>
            </select>
            <p className="text-xs text-mail-text-muted mt-1">
              {markAsReadMode === 'delay'
                ? `Emails are marked as read after ${markAsReadDelay} seconds of viewing`
                : markAsReadMode === 'auto'
                ? 'Emails are marked as read instantly when you open them'
                : 'Use the Mark as Read button to mark emails as read'}
            </p>
          </div>

          {markAsReadMode === 'delay' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-mail-text">
                  Delay before marking as read
                </label>
                <span className="text-sm font-medium text-mail-accent">
                  {markAsReadDelay} {markAsReadDelay === 1 ? 'second' : 'seconds'}
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
                <span className="text-[10px] text-mail-text-muted">1s</span>
                <span className="text-[10px] text-mail-text-muted">5s</span>
                <span className="text-[10px] text-mail-text-muted">10s</span>
              </div>
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
    </>
  );
}
