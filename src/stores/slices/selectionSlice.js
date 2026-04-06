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
} from '../../services/workflows/messageMutations';

export const createSelectionSlice = (set, get) => ({
  selectedEmailId: null,
  selectedEmail: null,
  selectedEmailSource: null, // 'server' | 'local' | 'local-only'
  selectedThread: null, // thread object from buildThreads, or null for single email
  loadingEmail: false,

  // Selection for bulk actions
  selectedEmailIds: new Set(),

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

  getSelectionSummary: () => {
    const { selectedEmailIds, sortedEmails, activeMailbox } = get();
    if (selectedEmailIds.size === 0) return { threads: 0, emails: 0 };

    const isUnified = activeMailbox === 'UNIFIED';
    const threads = buildThreads(sortedEmails);
    let threadCount = 0;

    for (const [, thread] of threads) {
      const hasSelected = thread.emails.some(e => selectedEmailIds.has(isUnified ? _selKey(e) : e.uid));
      if (hasSelected) threadCount++;
    }

    return { threads: threadCount, emails: selectedEmailIds.size };
  },

  // ── Passthrough wrappers to workflow functions ──

  markSelectedAsRead: () => _markSelectedAsRead(),
  markSelectedAsUnread: () => _markSelectedAsUnread(),
  deleteSelectedFromServer: () => _deleteSelectedFromServer(),
  moveEmails: (uids, targetMailbox) => _moveEmails(uids, targetMailbox),
});
