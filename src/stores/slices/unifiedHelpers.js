// ── Shared helpers used across multiple mail store slices ──

// ── RestoreDescriptor builder ─────────────────────────────────────────────
// Captures a compact snapshot of the first ~50 visible headers for instant
// restore on account/mailbox switch. Called on every switch-away.
export function _buildRestoreDescriptor(state, mailbox) {
  const effectiveMailbox = mailbox || state.activeMailbox || 'INBOX';
  const sorted = state.sortedEmails || state.emails || [];
  return {
    accountId: state.activeAccountId,
    mailbox: effectiveMailbox,
    viewMode: state.viewMode || 'all',
    totalEmails: state.totalEmails || sorted.length,
    topVisibleIndex: 0,
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
  const searchLists = [state.emails, state.sortedEmails, state.localEmails].filter(Boolean);
  for (const list of searchLists) {
    if (parsed.accountId) {
      email = list.find(e => e._accountId === parsed.accountId && e.uid === parsed.uid);
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

// ── Unified selection key helpers ──────────────────────────────────────────
// In unified mode, prefix selection keys with accountId to avoid cross-account UID collisions
export function _selKey(email) {
  return email._accountId ? `${email._accountId}:${email.uid}` : `${email.uid}`;
}

export function _parseSelKey(key) {
  const s = String(key);
  const i = s.indexOf(':');
  if (i > 0) {
    const rawUid = s.slice(i + 1);
    return { accountId: s.slice(0, i), uid: /^\d+$/.test(rawUid) ? Number(rawUid) : rawUid };
  }
  return { accountId: null, uid: key };
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
