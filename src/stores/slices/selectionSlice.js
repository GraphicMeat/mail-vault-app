// ── selectionSlice — email selection, viewer, and bulk operations ──
// Large async orchestration functions are extracted to src/services/workflows/.
// This slice contains state, simple inline actions, and passthrough wrappers.

import { buildThreads } from '../../utils/emailParser';
import { mergesSentIntoThreads } from '../../utils/sentFolder';
import { selectionKey, refreshSelectedThread, resolveEmailLocation } from './unifiedHelpers';
import { useSettingsStore } from '../settingsStore';
import { useViewHideStore } from '../viewHideStore';
import {
  selectEmail as _selectEmail,
  _prefetchAdjacentEmails,
  cancelSelection as _cancelSelection,
} from '../../services/workflows/selectEmail';
import {
  markSelectedAsRead as _markSelectedAsRead,
  markSelectedAsUnread as _markSelectedAsUnread,
  setSelectedFlagged as _setSelectedFlagged,
  toggleFlagged as _toggleFlagged,
  deleteSelectedFromServer as _deleteSelectedFromServer,
  moveEmails as _moveEmails,
  purgeEverywhereReporting as _purgeEverywhere,
} from '../../services/workflows/messageMutations';
import { t } from '../../i18n/index.js';
import { captureSelectionSnapshot } from '../../services/headerIdentity.js';

function replaceSelection(state, keys, rows, priorSnapshots) {
  const selectedEmailIds = new Set(keys);
  const available = new Map((rows || [...(state.sortedEmails || []), ...(state.emails || []), ...(state.sentEmails || []), ...(state.localEmails || [])]).map(row => [selectionKey(row, state), row]));
  const selectedEmailSnapshots = new Map();
  for (const key of selectedEmailIds) {
    if (state.selectedEmailIds.has(key)) {
      selectedEmailSnapshots.set(key, state.selectedEmailSnapshots?.get(key) ?? null);
    } else if (priorSnapshots?.has(key)) {
      selectedEmailSnapshots.set(key, priorSnapshots.get(key));
    } else {
      const row = available.get(key);
      const location = resolveEmailLocation(row, state);
      selectedEmailSnapshots.set(key, location ? captureSelectionSnapshot(row, location.accountId, location.mailbox) : null);
    }
  }
  return { selectedEmailIds, selectedEmailSnapshots };
}

export const createSelectionSlice = (set, get) => ({
  selectedEmailId: null,
  selectedEmail: null,
  selectedEmailSource: null, // 'server' | 'local' | 'local-only'
  selectedThread: null, // thread object from buildThreads, or null for single email
  // The message of `selectedThread` the reader opens on and scrolls to (an
  // emailKey), when the thread was opened for one message in it ("Go to
  // mailbox"). Null opens the newest, as a click on the row does.
  threadFocusKey: null,
  loadingEmail: false,
  markReadProgress: null,

  // Account of the last message opened. Only meaningful in the unified inbox,
  // where activeAccountId is just whichever account was last activated and the
  // list mixes them all: a fresh compose sends from the account whose message
  // the user was last reading. `selectedEmail` can't answer this — a body
  // fetched from the server carries no _accountId (see selectEmail workflow).
  lastSelectedAccountId: null,

  // Selection for bulk actions
  selectedEmailIds: new Set(),
  selectedEmailSnapshots: new Map(),

  // Session tombstones for deleted emails: "accountId|mailbox|uid".
  // Deleted emails are filtered out of every list render until the header
  // cache is reconciled — otherwise switching account/folder and back
  // rehydrates them from the stale cache while the server delete is in flight.
  deleteTombstones: new Set(),

  // Select a thread (shows all emails in the thread in the viewer)
  selectThread: (thread, focusKey = null) => {
    // Clicking the row of the thread already open changes nothing on screen,
    // so it must not cancel that thread's mark-as-read countdowns: nothing
    // would start them again. A selection still loading is cancelled either way.
    const reopen = get().selectedThread?.threadId === thread.threadId;
    _cancelSelection({ keepThreadTimers: reopen });
    set(state => ({
      selectedThread: thread,
      threadFocusKey: focusKey,
      // The same key the rows are drawn with, or the row never reads as open.
      selectedEmailId: selectionKey(thread.lastEmail, state),
      selectedEmail: null,
      selectedEmailSource: null,
      loadingEmail: false,
      markReadProgress: reopen ? state.markReadProgress : null,
      // Only unified rows are tagged; a single-account row leaves it standing.
      lastSelectedAccountId: thread.lastEmail._accountId || state.lastSelectedAccountId,
    }));
  },

  // Re-read the open thread from the threads the list has just built, so a
  // message that joined the conversation (the reply you sent, one a sync
  // brought in, the server's copy replacing a staged one) shows in the reader
  // without closing and reopening the row. No-ops unless the membership
  // actually changed — see refreshSelectedThread. A member the list holds
  // back because a saved view holds it ("hide view mail") stays: the same
  // gated key set the list filters by (updateSortedEmails).
  syncSelectedThread: (threads) => {
    // `getState?.`: many specs mock these stores with selectors alone.
    const held = useSettingsStore.getState?.()?.hideViewMail ? useViewHideStore.getState?.()?.keys ?? null : null;
    const update = refreshSelectedThread(get(), threads, held);
    if (update) set(update);
  },

  // Put the reader away and leave the list. The same four fields every
  // workflow clears when the open message stops existing (applyServerRemoval,
  // removeLocalEmail) — closing is the deliberate version of that, so it
  // clears the same set rather than a subset that leaves the pane half-open.
  // `loadingEmail` too: closing during a body fetch must not leave the spinner
  // standing as the whole pane's content.
  closeEmail: () => {
    _cancelSelection();
    set({
      selectedEmailId: null,
      selectedEmail: null,
      selectedEmailSource: null,
      selectedThread: null,
      loadingEmail: false,
      markReadProgress: null,
    });
  },

  // ── Passthrough wrappers to workflow functions ──

  _prefetchAdjacentEmails: (currentUid) => _prefetchAdjacentEmails(currentUid),
  selectEmail: (uid, source, mailboxOverride, locationOverride, clickedRow) => _selectEmail(uid, source, mailboxOverride, locationOverride, clickedRow),

  // ── Simple inline actions (stay in slice) ──

  toggleEmailSelection: (uid, accountId = null, mailbox = null, clickedRow = null) => {
    set(state => {
      // Through the helper, never by hand: the checkbox has to write the key
      // every other control reads.
      const key = selectionKey({ _accountId: accountId || undefined, _mailbox: mailbox || undefined, uid }, state);
      const newSelection = new Set(state.selectedEmailIds);
      if (newSelection.has(key)) {
        newSelection.delete(key);
      } else {
        newSelection.add(key);
      }
      return replaceSelection(state, newSelection, clickedRow ? [clickedRow] : undefined);
    });
  },

  // Select or deselect one row's worth of messages in a single write.
  // A thread row's checkbox is one control over many messages: toggling each
  // uid in turn inverts a partially-selected thread instead of following the
  // box the user just clicked, and fires one store write (one list re-render)
  // per message in the thread.
  setEmailsSelected: (emails, selected) => {
    set(state => {
      const next = new Set(state.selectedEmailIds);
      for (const e of emails) {
        const key = selectionKey(e, state);
        if (selected) next.add(key);
        else next.delete(key);
      }
      return replaceSelection(state, next, emails);
    });
  },

  selectAllEmails: () => {
    const state = get();
    set(replaceSelection(state, state.sortedEmails.map(e => selectionKey(e, state)), state.sortedEmails));
  },

  clearSelection: () => {
    set({ selectedEmailIds: new Set(), selectedEmailSnapshots: new Map() });
  },

  // Replace the selection wholesale. The bulk modal's date range resolves to a
  // uid list; writing it here is what puts checkmarks on the rows and lets the
  // user amend the range by hand before starting.
  setSelection: (keys, rows, priorSnapshots) => {
    set(state => replaceSelection(state, keys, rows, priorSnapshots));
  },

  getSelectionSummary: () => {
    const { selectedEmailIds, sortedEmails } = get();
    if (selectedEmailIds.size === 0) return { threads: 0, emails: 0 };

    // Thread over the same messages the list threaded over. An INBOX list
    // threads INBOX + Sent together (EmailList's `mergedEmails`, via
    // getChatEmails) so a conversation reads whole; re-threading INBOX alone
    // here split it again wherever a sent reply was the only link, and two
    // checked rows reported "(4 conversations)". All inboxes showing INBOX
    // threads the same way. Not getThreads(): its memo
    // key carries neither account nor mailbox, and a count is not worth
    // trusting to that.
    const threads = buildThreads(mergesSentIntoThreads(get()) ? get().getChatEmails() : sortedEmails);
    // `sortedEmails` is the paginated render window; the selection is not
    // bound to it — the bulk modal resolves a date range against the whole
    // sidecar cache (BulkOperationsModal's `cachedRows`), so it can select
    // messages that were never rendered. Threading only knows the window, so
    // track which selected keys a loaded thread actually covers.
    const covered = new Set();
    let threadCount = 0;

    for (const [, thread] of threads) {
      let hasSelected = false;
      for (const e of thread.emails) {
        const key = selectionKey(e, get());
        if (selectedEmailIds.has(key)) {
          covered.add(key);
          hasSelected = true;
        }
      }
      if (hasSelected) threadCount++;
    }

    // Anything the window couldn't thread counts as its own unit — dropping
    // it made the action bar report fewer than the operation acts on (bar
    // "52 selected (65 emails)" against the modal's 65, archiving 65).
    let unwindowed = 0;
    for (const key of selectedEmailIds) if (!covered.has(key)) unwindowed++;

    return { threads: threadCount + unwindowed, emails: selectedEmailIds.size };
  },

  // ── Passthrough wrappers to workflow functions ──

  markSelectedAsRead: () => _markSelectedAsRead(),
  markSelectedAsUnread: () => _markSelectedAsUnread(),
  setSelectedFlagged: (on) => _setSelectedFlagged(on),
  toggleFlagged: (key) => _toggleFlagged(key),
  deleteSelectedFromServer: () => _deleteSelectedFromServer(),
  moveEmails: (uids, targetMailbox) => _moveEmails(uids, targetMailbox),
  purgeSelectedEverywhere: (opts) => _purgeEverywhere([...get().selectedEmailIds], opts),
});
