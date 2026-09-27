// ── The thread a compose pane shows beside a reply ──────────────────────────
//
// The same thread the list shows for the replied message, so an INBOX (or All
// inboxes) conversation carries the Sent replies the list merges in. Cheapest
// source first: the reader's open thread, then the list's memoized threads,
// then the folder window. A message the list does not hold (a search hit, a
// restored draft after a folder switch) stands alone, or with the thread its
// reply was started from.

import { buildThreads, normalizeMessageId } from './emailParser';
import { mergesSentIntoThreads } from './sentFolder';
import { emailKey, emailScopeKey } from '../stores/slices/unifiedHelpers';

/** `{ thread, openKey }` for ThreadView, or null without a replied message. */
export function resolveOriginalThread(replyTo, state) {
  if (!replyTo) return null;
  // Message-ID first, canonical (a body and its header can spell it apart).
  // The folder only when the message names it: a fetched body carries its
  // account but no `_mailbox`, and guessing the open folder would match
  // whatever row there shares the uid.
  const id = normalizeMessageId(replyTo.messageId || replyTo.message_id);
  const target = replyTo._mailbox ? emailScopeKey(replyTo, state) : null;
  const same = e => (!!id && normalizeMessageId(e.messageId || e.message_id) === id)
    || (!!target && emailScopeKey(e, state) === target);
  const found = thread => {
    const member = thread?.emails?.find(same);
    return member ? { thread, openKey: emailKey(member) } : null;
  };

  const open = found(state?.selectedThread);
  if (open) return open;
  const pool = mergesSentIntoThreads(state) && state.getChatEmails ? state.getChatEmails() : state?.sortedEmails;
  if (pool?.some(same)) {
    const threads = mergesSentIntoThreads(state) && state.getThreads ? state.getThreads() : buildThreads(pool);
    for (const thread of threads.values()) {
      const hit = found(thread);
      if (hit) return hit;
    }
  }

  // The reply already holds these bodies (replyTarget): ThreadView shows them
  // as they are instead of waiting on a loader that may not find the folder.
  const emails = (replyTo._threadContext?.length ? replyTo._threadContext : [replyTo])
    .map(e => (e.html || e.text ? { ...e, _bodyLoaded: true } : e));
  return {
    thread: { threadId: `compose-original:${emailKey(replyTo)}`, subject: replyTo.subject || '', emails, messageCount: emails.length },
    openKey: emailKey(replyTo),
  };
}
