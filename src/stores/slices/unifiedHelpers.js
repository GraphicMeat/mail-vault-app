import { t } from '../../i18n/index.js';
// ── Shared helpers used across multiple mail store slices ──

// ── RestoreDescriptor builder ─────────────────────────────────────────────
// Captures a compact snapshot of the first ~50 visible headers for instant
// restore on account/mailbox switch. Called on every switch-away.
export function _buildRestoreDescriptor(state, mailbox, { topVisibleIndex = 0 } = {}) {
  const effectiveMailbox = mailbox || state.activeMailbox || 'INBOX';
  const sorted = state.sortedEmails || state.emails || [];
  return {
    accountId: state.activeAccountId,
    mailbox: effectiveMailbox,
    viewMode: state.viewMode || 'all',
    totalEmails: state.totalEmails || sorted.length,
    topVisibleIndex,
    selectedUid: state.selectedEmailId || null,
    mailboxes: state.mailboxes || [],
    mailboxesFetchedAt: state.mailboxesFetchedAt || null,
    firstWindow: sorted.slice(0, 50),
    firstWindowSavedUids: sorted.slice(0, 50)
      .filter(e => state.savedEmailIds?.has(e.uid))
      .map(e => e.uid),
    firstWindowArchivedUids: sorted.slice(0, 50)
      .filter(e => state.archivedEmailIds?.has(e.uid))
      .map(e => e.uid),
    // Carried whole, completeness included. Snapshotting the uids without it
    // was the same mistake as splitting them in the store: every restore
    // paint then had to reset completeness to false, and the probe's
    // "unchanged" verdict can never re-prove an enumeration — so the reset
    // survived every switch back and the amber state became unreachable.
    serverUids: state.serverUids,
    timestamp: Date.now(),
  };
}

// ── Unified inbox helpers ───────────────────────────────────────────────────

// Resolve real account + mailbox for a UID in unified inbox mode.
// Unified inbox emails carry _accountId/_accountEmail/_mailbox; resolve the real context.
// Searches emails, sortedEmails, and localEmails to handle eviction/race conditions.
export function _resolveUnifiedContext(key, state) {
  // Support composite selection key "accountId:uid" to avoid cross-account UID collisions
  let email;
  const parsed = _parseSelKey(key);

  // Search across multiple lists — email may have been evicted from one but remain in another
  const searchLists = [state.emails, state.sortedEmails, state.localEmails, state.sentEmails].filter(Boolean);
  for (const list of searchLists) {
    if (parsed.accountId) {
      // The key names the folder too: the same account's INBOX and Sent rows
      // share uids, and only one of them is this key.
      email = list.find(e => e._accountId === parsed.accountId && e.uid === parsed.uid
        && (parsed.mailbox == null || (e._mailbox ?? '') === parsed.mailbox));
    } else {
      email = list.find(e => e.uid === key);
    }
    if (email?._accountId) break;
  }

  if (!email?._accountId) return null;
  const account = state.accounts.find(a => a.id === email._accountId);
  if (!account) return null;
  // Determine the actual mailbox: use _mailbox if tagged, detect sent emails, fall back to INBOX
  let mailbox = email._mailbox || 'INBOX';
  if (!email._mailbox && email._isSent) {
    // Try to find the Sent folder name from the account's mailboxes
    const sentFolder = state.mailboxes?.find(m =>
      m.name?.toLowerCase() === 'sent' || m.name?.toLowerCase() === 'sent items' ||
      m.special_use === '\\Sent'
    );
    mailbox = sentFolder?.name || 'Sent';
  }
  // Final safety: never return 'UNIFIED' as a real mailbox
  if (mailbox === 'UNIFIED') mailbox = 'INBOX';
  return { account, accountId: email._accountId, mailbox, uid: email.uid };
}

/**
 * The context a server mutation in a spanning view may act on — or a thrown
 * error. Every `unified?.accountId || state.activeAccountId` fallback aimed a
 * mutation at the ACTIVE account's INBOX under the raw uid when a row could not
 * be resolved; for a delete that is the wrong message on the wrong server. A
 * full key still names its account and folder after the row has left the lists
 * (evicted, already pruned), so that case proceeds on what the key says.
 */
export function requireUnifiedContext(key, state) {
  const ctx = _resolveUnifiedContext(key, state);
  if (ctx) return ctx;
  const parsed = _parseSelKey(key);
  if (parsed.accountId && parsed.mailbox) {
    const account = state.accounts.find(a => a.id === parsed.accountId);
    if (account) {
      const mailbox = parsed.mailbox === 'UNIFIED' ? 'INBOX' : parsed.mailbox;
      return { account, accountId: parsed.accountId, mailbox, uid: parsed.uid };
    }
  }
  throw new Error(`Cannot tell which account and folder hold message ${key}; reload the list and try again`);
}

// ── Message location ───────────────────────────────────────────────────────
// A UID identifies a message only within one (account, mailbox) pair — the same
// number is a different message in every other folder and account. Resolve a
// message's location from the message itself, never from the active view: the
// view drifts during account/folder switches, and a wrong guess does not fail,
// it silently reads a real but unrelated message (someone else's mail rendered
// under this header). Unknown location returns null — no body beats wrong body.
export function resolveEmailLocation(email, state) {
  if (!email || !state) return null;
  const accountId = email._accountId || email._srcAccountId || state.activeAccountId;
  if (!accountId) return null;

  let mailbox = email._mailbox;
  // Only the active account's folder paths are known from view state; a foreign
  // account's untagged message stays unresolved rather than guessing 'INBOX'.
  if (!mailbox && accountId === state.activeAccountId) {
    mailbox = email._fromSentFolder ? state.getSentMailboxPath?.() : state.activeMailbox;
  }
  if (!mailbox || mailbox === 'UNIFIED') return null;

  return { accountId, mailbox };
}

/**
 * `accountId-mailbox-uid` for a message, resolved through the view state — the
 * same shape selectEmail uses for its body cache. A bare UID is not a key: the
 * same number is a different message in every other folder/account, so keying
 * by UID alone lets one message's state be served to another's.
 *
 * Returns null when the location can't be resolved (foreign account with no
 * mailbox tag, unified placeholder). Callers must treat null as "no key" and
 * skip the lookup rather than fall back to the UID — a wrong hit is worse than
 * a miss for anything that warns the user.
 */
export function emailScopeKey(email, state) {
  const loc = email && resolveEmailLocation(email, state);
  return loc ? `${loc.accountId}-${loc.mailbox}-${email.uid}` : null;
}

/**
 * Unique key for a message across accounts and mailboxes. A bare UID is not a
 * key: the same number is a different message in every other folder/account,
 * so keying by UID alone lets one view's loaded body be served to another's.
 */
export function emailKey(email) {
  const account = email._accountId || email._srcAccountId || '';
  const mailbox = email._mailbox || (email._fromSentFolder ? 'sent' : '');
  return `${account}|${mailbox}|${email.uid}`;
}

// A body whose Message-ID contradicts the header's is not this message: the
// lookup landed in the wrong mailbox. Missing on either side → can't tell, allow.
export function bodyMatchesHeader(header, body) {
  const headerId = header?.messageId || header?.message_id;
  const bodyId = body?.messageId || body?.message_id;
  if (!headerId || !bodyId) return true;
  return headerId === bodyId;
}

// ── Does this list hold rows from more than one mailbox? ───────────────────
// Two views do: the unified inbox (many accounts, each contributing its INBOX
// and its Sent folder) and a folder subtree (one account, a whole branch).
// Downstream they mean exactly the same thing — a row's location must be read
// off the row, never off activeMailbox — so they answer one question here
// rather than being special-cased apart in twenty places.
export function spansMailboxes(state) {
  return state?.activeMailbox === 'UNIFIED' || !!state?.mailboxScope;
}

// ── Selection key helpers ──────────────────────────────────────────────────
// A key has to name a message, and a uid names one only inside one mailbox of
// one account. `accountId:uid` was not enough: the unified list merges each
// account's INBOX with its Sent folder, so that account's INBOX 34 and Sent 34
// shared a key — the same mistake as reading a search hit's uid against the
// selected folder, one level down.
//
// Format is `accountId:mailbox:uid`. accountId is a UUID and uid is digits, so
// reading the accountId from the left and the uid from the right leaves the
// whole middle to the mailbox — which may itself contain a colon.
export function _selKey(email) {
  if (!email._accountId) return `${email.uid}`;
  return `${email._accountId}:${email._mailbox ?? ''}:${email.uid}`;
}

export function _parseSelKey(key) {
  const s = String(key);
  const first = s.indexOf(':');
  // A bare uid is the single-folder list's key. Numeric, so it compares equal
  // to the uid on the row rather than to its string form.
  if (first <= 0) return { accountId: null, mailbox: null, uid: /^\d+$/.test(s) ? Number(s) : key };
  const last = s.lastIndexOf(':');
  const rawUid = s.slice(last + 1);
  return {
    accountId: s.slice(0, first),
    // Keys written before the mailbox joined the format have only two parts.
    mailbox: last > first ? s.slice(first + 1, last) : null,
    uid: /^\d+$/.test(rawUid) ? Number(rawUid) : rawUid,
  };
}

// ── The OPEN message ───────────────────────────────────────────────────────
// `selectedEmailId` names one row. In a single-folder list a uid does that; in
// a list spanning mailboxes it does not, so the id is the full key there. Every
// reader has to ask the same question, or one of them silently never matches —
// which is how j/k navigation came to do nothing in the unified inbox while the
// row highlight worked fine.
export function rowKey(email, spans) {
  return spans ? _selKey(email) : email.uid;
}

// ── The selection key ──────────────────────────────────────────────────────
// What the checkbox writes and every bulk workflow reads back. A list spanning
// mailboxes keys by account, folder and uid. A single folder's list keys by
// bare uid — except for a row it merged in from ANOTHER folder (a Sent copy in
// the INBOX list, which carries `_fromSentFolder` / `_mailbox`), which gets
// the full key: INBOX's own message under that number is a different message,
// and a bare uid cannot say which of the two was ticked. A map keyed by bare
// uid let the Sent copy win that collision, and a delete aimed at the folder's
// own message deleted the Sent one.
export function selectionKey(email, state) {
  if (spansMailboxes(state)) return email._accountId ? _selKey(email) : email.uid;
  const loc = resolveEmailLocation(email, state);
  if (!loc || loc.mailbox === state.activeMailbox) return email.uid;
  return _selKey({ _accountId: loc.accountId, _mailbox: loc.mailbox, uid: email.uid });
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

/**
 * The row `delta` places from the open one, clamped to the ends.
 *
 * An open message that is not in `rows` starts navigation at the top, which is
 * what the caller did before and is right: the unread filter can hide the row
 * you are reading.
 */
export function stepThroughList(rows, currentId, spans, delta) {
  if (!rows?.length) return null;
  const idx = rows.findIndex(e => rowKey(e, spans) === currentId);
  if (idx === -1) return rows[0];
  return rows[Math.min(Math.max(idx + delta, 0), rows.length - 1)] ?? null;
}

// ── Unified folder resolution ──────────────────────────────────────────────
// Maps canonical folder IDs to IMAP specialUse flags for cross-provider resolution
export const SPECIAL_USE_MAP = {
  'Sent': '\\Sent',
  'Drafts': '\\Drafts',
  'Trash': '\\Trash',
  'Archive': '\\Archive',
};

// Resolve a canonical folder ID to the actual IMAP mailbox path for a given account.
// Folder names vary by provider (e.g. "Sent" vs "Sent Mail" vs "[Gmail]/Sent Mail").
export function _resolveMailboxPath(accountMailboxes, folderId) {
  if (folderId === 'INBOX') return 'INBOX';
  const specialUse = SPECIAL_USE_MAP[folderId];
  if (!accountMailboxes || !accountMailboxes.length) return folderId;

  const findBox = (boxes) => {
    for (const box of boxes) {
      if (specialUse && (box.specialUse === specialUse || box.special_use === specialUse)) return box.path;
      if (box.name?.toLowerCase() === folderId.toLowerCase()) return box.path;
      if (box.path?.toLowerCase() === folderId.toLowerCase()) return box.path;
      if (box.children?.length) {
        const found = findBox(box.children);
        if (found) return found;
      }
    }
    return null;
  };
  return findBox(accountMailboxes) || folderId;
}

// ── Vault directory names ──────────────────────────────────────────────────
// `maildir_cur_path` (src-tauri/src/main.rs) stores a mailbox under a name with
// every char outside [alphanumeric . - _] replaced by '_'. That mapping is
// many-to-one — "Projekt Nystart" and "Projekt_Nystart" share a directory — so
// a directory name read back off disk is NOT a server mailbox path. SELECTing
// it fails, or worse lands somewhere else. Recover the real path by sanitising
// the mailbox paths the server told us about and matching.
// Rust's `char::is_alphanumeric` is Unicode-aware, so this regex must be too:
// an "Entwürfe" folder is not stored as "Entw_rfe".
const VAULT_UNSAFE_RE = /[^\p{Alphabetic}\p{N}.\-_]/gu;

export function vaultDirName(mailbox) {
  return String(mailbox ?? '').replace(VAULT_UNSAFE_RE, '_');
}

export function flattenMailboxes(mailboxes, out = []) {
  for (const box of mailboxes || []) {
    if (box?.path) out.push(box);
    if (box?.children?.length) flattenMailboxes(box.children, out);
  }
  return out;
}

// dir name → the server mailbox path that produced it. Unknown dirs come back
// as themselves: a stale vault folder for a mailbox the server no longer lists
// still has readable mail in it, and reading is all this name is used for.
// Ambiguity resolves to the first match, which is the only honest option — the
// sanitiser threw the distinguishing character away.
export function mailboxPathFromVaultDir(dir, mailboxes) {
  if (!dir) return dir;
  for (const box of flattenMailboxes(mailboxes)) {
    if (vaultDirName(box.path) === dir) return box.path;
  }
  return dir;
}
