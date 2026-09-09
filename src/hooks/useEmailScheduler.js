import { useEffect, useRef } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useAccountStore } from '../stores/accountStore';
import { useMessageListStore } from '../stores/messageListStore';
import { useSettingsStore } from '../stores/settingsStore';
import { notify } from '../stores/focusStore';
import * as db from '../services/db';
import { watchAccount, waitForSyncChanges } from '../services/syncService';
import { hasValidCredentials } from '../services/authUtils';
import { isGraphAccount } from '../services/graphConfig';
import { normalizeNotificationSound } from '../utils/notificationSounds';

// Tauri invoke for notifications and badge
const invoke = window.__TAURI__?.core?.invoke;

export function useEmailScheduler() {
  const refreshAllAccounts = useAccountStore(s => s.refreshAllAccounts);
  const accounts = useAccountStore(s => s.accounts);
  const emails = useMessageListStore(s => s.emails);
  const totalUnreadCount = useAccountStore(s => s.totalUnreadCount);
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
  const hasReplayedOps = useRef(false);
  const lastBadgeCount = useRef(-1);

  // Dispatch per-account notifications using shouldNotify + showPreview
  const dispatchNotifications = (perAccountResults) => {
    if (!invoke || !perAccountResults || perAccountResults.length === 0) return;

    const { shouldNotify } = useSettingsStore.getState();
    const { showPreview, sound } = useSettingsStore.getState().notificationSettings;
    const selectedSound = normalizeNotificationSound(sound);
    const notifyEmail = (title, body) => selectedSound === 'none'
      ? notify(title, body)
      : notify(title, body, selectedSound);

    for (const result of perAccountResults) {
      const { accountId, accountEmail, folder, newCount, newestSender, newestSubject } = result;

      // Per-account per-folder filtering
      if (!shouldNotify(accountId, folder)) continue;

      if (newCount === 1) {
        // Single new email
        if (showPreview) {
          const sender = newestSender || 'Unknown sender';
          const subject = newestSubject || '(No subject)';
          notifyEmail(sender, subject);
        } else {
          notifyEmail('New Email', `New email in ${accountEmail}`);
        }
      } else {
        // Multiple new emails
        if (showPreview) {
          const sender = newestSender || 'Unknown sender';
          const subject = newestSubject || '(No subject)';
          notifyEmail(
            `${newCount} New Emails`,
            `${sender}: ${subject} (and ${newCount - 1} more)`
          );
        } else {
          notifyEmail('New Email', `${newCount} new emails in ${accountEmail}`);
        }
      }
    }
  };

  // ── IDLE: register watchers, then follow the daemon's change feed ──
  //
  // The daemon idles each account's INBOX and bumps a generation counter when
  // a wake-up sync found something. One long poll at a time; the reply names
  // the account and the folder, and the app repaints only what is on screen
  // and tells the user about the rest the way a scheduled refresh does.
  //
  // ponytail: one sync.watch round trip per IMAP account per scheduled
  // refresh (doRefresh calls this too). The daemon no-ops an unchanged
  // fingerprint, so this is cheap by design — batch into one RPC if account
  // counts ever make the round-trip count matter.
  const registerWatchers = () => {
    for (const a of useMailStore.getState().accounts) {
      if (!isGraphAccount(a) && hasValidCredentials(a)) watchAccount(a);
    }
  };

  // Re-register when an account appears, disappears, or gets fresh credentials.
  // An OAuth token the daemon never heard about is a watcher that keeps failing
  // to authenticate until the next app launch.
  const watchSignature = accounts
    .map(a => `${a.id}:${a.password ? 1 : 0}:${(a.oauth2AccessToken || '').slice(-8)}`)
    .join('|');
  useEffect(() => { registerWatchers(); }, [watchSignature]);

  // Answers whether the change landed on screen. A folder-subtree view
  // (mailboxScope) lists every folder under its root — spansMailboxes(state)
  // already treats that the same as UNIFIED, so a change to a folder under the
  // open branch (not the root path itself) has to repaint too, not just an
  // exact activeMailbox match. mailboxScope.paths is the branch already
  // enumerated by loadSubtree (root + every descendant), so membership in it
  // is the same check rather than a second copy of the delimiter/startsWith
  // logic.
  const onSyncChange = async ({ accountId, mailbox, newEmails }) => {
    const s = useMailStore.getState();
    const onScreen =
      (s.activeAccountId === accountId && (
        s.activeMailbox === mailbox
        || s.activeMailbox === 'UNIFIED'
        || !!s.mailboxScope?.paths?.includes(mailbox)
      ))
      || (s.unifiedInbox && (s.unifiedFolder || 'INBOX') === mailbox);

    if (newEmails > 0) {
      const account = s.accounts.find(a => a.id === accountId);
      let newest = null;
      // A missing preview is not worth losing the notification over.
      try {
        newest = (await db.getEmailHeadersPartial(accountId, mailbox, 1))?.emails?.[0] || null;
      } catch { /* no preview, still notify */ }
      dispatchNotifications([{
        accountId, accountEmail: account?.email, folder: mailbox, newCount: newEmails,
        newestSender: newest?.from?.name || newest?.from?.address,
        newestSubject: newest?.subject,
      }]);
    }
    return onScreen;
  };

  // Each daemonCall is its own socket connection — the Tauri forwarder connects,
  // authenticates, sends one request and reads one reply — so a parked long poll
  // pins only its own connection. Nothing else needs a dedicated one.
  useEffect(() => {
    let stopped = false;
    let since = 0;
    (async () => {
      while (!stopped) {
        let reply;
        try {
          reply = await waitForSyncChanges(since, 25000);
        } catch (e) {
          // No Tauri means no daemon for the life of this session (the web
          // build) — retrying that is a spin, not a recovery.
          if (stopped || e?.code === 'NO_TAURI') return;
          await new Promise(r => setTimeout(r, e?.code === 'DAEMON_OFFLINE' ? 30000 : 5000));
          continue;
        }
        if (stopped) return;
        // Adopt the generation the daemon reports, even a lower one: its
        // counter restarts at 0 when the daemon does, and it answers a cursor
        // from the future at once with where it actually is.
        since = reply?.gen ?? since;
        // Each iteration awaits a DB read, so an unmount between two changes
        // in the same reply must stop the loop before the next one starts —
        // checking `stopped` only before the loop let a change after the
        // first still fire post-unmount.
        let repaint = false;
        for (const c of reply?.changes || []) {
          if (stopped) break;
          if (await onSyncChange(c)) repaint = true;
        }
        if (stopped) return;
        // One reload per reply, whatever it named. `loadEmails()` takes no
        // arguments and always reloads the view that is open, so deduping by
        // (account, mailbox) deduped the keys and not the work: in All
        // Inboxes, a reply naming two accounts' INBOXes fired two concurrent
        // reloads of the one list. Notifications still fire once per change.
        if (repaint) useMailStore.getState().loadEmails?.();
      }
    })();
    return () => { stopped = true; };
  }, []);

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
    // A token refreshed in the last tick reaches the daemon's watcher here.
    registerWatchers();

    try {
      const result = await refreshAllAccounts();
      setLastRefreshTime(Date.now());
      console.log('[scheduler] Refresh completed:', result);

      // Dispatch per-account notifications (replaces old aggregate notification)
      if (result && result.perAccountResults) {
        dispatchNotifications(result.perAccountResults);
      }

      // Update badge to reflect total unread across ALL accounts
      if (result) {
        if (badgeMode === 'unread') {
          const unreadPerAccount = useSettingsStore.getState().unreadPerAccount || {};
          const hiddenAccounts = useSettingsStore.getState().hiddenAccounts || {};
          const total = Object.entries(unreadPerAccount)
            .filter(([id]) => !hiddenAccounts[id])
            .reduce((sum, [, count]) => sum + (count || 0), 0);
          updateBadge(total);
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

  // Finish any server op the last session confirmed but never sent.
  //
  // Deliberately NOT gated on refreshOnLaunch: that setting governs whether the
  // app goes looking for new mail, while this is unfinished work the user
  // already asked for and was shown as done. It also has to run before the
  // first list load, or that load re-downloads the very headers this is about
  // to delete. Once per session — accounts.length can change as accounts load,
  // and re-issuing these is not free.
  useEffect(() => {
    if (accounts.length === 0 || hasReplayedOps.current) return;
    hasReplayedOps.current = true;
    import('../services/workflows/replayOps')
      .then(({ replayOps, wireReplayOnReconnect }) => {
        // Wired here rather than at module load: it needs the same "there is at
        // least one account" precondition, and it is idempotent so a remount
        // that re-runs this effect costs nothing.
        wireReplayOnReconnect();
        return replayOps();
      })
      .catch((e) => console.warn('[scheduler] Could not replay pending ops:', e));
  }, [accounts.length]);

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
        // Sum unread across ALL accounts (not just current view)
        const unreadPerAccount = useSettingsStore.getState().unreadPerAccount || {};
        const hiddenAccounts = useSettingsStore.getState().hiddenAccounts || {};
        const total = Object.entries(unreadPerAccount)
          .filter(([id]) => !hiddenAccounts[id])
          .reduce((sum, [, count]) => sum + (count || 0), 0);
        updateBadge(total);
      } else {
        updateBadge(useMailStore.getState().emails.length);
      }
    }, 2000);

    return () => { if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current); };
  }, [badgeEnabled, badgeMode, emails.length, totalUnreadCount]);

  return { doRefresh };
}
