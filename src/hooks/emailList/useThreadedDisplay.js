import { useMemo, useRef } from 'react';
import { emailKey as messageKey } from '../../stores/slices/unifiedHelpers';

export function useThreadedDisplay({ displayEmails, searchActive, deferredThreads, expandedThreads, threadMode, threadSortOrder }) {
  // ── Cached display-row builder ──
  // Separates structural rebuilds (membership/order) from lightweight flag-freshening passes.
  // Structural rebuild: when thread set or display email UIDs change.
  // Freshening: when only flags/archived state change, reuse existing rows and update email refs.
  const displayRowCache = useRef({ deferredThreads: null, rows: [], displayEmails: null });

  // Account, folder AND uid. `freshen` below swaps a thread's rows for the
  // list's current copies by this key, and an INBOX thread holds the Sent
  // copies merged in for context — keyed by uid alone, a reply of yours whose
  // Sent uid matched an INBOX uid in the same thread was replaced by that
  // INBOX message, and drawn as it.
  const emailKey = messageKey;

  const threadedDisplay = useMemo(() => {
    // `threadMode === 'flat'` explicitly: threads may now exist in flat mode
    // purely to answer which rows are siblings, and must never regroup the list.
    const isFlat = searchActive || threadMode === 'flat' || !deferredThreads || deferredThreads.size === 0;

    const cache = displayRowCache.current;

    if (isFlat) {
      // Flat list — reuse row array if displayEmails identity hasn't changed
      if (cache.displayEmails === displayEmails && cache.rows.length === displayEmails.length) {
        return cache.rows;
      }
      // Rebuild — either structural change or flag-only change (new sortedEmails array)
      const rows = displayEmails.map(email => ({ type: 'email', email }));
      displayRowCache.current = { deferredThreads: null, rows, displayEmails };
      return rows;
    }

    // Threaded path — build lookup for freshening
    const freshByKey = new Map();
    for (const e of displayEmails) {
      freshByKey.set(emailKey(e), e);
    }
    const freshen = (e) => freshByKey.get(emailKey(e)) || e;

    // Reuse cached rows only when thread model AND display emails are both unchanged.
    // deferredThreads is a new Map on every recomputation, so identity check is reliable.
    if (cache.deferredThreads === deferredThreads && cache.displayEmails === displayEmails
        && cache.expandedThreads === expandedThreads && cache.threadMode === threadMode
        && cache.threadSortOrder === threadSortOrder) {
      return cache.rows;
    }

    // Structural rebuild — filter, sort, wrap
    const result = [];
    for (const thread of deferredThreads.values()) {
      if (thread.emails.some(e => freshByKey.has(emailKey(e)))) {
        result.push(thread);
      }
    }
    result.sort((a, b) => b.lastDate - a.lastDate);

    const rows = [];
    const unfold = threadMode === 'expandable';
    for (const thread of result) {
      if (thread.messageCount === 1) {
        rows.push({ type: 'email', email: freshen(thread.emails[0]) });
      } else {
        // Only a thread whose rows really were replaced gets a new array: the
        // row reads the array's identity to know it has to repaint.
        const fresh = thread.emails.map(freshen);
        if (fresh.some((e, i) => e !== thread.emails[i])) thread.emails = fresh;
        thread.lastEmail = freshen(thread.lastEmail) || thread.emails[thread.emails.length - 1];
        rows.push({ type: 'thread', thread });
        if (unfold && expandedThreads.has(thread.threadId)) {
          // The whole conversation, the Sent copies an INBOX list merges in
          // included: a reply you wrote is part of what you unfold. Each row
          // carries its own folder (`_mailbox`), so opening one opens the
          // right message and ticking one keys by folder (selectionKey). The
          // thread row's own checkbox and menu still act on threadRowMembers.
          const ordered = threadSortOrder === 'newest-first' ? [...thread.emails].reverse() : thread.emails;
          for (const email of ordered) rows.push({ type: 'thread-member', email, threadId: thread.threadId });
        }
      }
    }

    displayRowCache.current = { deferredThreads, rows, displayEmails, expandedThreads, threadMode, threadSortOrder };
    return rows;
  }, [displayEmails, searchActive, deferredThreads, emailKey, expandedThreads, threadMode, threadSortOrder]);

  return { displayRowCache, emailKey, threadedDisplay };
}
