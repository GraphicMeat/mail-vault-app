import { Button } from '../ui/Button';
import React from 'react';
import { useSettingsStore, SWIPE_ACTIONS, hasPremiumAccess } from '../../stores/settingsStore';
import { DefaultMailApp } from './DefaultMailApp';
import { ComposeOpenMode } from './ComposeOpenMode';
import { Download } from 'lucide-react';
import { SWIPE_ACTION_LABELS } from '../SwipeBackdrop';
import { useT } from '../../i18n/index.js';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
import { afterDeleteRule } from '../../stores/slices/unifiedHelpers';
import { DesktopViewEnv } from './DesktopViewEnv';
import { BehaviorView } from './views/BehaviorView';

const SWIPES = SWIPE_ACTIONS.map(value => ({ value, labelKey: SWIPE_ACTION_LABELS[value] }));

/**
 * Desktop's container: the settings store over BehaviorView, with the parts
 * only a desktop has: the default mail app, close to tray (Windows/Linux),
 * compose's window, the update track and search history.
 */
export function BehaviorSettings() {
  const t = useT();
  const settings = useSettingsStore();
  const {
    setRefreshInterval, setRefreshOnLaunch, setMarkAsReadMode, setMarkAsReadDelay, setConfirmBeforeDelete,
    setAfterDeleteSelect, setAfterDeleteSameAccount, setTrackpadSwipeEnabled, setSwipeAction,
    setAutoDownloadAttachments, setAttachmentReminder, billingProfile, setSearchHistoryLimit, searchHistory,
    clearSearchHistory, setFilterHistoryPeriodDays, setTopFiltersLimit, filterUsageHistory, clearFilterHistory,
    setSendDelay, updateTrack, setUpdateTrack, setCloseToTray, afterDeleteSelect,
  } = settings;
  const SETTERS = {
    refreshInterval: setRefreshInterval, refreshOnLaunch: setRefreshOnLaunch, markAsReadMode: setMarkAsReadMode,
    markAsReadDelay: setMarkAsReadDelay, confirmBeforeDelete: setConfirmBeforeDelete, afterDeleteSelect: setAfterDeleteSelect,
    afterDeleteSameAccount: setAfterDeleteSameAccount, trackpadSwipeEnabled: setTrackpadSwipeEnabled,
    swipeLeftAction: value => setSwipeAction('left', value), swipeRightAction: value => setSwipeAction('right', value),
    autoDownloadAttachments: setAutoDownloadAttachments, attachmentReminder: setAttachmentReminder,
    searchHistoryLimit: setSearchHistoryLimit, filterHistoryPeriodDays: setFilterHistoryPeriodDays,
    topFiltersLimit: setTopFiltersLimit, sendDelay: setSendDelay, closeToTray: setCloseToTray,
  };

  // Sparkle on a macOS Developer ID build, tauri-plugin-updater on Windows.
  // Linux has no nightlies and the App Store build has no updater. Windows has
  // no app menu, so this row is also its only "Check for updates".
  // Read at render, not at import — jsdom has no platform.
  const isWindows = navigator.platform?.startsWith('Win') || navigator.userAgent?.includes('Windows');
  const isMac = navigator.platform?.startsWith('Mac') || navigator.userAgent?.includes('Mac');
  const showUpdateTrack = !IS_APPSTORE_BUILD && (isMac || isWindows);

  // Which build this is decides the track when the user has never chosen one.
  const [isNightlyBuild, setIsNightlyBuild] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const version = await getVersion();
        if (alive) setIsNightlyBuild(version.includes('-nightly'));
      } catch {
        // Web preview: no Tauri, so this is not a nightly.
      }
    })();
    return () => { alive = false; };
  }, []);

  const changeUpdateTrack = async (track) => {
    setUpdateTrack(track);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_update_track', { track });
    } catch (e) {
      // The setting is persisted either way and re-applied at next launch.
      console.warn('Could not apply the update track now:', e);
    }
  };

  // No saved choice means "follow the build" — the same rule Rust applies.
  const effectiveTrack = updateTrack ?? (isNightlyBuild ? 'nightly' : 'stable');

  const checkForUpdatesNow = async () => {
    try {
      if (isWindows) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('check_for_updates_now');
      } else {
        const { checkForUpdates } = await import('tauri-plugin-sparkle-updater-api');
        await checkForUpdates();
      }
    } catch (e) {
      console.warn('Update check failed:', e);
    }
  };

  // Software updates
  const updateTrackSection = showUpdateTrack && (
    <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
      <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
        <Download size={18} className="text-mail-accent-text" />
        {t('settings.behavior.updateTrackTitle')}
      </h4>

      <p className="text-sm text-mail-text-muted mb-4">
        {t('settings.behavior.updateTrackDescription')}
      </p>

      <div>
        <label className="block text-sm font-medium text-mail-text mb-2">
          {t('settings.behavior.updateTrackLabel')}
        </label>
        <select
          data-testid="update-track-select"
          value={effectiveTrack}
          onChange={(e) => changeUpdateTrack(e.target.value)}
          className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                    text-mail-text focus:border-mail-accent transition-all
                    cursor-pointer"
        >
          <option value="stable">{t('settings.behavior.updateTrackStable')}</option>
          <option value="nightly">{t('settings.behavior.updateTrackNightly')}</option>
        </select>
        <p className="text-xs text-mail-text-muted mt-1">
          {effectiveTrack === 'nightly'
            ? t('settings.behavior.updateTrackNightlyHint')
            : t('settings.behavior.updateTrackStableHint')}
        </p>
      </div>

      <div className="mt-4">
        <Button variant="ghost" size="sm" className="hover:bg-mail-border"
          data-testid="update-track-check-now"
          onClick={checkForUpdatesNow}
        >
          {t('settings.behavior.updateTrackCheckNow')}
        </Button>
      </div>
    </div>
  );

  // Windows/Linux: the close button quits unless closeToTray is on. On macOS
  // closing the window never quits, so there is nothing to choose.
  return (
    <DesktopViewEnv>
      <BehaviorView values={settings} onChange={(key, value) => SETTERS[key](value)}
        rows={['refreshInterval', 'search', ...(isMac ? [] : ['closeToTray'])]}
        swipeActions={SWIPES} sameAccountApplies={!!afterDeleteRule(afterDeleteSelect)}
        attachmentReminderLocked={!hasPremiumAccess(billingProfile)}
        searchHistoryCount={searchHistory.length} filterUsageCount={filterUsageHistory.length}
        onClearSearchHistory={clearSearchHistory} onClearFilterHistory={clearFilterHistory}
        defaultMailApp={<DefaultMailApp />} composeOpenMode={<ComposeOpenMode />}
        updateTrack={updateTrackSection} />
    </DesktopViewEnv>
  );
}
