import { useEffect, useRef } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';

// Tauri invoke for notifications and badge
const invoke = window.__TAURI__?.tauri?.invoke || window.__TAURI__?.invoke;

export function useEmailScheduler() {
  const { refreshAllAccounts, accounts, emails, totalUnreadCount } = useMailStore();
  const {
    refreshInterval,
    refreshOnLaunch,
    setLastRefreshTime,
    notificationsEnabled,
    badgeEnabled,
    badgeMode
  } = useSettingsStore();

  const intervalRef = useRef(null);
  const hasRefreshedOnLaunch = useRef(false);
  const previousEmailCount = useRef(0);

  // Send notification
  const sendNotification = async (title, body) => {
    if (!invoke || !notificationsEnabled) return;
    try {
      await invoke('send_notification', { title, body });
    } catch (error) {
      console.error('[scheduler] Failed to send notification:', error);
    }
  };

  // Update badge count
  const updateBadge = async (count) => {
    if (!invoke) return;

    if (!badgeEnabled) {
      // Clear badge if disabled
      try {
        await invoke('set_badge_count', { count: 0 });
      } catch (error) {
        console.error('[scheduler] Failed to clear badge:', error);
      }
      return;
    }

    try {
      await invoke('set_badge_count', { count });
      console.log('[scheduler] Badge updated to:', count);
    } catch (error) {
      console.error('[scheduler] Failed to update badge:', error);
    }
  };

  // Refresh function that also updates last refresh time
  const doRefresh = async () => {
    console.log('[scheduler] Starting scheduled refresh...');
    const oldEmailCount = previousEmailCount.current;

    try {
      const result = await refreshAllAccounts();
      setLastRefreshTime(Date.now());
      console.log('[scheduler] Refresh completed:', result);

      // Check for new emails and notify
      if (result && result.newEmails > 0 && oldEmailCount > 0) {
        sendNotification(
          'New Email',
          `You have ${result.newEmails} new email${result.newEmails > 1 ? 's' : ''}`
        );
      }

      // Update previous count
      previousEmailCount.current = useMailStore.getState().emails.length;

      // Update badge with total unread count across all accounts
      if (result) {
        if (badgeMode === 'unread') {
          updateBadge(result.totalUnread);
        } else {
          updateBadge(useMailStore.getState().emails.length);
        }
      }
    } catch (error) {
      console.error('[scheduler] Refresh failed:', error);
    }
  };

  // Handle refresh on launch
  useEffect(() => {
    if (refreshOnLaunch && accounts.length > 0 && !hasRefreshedOnLaunch.current) {
      hasRefreshedOnLaunch.current = true;
      console.log('[scheduler] Refreshing on launch...');
      doRefresh();
    }
  }, [refreshOnLaunch, accounts.length]);

  // Set up interval for periodic refresh
  useEffect(() => {
    // Clear existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // Don't set interval if disabled (0) or no accounts
    if (refreshInterval <= 0 || accounts.length === 0) {
      console.log('[scheduler] Auto-refresh disabled or no accounts');
      return;
    }

    const intervalMs = refreshInterval * 60 * 1000;
    console.log(`[scheduler] Setting up refresh interval: ${refreshInterval} minutes`);

    intervalRef.current = setInterval(() => {
      console.log('[scheduler] Interval triggered');
      doRefresh();
    }, intervalMs);

    // Cleanup on unmount or when interval changes
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [refreshInterval, accounts.length]);

  // Update badge when settings change or emails change
  useEffect(() => {
    if (!invoke) return;

    if (badgeEnabled) {
      if (badgeMode === 'unread') {
        // Use totalUnreadCount from store (includes all accounts)
        const unreadCount = totalUnreadCount ||
          useMailStore.getState().emails.filter(e => !e.flags?.includes('\\Seen')).length;
        updateBadge(unreadCount);
      } else {
        updateBadge(useMailStore.getState().emails.length);
      }
    } else {
      updateBadge(0);
    }
  }, [badgeEnabled, badgeMode, emails.length, totalUnreadCount]);

  // Also update badge when emails are marked as read
  useEffect(() => {
    if (!invoke || !badgeEnabled || badgeMode !== 'unread') return;

    const currentEmails = useMailStore.getState().emails;
    const unreadCount = currentEmails.filter(e => !e.flags?.includes('\\Seen')).length;
    updateBadge(unreadCount);
  }, [emails]);

  return { doRefresh };
}
