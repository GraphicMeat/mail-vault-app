import { useEffect, useRef } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';

// Tauri invoke for notifications and badge
const invoke = window.__TAURI__?.core?.invoke;

export function useEmailScheduler() {
  const refreshAllAccounts = useMailStore(s => s.refreshAllAccounts);
  const accounts = useMailStore(s => s.accounts);
  const emails = useMailStore(s => s.emails);
  const totalUnreadCount = useMailStore(s => s.totalUnreadCount);
  const {
    refreshInterval,
    refreshOnLaunch,
    setLastRefreshTime,
    notificationSettings,
    badgeEnabled,
    badgeMode
  } = useSettingsStore();

  const intervalRef = useRef(null);
  const hasRefreshedOnLaunch = useRef(false);
  const lastBadgeCount = useRef(-1);

  // Send notification via Tauri
  const sendNotification = async (title, body) => {
    if (!invoke) return;
    try {
      await invoke('send_notification', { title, body });
    } catch (error) {
      console.error('[scheduler] Failed to send notification:', error);
    }
  };

  // Dispatch per-account notifications using shouldNotify + showPreview
  const dispatchNotifications = (perAccountResults) => {
    if (!invoke || !perAccountResults || perAccountResults.length === 0) return;

    const { shouldNotify } = useSettingsStore.getState();
    const { showPreview } = useSettingsStore.getState().notificationSettings;

    for (const result of perAccountResults) {
      const { accountId, accountEmail, folder, newCount, newestSender, newestSubject } = result;

      // Per-account per-folder filtering
      if (!shouldNotify(accountId, folder)) continue;

      if (newCount === 1) {
        // Single new email
        if (showPreview) {
          const sender = newestSender || 'Unknown sender';
          const subject = newestSubject || '(No subject)';
          sendNotification(sender, subject);
        } else {
          sendNotification('New Email', `New email in ${accountEmail}`);
        }
      } else {
        // Multiple new emails
        if (showPreview) {
          const sender = newestSender || 'Unknown sender';
          const subject = newestSubject || '(No subject)';
          sendNotification(
            `${newCount} New Emails`,
            `${sender}: ${subject} (and ${newCount - 1} more)`
          );
        } else {
          sendNotification('New Email', `${newCount} new emails in ${accountEmail}`);
        }
      }
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

    if (count === lastBadgeCount.current) return;
    try {
      await invoke('set_badge_count', { count });
      lastBadgeCount.current = count;
    } catch (error) {
      console.error('[scheduler] Failed to update badge:', error);
    }
  };

  // Refresh function that also updates last refresh time
  const doRefresh = async () => {
    console.log('[scheduler] Starting scheduled refresh...');

    try {
      const result = await refreshAllAccounts();
      setLastRefreshTime(Date.now());
      console.log('[scheduler] Refresh completed:', result);

      // Dispatch per-account notifications (replaces old aggregate notification)
      if (result && result.perAccountResults) {
        dispatchNotifications(result.perAccountResults);
      }

      // Update badge to reflect current mailbox view
      if (result) {
        if (badgeMode === 'unread') {
          const count = useMailStore.getState().emails.filter(e => !e.flags?.includes('\\Seen')).length;
          updateBadge(count);
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

  // Update badge when settings change or unread count changes.
  // Debounced to avoid oscillation during IMAP pagination (emails array changes every page).
  const badgeTimerRef = useRef(null);
  useEffect(() => {
    if (!invoke) return;

    if (!badgeEnabled) {
      updateBadge(0);
      return;
    }

    // Debounce: wait 2s after last change before updating badge.
    // During IMAP sync, emails.length changes every ~1s per page — we want the final stable value.
    if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current);
    badgeTimerRef.current = setTimeout(() => {
      if (badgeMode === 'unread') {
        // Count unread in the current mailbox view — matches what the user sees.
        const count = useMailStore.getState().emails.filter(e => !e.flags?.includes('\\Seen')).length;
        updateBadge(count);
      } else {
        updateBadge(useMailStore.getState().emails.length);
      }
    }, 2000);

    return () => { if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current); };
  }, [badgeEnabled, badgeMode, emails.length, totalUnreadCount]);

  return { doRefresh };
}
