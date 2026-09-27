// ── thread mark-as-read timers ──
//
// The single reader marks the one message it opens (selectEmail's
// _autoMarkRead). A thread shows several at once, so each message the user
// has expanded is read on its own countdown, keyed the way the flag core keys
// a target (`accountId-mailbox-uid`): a hand-set read state cancels it through
// cancelPendingMarkRead, like the single reader's. Every countdown belongs to
// the thread it started in, and opening another one drops them all.

import { useSettingsStore } from '../../stores/settingsStore';
import { emailScopeKey, selectionKey } from '../../stores/slices/unifiedHelpers';
import { applyFlagToKeys } from './messageMutations';

const _timers = new Map();
let _threadId = null;
// Bumped by every cancel. A start still waiting on the store import when one
// lands belongs to a reader that has gone.
let _epoch = 0;
// Imported on first use, for the reason selectEmail gives: the store reaches
// back into the workflows. After that first import a start never awaits.
let _store = null;

function _clearAll() {
  if (!_timers.size) return;
  for (const id of _timers.values()) clearTimeout(id);
  _timers.clear();
  _store?.setState({ markReadProgress: null });
}

export function stopThreadReadTimer(key) {
  if (!_timers.has(key)) return;
  clearTimeout(_timers.get(key));
  _timers.delete(key);
  if (!_timers.size) _store?.setState({ markReadProgress: null });
}

export function cancelThreadReadTimers() {
  _epoch += 1;
  _threadId = null;
  _clearAll();
}

export async function startThreadReadTimer(threadId, email) {
  const epoch = _epoch;
  _store ??= (await import('../../stores/mailStore')).useMailStore;
  if (epoch !== _epoch) return;
  if (threadId !== _threadId) {
    _clearAll();
    _threadId = threadId;
  }

  const { markAsReadMode, markAsReadDelay } = useSettingsStore.getState();
  const opened = _store.getState();
  const key = emailScopeKey(email, opened);
  if (markAsReadMode === 'manual' || !key || email?.flags?.includes('\\Seen') || _timers.has(key)) return;

  // Resolved now, against the view the message was opened in: a single
  // folder's key is a bare uid, and after a switch of folder or account the
  // same number is another message. Same fence as _autoMarkRead's.
  const selKey = selectionKey(email, opened);
  const viewIsCurrent = () => {
    const s = _store.getState();
    return s.activeAccountId === opened.activeAccountId
      && s.activeMailbox === opened.activeMailbox
      && s.mailboxScope === opened.mailboxScope;
  };
  // Not undoable: setUndo replaces the one undo slot, so a message marking
  // itself would silently withdraw whatever offer was live (a delete's).
  const mark = async () => {
    if (!viewIsCurrent()) return;
    try {
      await applyFlagToKeys([selKey], '\\Seen', true, { undoable: false });
    } catch (e) {
      console.warn('[threadReadTimer] Mark as read failed:', e);
    }
  };

  if (markAsReadMode !== 'delay') return mark();

  const delay = (markAsReadDelay || 3) * 1000;
  const startedAt = Date.now();
  _timers.set(key, setTimeout(() => {
    _timers.delete(key);
    if (!_timers.size) _store.setState({ markReadProgress: null });
    void mark();
  }, delay));
  _store.setState({ markReadProgress: { startedAt, endsAt: startedAt + delay } });
}
