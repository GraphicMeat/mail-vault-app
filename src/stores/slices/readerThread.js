import { rowIdentity, selectionKey } from './unifiedHelpers';
import { normalizeMessageId } from '../../utils/emailParser';

/** Open the conversation when a reply to the single message joins the list. */
export function promoteOpenEmail(state, threads) {
  const follow = state.followReply;
  if (!follow || state.selectedThread || !threads?.size) return null;
  if (state.selectedEmailId !== follow.emailId) return { followReply: null };
  const replyId = normalizeMessageId(follow.replyId);
  if (!replyId) return null;

  for (const thread of threads.values()) {
    if (!thread.emails.some(email => normalizeMessageId(email.messageId || email.message_id) === replyId)) continue;
    if (!thread.emails.some(email => selectionKey(email, state) === follow.emailId)) continue;
    return {
      selectedThread: thread,
      threadFocusKey: null,
      selectedEmailId: selectionKey(thread.lastEmail, state),
      selectedEmail: null,
      selectedEmailSource: null,
      followReply: null,
    };
  }
  return null;
}

/**
 * The open thread minus one message, as a store update. Null when no thread is
 * open or it does not hold the message; the reader's clear-set when the message
 * was the thread's last.
 *
 * `selectedThread` is a snapshot of buildThreads' output that nothing
 * re-derives, so a delete that only filtered `emails` left a ghost row in the
 * reader — or, when the deleted message was the newest (the one selectedEmailId
 * names), closed the whole thread over a single message. selectedEmailId moves
 * to the surviving newest message, the same way selectThread points it at
 * lastEmail, so the list row stays drawn as open.
 */
export function pruneSelectedThread(state, isRemoved) {
  const thread = state.selectedThread;
  if (!thread?.emails?.some(isRemoved)) return null;
  const emails = thread.emails.filter(e => !isRemoved(e));
  if (emails.length === 0) {
    return { selectedThread: null, selectedEmailId: null, selectedEmail: null, selectedEmailSource: null };
  }
  const lastEmail = emails.reduce((a, b) => (new Date(b.date) > new Date(a.date) ? b : a));
  // ponytail: participants/unreadCount/dateRange stay as built — the reader
  // draws subject, messageCount and emails; the list rebuilds its own threads.
  return {
    selectedThread: { ...thread, emails, lastEmail, messageCount: emails.length },
    selectedEmailId: selectionKey(lastEmail, state),
  };
}

/** A thread member's identity for comparison. A thread merges INBOX with Sent
 *  and the two share uids, so the folder is part of it. */
const memberKey = (e) => `${e._accountId || ''}\0${e._mailbox || ''}\0${e.uid}`;
const memberKeys = (emails) => (emails || []).map(memberKey).join(',');

/**
 * The open thread, re-read from the thread map the list has just built. Null
 * when there is nothing to change.
 *
 * pruneSelectedThread covers messages LEAVING the snapshot. Nothing covered one
 * arriving, so the reply you had just sent — and any message a sync brought in
 * — never joined the thread you were reading; only closing and reopening the
 * row showed it. The list already rebuilds its threads whenever the message
 * pool moves, so the open thread is re-read from that same map rather than
 * threading a second time here.
 *
 * Matched by threadId, then by any member the snapshot still shares with it: an
 * arriving message can bridge two conversations, which renames the thread it
 * lands in. A thread the map does not hold at all (search, another folder) is
 * left standing — absence there is not evidence the conversation shrank.
 *
 * `held`: the `account|mailbox|uid` keys the list leaves out because a saved
 * view holds them ("hide view mail"), or null. A member the list holds back
 * for that reason, and the folder still holds (`emails`, `sentEmails`,
 * `localEmails`), has not left the conversation: it stays in the reader, so
 * the message a word was just added to a view from is not closed under you.
 */
export function refreshSelectedThread(state, threads, held = null) {
  const open = state.selectedThread;
  if (!open || !threads?.size) return null;
  let fresh = threads.get(open.threadId);
  if (!fresh) {
    const wanted = new Set((open.emails || []).map(memberKey));
    for (const thread of threads.values()) {
      if (thread.emails.some(e => wanted.has(memberKey(e)))) { fresh = thread; break; }
    }
  }
  if (fresh && held?.size) {
    const present = new Set(fresh.emails.map(memberKey));
    const keyOf = e => { const id = rowIdentity(e, state); return id && `${id.accountId}|${id.mailbox}|${id.uid}`; };
    let pool = null;
    const kept = (open.emails || []).filter(e => {
      if (present.has(memberKey(e))) return false;
      const key = keyOf(e);
      if (!key || !held.has(key)) return false;
      // Held, and still in the folder's own rows. A stale membership answer
      // must not bring back a message another client deleted or moved: the
      // raw pool, before any list filtering, is where the folder says so.
      pool ??= new Set([...(state.emails || []), ...(state.sentEmails || []), ...(state.localEmails || [])]
        .map(keyOf).filter(Boolean));
      return pool.has(key);
    });
    if (kept.length) {
      const time = e => new Date(e.date || e.internalDate || 0).getTime() || 0;
      // Oldest first, as buildThreads orders a thread's messages.
      const emails = [...fresh.emails, ...kept].sort((a, b) => time(a) - time(b));
      const lastEmail = emails.reduce((a, b) => (time(b) > time(a) ? b : a));
      fresh = { ...fresh, emails, lastEmail, messageCount: emails.length };
    }
  }
  // Same members = same reader. buildThreads runs on every list change and
  // hands back fresh objects each time; swapping one in for an identical one
  // only re-renders the pane and re-keys its body loader.
  if (!fresh || fresh === open || memberKeys(fresh.emails) === memberKeys(open.emails)) return null;
  const selectedWasOpen = open.emails.some(email => selectionKey(email, state) === state.selectedEmailId);
  const selectedStillPresent = fresh.emails.some(email => selectionKey(email, state) === state.selectedEmailId);
  if (selectedWasOpen && !selectedStillPresent) {
    return { selectedThread: fresh, selectedEmailId: selectionKey(fresh.lastEmail, state) };
  }
  return { selectedThread: fresh };
}
