import { useEffect, useRef } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useAccountStore } from '../stores/accountStore';
import { useMessageListStore } from '../stores/messageListStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSnoozeStore } from '../stores/snoozeStore';
import { useViewHideStore } from '../stores/viewHideStore';
import { recountNativeInbox, unreadPresentation } from '../stores/unreadCounts';
import { invalidateUnreadConnection } from '../services/unreadCountsClient';
import { invalidateRestoreDescriptors } from '../services/cacheManager';
import { waitForSyncChanges } from '../services/syncService';
import { accountExpectedContext } from '../services/db/accounts';
import { connectNativeSync, observeNativeView, currentNativeView, nativeInstanceId } from '../services/nativeSyncContext.js';
import { deliverPreparedNotice, offerPreparedCode } from '../services/nativeArrival.js';

const invoke = window.__TAURI__?.core?.invoke;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const accountContext = (state, id) => {
  const account = state.accounts?.find(row => row.id === id);
  return account ? JSON.stringify(accountExpectedContext(account, 'all')) : null;
};

// Fire-and-forget, loaded late: both stores sit on top of the mail store this
// hook is imported under, and nothing in the change feed waits on either.
function viewCountsStale() {
  import('../stores/viewStore')
    .then(({ scheduleViewCountsRefresh }) => scheduleViewCountsRefresh())
    .catch(error => console.warn('[scheduler] Could not count the saved views again:', error));
}

// One import for both notes calls below, which a flag change fires in the
// same tick: vitest's mocker hands the second of two imports in flight the
// real module, so a test saw the board reread nothing.
let notesStore = null;
const loadNotesStore = () => (notesStore ||= import('../stores/notesStore'));

function notesStale() {
  loadNotesStore()
    .then(({ scheduleNotesReload }) => scheduleNotesReload())
    .catch(error => console.warn('[scheduler] Could not list the notes board again:', error));
}

function rereadNoteFlags(accountId, mailbox) {
  loadNotesStore()
    .then(({ useNotesStore }) => useNotesStore.getState().rereadCopyFlags(accountId, mailbox))
    .catch(error => console.warn('[scheduler] Could not repaint the notes board:', error));
}

export function useEmailScheduler() {
  const refreshAllAccounts = useAccountStore(s => s.refreshAllAccounts);
  const accounts = useAccountStore(s => s.accounts);
  const emails = useMessageListStore(s => s.emails);
  const unreadPerAccount = useSettingsStore(s => s.unreadPerAccount);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const displayNames = useSettingsStore(s => s.displayNames);
  const accountOrder = useSettingsStore(s => s.accountOrder);
  const { badgeEnabled, badgeMode } = useSettingsStore();
  const activeAccountId = useMailStore(s => s.activeAccountId);
  const activeMailbox = useMailStore(s => s.activeMailbox);
  const unifiedInbox = useMailStore(s => s.unifiedInbox);
  const unifiedFolder = useMailStore(s => s.unifiedFolder);
  const mailboxScope = useMailStore(s => s.mailboxScope);

  const hasReplayedOps = useRef(false);
  const lastBadgeCount = useRef(-1);
  const lastTrayRows = useRef('');
  const hadAccounts = useRef(false);
  const badgeTimerRef = useRef(null);

  const loadedInbox = accountId => {
    const s = useMailStore.getState();
    return s.activeAccountId === accountId && !s.unifiedInbox && !s.mailboxScope
      && s.activeMailbox === 'INBOX' ? { emails: s.emails, totalEmails: s.totalEmails } : undefined;
  };
  const recountInboxUnread = (accountId, newEmails, change) =>
    recountNativeInbox(accountId, {
      ...(newEmails > 0 ? { arrivalCount: newEmails } : {}),
      ...(change ? { change, preferredRows: loadedInbox(accountId) } : {}),
    });

  // A local snooze, its wake and its undo take a message out of an inbox or
  // put it back with no sync to report it. The list on screen recounts its own
  // inbox (updateSortedEmails, from rows fresher than the cache) when it holds
  // the whole inbox; every other inbox that changed, and one the list only
  // holds a window of, is recounted here from the daemon's cache.
  useEffect(() => useSnoozeStore.subscribe((state, prev) => {
    if (state.rows === prev.rows) return;
    const before = prev.rows, after = state.rows;
    const candidates = new Set([...before, ...after].map(row => row.accountId).filter(Boolean));
    for (const accountId of candidates) void recountInboxUnread(accountId, 0,
      { kind: 'snoozes', before: before.map(row => ({ accountId:row.accountId,
        fromMailbox:row.fromMailbox, snoozedMailbox:row.snoozedMailbox,
        messageId:row.messageId, state:row.state })), after: after.map(row => ({
        accountId:row.accountId, fromMailbox:row.fromMailbox, snoozedMailbox:row.snoozedMailbox,
        messageId:row.messageId, state:row.state })) });
  }), []);

  // "Hide mail views hold": a new answer about which messages the saved views
  // hold (or the setting going off, which forgets it: `keys` goes null) moves
  // an inbox's badge with no sync to report it. Every account whose INBOX
  // keys changed is recounted from its cache, but the list on screen, which
  // recounts its own (updateSortedEmails). `null` is an empty set here.
  useEffect(() => useViewHideStore.subscribe((state, prev) => {
    if (state.keys === prev.keys) return;
    const before = prev.keys == null ? null : [...prev.keys];
    const after = state.keys == null ? null : [...state.keys];
    for (const account of useMailStore.getState().accounts) void recountInboxUnread(account.id, 0,
      { kind: 'viewHiddenKeys', before, after });
  }), []);

  // The same main-window context survives hook remounts. This observes the
  // currently visible view; only the daemon chooses schedule and targets.
  useEffect(() => {
    observeNativeView(currentNativeView()).catch(error =>
      console.warn('[scheduler] The native view could not be reported:', error));
  },
    [activeAccountId, activeMailbox, unifiedInbox, unifiedFolder, mailboxScope]);

  useEffect(() => {
    let stopped = false;
    let since = null;
    let processId = null;
    const unlisten = [];
    const sourceRefs = new Map();
    const waiting = [];
    const sourceVersions = new Map();
    let recovering = null;
    let stopAccountWait = null;
    let pendingChannel = false;
    const version = accountId => sourceVersions.get(accountId) || 0;
    const stopSourceWatch = useMailStore.subscribe((state, previous) => {
      const ids = new Set([...(previous.accounts || []), ...(state.accounts || [])].map(row => row.id));
      for (const id of ids) {
        if (accountContext(state, id) === accountContext(previous, id)) continue;
        // A first appearance has no earlier source to invalidate; a reply that
        // was already in flight may carry this account's first notice, and the
        // daemon spent its one claim preparing it.
        if (!accountContext(previous, id)) continue;
        sourceVersions.set(id, version(id) + 1);
        for (const [reference, source] of sourceRefs) {
          if (source.accountId === id) sourceRefs.delete(reference);
        }
        for (let index = waiting.length - 1; index >= 0; index--) {
          if (waiting[index].payload.accountId === id) waiting.splice(index, 1);
        }
      }
    });
    const current = (reference, accountId, instance) => {
      if (stopped || instance !== nativeInstanceId() || instance !== processId) return false;
      const source = sourceRefs.get(reference);
      return source?.accountId === accountId
        && source.version === version(accountId)
        && source.context === accountContext(useMailStore.getState(), accountId);
    };
    const consume = (kind, payload, buffer = true) => {
      if (!payload || typeof payload.sourceRef !== 'string') return;
      if (!sourceRefs.has(payload.sourceRef)) {
        if (buffer) {
          if (waiting.length >= 64) waiting.shift();
          waiting.push({ kind, payload });
        }
        return;
      }
      if (!current(payload.sourceRef, payload.accountId, payload.instanceId)) return;
      if (kind === 'notify') void deliverPreparedNotice(payload);
      else offerPreparedCode(payload);
    };
    const register = change => {
      if (!change?.sourceRef || !change.accountId) return;
      const context = accountContext(useMailStore.getState(), change.accountId);
      if (!context) return;
      sourceRefs.set(change.sourceRef, { accountId: change.accountId,
        context, version: version(change.accountId) });
      if (sourceRefs.size > 128) sourceRefs.delete(sourceRefs.keys().next().value);
    };
    const catchUp = async ({ channelChanged = false } = {}) => {
      if (stopped) return;
      sourceRefs.clear(); waiting.length = 0;
      invalidateUnreadConnection();
      const status = await connectNativeSync({ channelChanged });
      if (stopped) return;
      processId = status.instanceId;
      for (const account of useMailStore.getState().accounts) {
        void recountNativeInbox(account.id).catch(() => {});
      }
      viewCountsStale(); notesStale();
      const mail = useMailStore.getState();
      if (mail.unifiedInbox || mail.activeMailbox === 'UNIFIED') {
        void mail.loadUnifiedInbox?.(null, mail.unifiedFolder || 'INBOX');
      } else if (mail.activeAccountId && mail.activeMailbox) {
        void mail.loadEmails?.({ rereadFlags: true });
      }
    };
    const recover = options => {
      pendingChannel ||= options?.channelChanged === true;
      if (recovering) return recovering;
      recovering = (async () => {
        while (!stopped) {
          const channelChanged = pendingChannel;
          pendingChannel = false;
          try {
            await catchUp({ channelChanged });
            if (!pendingChannel) return;
          }
          catch (error) {
            pendingChannel ||= channelChanged;
            console.warn('[scheduler] Native status recovery is pending:', error);
            await pause(5_000);
          }
        }
      })().finally(() => { recovering = null; });
      return recovering;
    };
    const onChange = async change => {
      const { accountId, mailbox, newEmails = 0, updatedFlags = 0 } = change;
      const snapshot = useMailStore.getState();
      const source = accountContext(snapshot, accountId);
      if (!source) return { repaint: false, flagsMoved: false };
      invalidateRestoreDescriptors(accountId);
      if (updatedFlags > 0) rereadNoteFlags(accountId, mailbox);
      if (mailbox === 'INBOX') await recountInboxUnread(accountId, newEmails);
      if (source !== accountContext(useMailStore.getState(), accountId)) return { repaint: false, flagsMoved: false };
      const now = useMailStore.getState();
      const onScreen = (now.activeAccountId === accountId &&
        (now.activeMailbox === mailbox || now.mailboxScope?.paths?.includes(mailbox)))
        || ((now.unifiedInbox || now.activeMailbox === 'UNIFIED')
          && (now.unifiedFolder || 'INBOX') === mailbox);
      return { repaint: onScreen, flagsMoved: onScreen && updatedFlags > 0 };
    };
    (async () => {
      while (!stopped) {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        for (const [name, handler] of [
          ['notify', event => consume('notify', event.payload)],
          ['code-ready', event => consume('code-ready', event.payload)],
          ['daemon-reconnected', () => { void recover({ channelChanged: true }); }],
          ['daemon-events-lagged', () => { void recover(); }],
        ]) {
          const off = await listen(name, handler);
          if (stopped) off?.(); else unlisten.push(off);
        }
        if (stopped) return;
        // Nothing is attached or polled before the accounts are in the store: a
        // reply that names an account the app does not know yet is dropped, and
        // the daemon has already spent its one claim on that notice.
        if (!useMailStore.getState().accounts?.length) {
          await new Promise(resolve => {
            const off = useMailStore.subscribe(state => {
              if (state.accounts?.length) { off(); resolve(); }
            });
            stopAccountWait = () => { off(); resolve(); };
          });
          stopAccountWait = null;
          if (stopped) return;
        }
        // All typed-event and reconnect listeners are live before native
        // owner attachment, context admission or the first change poll.
        await recover();
        while (!stopped) {
          let reply;
          const admittedVersions = new Map(sourceVersions);
          try { reply = await waitForSyncChanges(since, 25000); }
          catch (error) {
            if (stopped || error?.code === 'NO_TAURI') return;
            await pause(error?.code === 'DAEMON_OFFLINE' ? 30_000 : 5_000);
            if (stopped) return;
            await recover();
            continue;
          }
          if (stopped) return;
          if (reply?.instanceId !== processId || reply?.resyncRequired
            || (since != null && reply?.gen < since)) {
            since = reply?.gen ?? null;
            await recover({ channelChanged: reply?.instanceId !== processId });
            continue;
          }
          since = reply?.gen ?? since;
          const changes = (reply?.changes || []).filter(change =>
            (admittedVersions.get(change.accountId) || 0) === version(change.accountId));
          for (const change of changes) register(change);
          for (const item of waiting.splice(0)) consume(item.kind, item.payload, false);
          for (const notice of reply?.notifications || []) consume('notify', notice, false);
          if (changes.length) { viewCountsStale(); notesStale(); }
          let repaint = false, flagsMoved = false;
          for (const change of changes) {
            if (stopped) break;
            let result;
            try { result = await onChange(change); }
            catch (error) {
              // One failed recount must not tear the feed down and clear every
              // parked source; the next change or recovery repairs the count.
              console.warn('[scheduler] A native change could not be applied:', error);
              continue;
            }
            repaint ||= result.repaint;
            flagsMoved ||= result.flagsMoved;
          }
          if (stopped) return;
          if (!repaint) continue;
          const mail = useMailStore.getState();
          if (mail.unifiedInbox || mail.activeMailbox === 'UNIFIED') {
            void mail.loadUnifiedInbox?.(null, mail.unifiedFolder || 'INBOX');
          } else {
            void mail.loadEmails?.(flagsMoved ? { rereadFlags: true } : undefined);
          }
        }
      } catch (error) {
        for (const off of unlisten.splice(0)) off?.();
        if (stopped) return;
        console.warn('[scheduler] Native change feed will retry:', error);
        await pause(5_000);
      }
      }
    })();
    return () => { stopped = true; stopAccountWait?.(); stopSourceWatch(); unlisten.forEach(off => off?.()); };
  }, []);

  // The badge's total, over the accounts the sidebar shows.
  const totalUnreadNow = async () => (await unreadPresentation())?.total ?? null;

  // The tray menu's account rows; Rust only hears about a change.
  const invokeCountSurface = (command, args) => {
    const answer = invoke(command, args);
    if (import.meta.env.VITE_E2E === '1' && typeof window.__UNREAD_NATIVE_OBSERVER__ === 'function') {
      try { window.__UNREAD_NATIVE_OBSERVER__(command, args, answer); }
      catch { /* Diagnostics cannot alter the shell call. */ }
    }
    return answer;
  };
  const updateTray = async (rows) => {
    const signature = JSON.stringify(rows);
    if (signature === lastTrayRows.current) return;
    try {
      await invokeCountSurface('set_tray_accounts', { accounts: rows });
      lastTrayRows.current = signature;
    } catch (error) {
      console.error('[scheduler] Failed to update the tray menu:', error);
    }
  };

  // Update badge count
  const updateBadge = async (count) => {
    if (!invoke) return;

    if (!useSettingsStore.getState().badgeEnabled) {
      // Clear badge if disabled
      try {
        await invokeCountSurface('set_badge_count', { count: 0 });
        lastBadgeCount.current = 0;
      } catch (error) {
        console.error('[scheduler] Failed to clear badge:', error);
      }
      return;
    }

    if (count === lastBadgeCount.current) return;
    try {
      await invokeCountSurface('set_badge_count', { count });
      lastBadgeCount.current = count;
    } catch (error) {
      console.error('[scheduler] Failed to update badge:', error);
    }
  };

  // User actions request a native receipt; the daemon owns launch and
  // interval scheduling. Repaint and counts are driven by its change feed.
  const doRefresh = async () => {
    try { return await refreshAllAccounts(); }
    catch (error) { console.error('[scheduler] Refresh failed:', error); return null; }
  };

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

  // Update the badge and the tray menu's rows when settings, the accounts or
  // their unread counts change. Debounced to avoid oscillation during IMAP
  // pagination (emails array changes every page).
  useEffect(() => {
    if (!invoke) return;
    let disposed = false;

    if (!badgeEnabled) void updateBadge(0);

    // Debounce: wait 2s after last change before updating badge.
    // During IMAP sync, emails.length changes every ~1s per page — we want the final stable value.
    if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current);
    badgeTimerRef.current = setTimeout(async () => {
      const accountsNow = useMailStore.getState().accounts;
      // Accounts not loaded yet: their counts would read as a 0 on the dock.
      if (!accountsNow.length && !hadAccounts.current) return;
      hadAccounts.current = true;
      const answer = await unreadPresentation();
      if (disposed || !answer) return;
      await updateTray(answer.rows);
      if (disposed) return;
      if (!badgeEnabled) return;
      if (badgeMode === 'unread') {
        await updateBadge(answer.total);
      } else {
        await updateBadge(useMailStore.getState().emails.length);
      }
    }, 2000);

    return () => { disposed = true; if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current); };
  }, [badgeEnabled, badgeMode, emails.length, accounts, unreadPerAccount, hiddenAccounts, displayNames, accountOrder]);

  return { doRefresh };
}
