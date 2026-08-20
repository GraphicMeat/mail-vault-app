// ── selectionSlice — email selection, viewer, and bulk operations ──
// Large async orchestration functions are extracted to src/services/workflows/.
// This slice contains state, simple inline actions, and passthrough wrappers.

import { buildThreads } from '../../utils/emailParser';
import { _selKey, _parseSelKey, _resolveUnifiedContext } from './unifiedHelpers';
import {
  selectEmail as _selectEmail,
  _prefetchAdjacentEmails,
} from '../../services/workflows/selectEmail';
import {
  markSelectedAsRead as _markSelectedAsRead,
  markSelectedAsUnread as _markSelectedAsUnread,
  deleteSelectedFromServer as _deleteSelectedFromServer,
  moveEmails as _moveEmails,
  purgeEverywhere as _purgeEverywhere,
} from '../../services/workflows/messageMutations';

export const createSelectionSlice = (set, get) => ({
  selectedEmailId: null,
  selectedEmail: null,
  selectedEmailSource: null, // 'server' | 'local' | 'local-only'
  selectedThread: null, // thread object from buildThreads, or null for single email
  loadingEmail: false,

  // Selection for bulk actions
  selectedEmailIds: new Set(),

  // Session tombstones for deleted emails: "accountId|mailbox|uid".
  // Deleted emails are filtered out of every list render until the header
  // cache is reconciled — otherwise switching account/folder and back
  // rehydrates them from the stale cache while the server delete is in flight.
  deleteTombstones: new Set(),

  // Select a thread (shows all emails in the thread in the viewer)
  selectThread: (thread) => {
    set({
      selectedThread: thread,
      selectedEmailId: thread.lastEmail.uid,
      selectedEmail: null,
      selectedEmailSource: null,
      loadingEmail: false,
    });
  },

  // ── Passthrough wrappers to workflow functions ──

  _prefetchAdjacentEmails: (currentUid) => _prefetchAdjacentEmails(currentUid),
  selectEmail: (uid, source, mailboxOverride) => _selectEmail(uid, source, mailboxOverride),

  // ── Simple inline actions (stay in slice) ──

  toggleEmailSelection: (uid, accountId = null) => {
    set(state => {
      const isUnified = state.activeMailbox === 'UNIFIED';
      const key = isUnified && accountId ? `${accountId}:${uid}` : uid;
      const newSelection = new Set(state.selectedEmailIds);
      if (newSelection.has(key)) {
        newSelection.delete(key);
      } else {
        newSelection.add(key);
      }
      return { selectedEmailIds: newSelection };
    });
  },

  selectAllEmails: () => {
    const { sortedEmails, activeMailbox } = get();
    const isUnified = activeMailbox === 'UNIFIED';
    set({ selectedEmailIds: new Set(sortedEmails.map(e => isUnified ? _selKey(e) : e.uid)) });
  },

  clearSelection: () => {
    set({ selectedEmailIds: new Set() });
  },

  // Replace the selection wholesale. The bulk modal's date range resolves to a
  // uid list; writing it here is what puts checkmarks on the rows and lets the
  // user amend the range by hand before starting.
  setSelection: (keys) => {
    set({ selectedEmailIds: new Set(keys) });
  },

  getSelectionSummary: () => {
    const { selectedEmailIds, sortedEmails, activeMailbox } = get();
    if (selectedEmailIds.size === 0) return { threads: 0, emails: 0 };

    const isUnified = activeMailbox === 'UNIFIED';
    const threads = buildThreads(sortedEmails);
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
        const key = isUnified ? _selKey(e) : e.uid;
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
  deleteSelectedFromServer: () => _deleteSelectedFromServer(),
  moveEmails: (uids, targetMailbox) => _moveEmails(uids, targetMailbox),
  purgeSelectedEverywhere: (opts) => _purgeEverywhere([...get().selectedEmailIds], opts),
});
