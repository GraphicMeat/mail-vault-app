// ── messageListSlice — email list, sorting, pagination, loading ──
// Large async orchestration functions are extracted to src/services/workflows/.
// This slice contains state, pure synchronous derivations, and passthrough wrappers.

import * as api from '../../services/api';
import { useSettingsStore } from '../settingsStore';
import { buildThreads } from '../../utils/emailParser';
import { detectReplyToMismatch } from '../../utils/replyToCheck';
import { NO_SERVER_UIDS } from './serverUids';
import {
  loadEmails as _loadEmails,
  _loadEmailsViaGraph,
  loadSentHeaders as _loadSentHeaders,
} from '../../services/workflows/loadEmails';
import {
  loadMoreEmails as _loadMoreEmails,
  loadEmailRange as _loadEmailRange,
} from '../../services/workflows/loadMoreEmails';
import { findSentMailboxPath } from '../../utils/sentFolder';

// Module-level flag change counter — used in updateSortedEmails fingerprint
let _flagChangeCounter = 0;

// Module-level cache for getChatEmails() — avoids calling set() during render
let _chatEmailsCache = [];
let _chatEmailsFingerprint = '';

// Module-level cache for getThreads() — avoids rebuilding threads on every call
let _threadsCache = new Map();
let _threadsFingerprint = '';

// The exact input collections the last updateSortedEmails() ran on, compared by
// identity. The string fingerprint below can only summarise a Set or an array
// by its size, so a collection whose CONTENTS changed while its size did not is
// invisible to it — and the store hands out fresh instances on every write, so
// identity catches exactly that case for free. See the guard for the bug this
// let through.
let _sortedInputs = null;

// Module-level loadMore dedup timer
let _loadMoreTimer = null;

// Module-level loadEmails generation counter — prevents stale concurrent calls
let _loadEmailsGeneration = 0;
// Module-level retry flag — prevents infinite retry loops on persistent errors
let _loadEmailsRetried = false;

// Module-level refreshBackedUpUids generation counter — same shape as
// _loadEmailsGeneration: an older scan can resolve after a newer one starts
// (account/mailbox switched again before backupScanUids returned), and
// applying its answer would silently mislabel the account now on screen.
let _backedUpGeneration = 0;

// ── AbortController for progressive loading — cancels background loading on switch ──
let _loadAbortController = null;

// ── Network retry scheduler ────────────────────────────────────────
// Retry sequence: immediate -> 3s -> 6s -> 12s -> 30s -> 60s -> wait for 'online'
const _RETRY_DELAYS_MS = [0, 3000, 6000, 12000, 30000, 60000];
let _networkRetryTimer = null;
let _networkRetryStep = 0;

// Expose for accountSlice and facade event listeners
export function _scheduleNetworkRetry(useMailStoreRef) {
  if (_networkRetryTimer) clearTimeout(_networkRetryTimer);
  const delay = _RETRY_DELAYS_MS[Math.min(_networkRetryStep, _RETRY_DELAYS_MS.length - 1)];
  _networkRetryStep++;
  console.log('[mailStore] Retry scheduled in %dms (step %d)', delay, _networkRetryStep);
  _networkRetryTimer = setTimeout(() => {
    _networkRetryTimer = null;
    const { activeAccountId, activeMailbox, activateAccount } = useMailStoreRef.getState();
    if (activeAccountId) activateAccount(activeAccountId, activeMailbox || 'INBOX');
  }, delay);
}

export function _resetNetworkRetry() {
  if (_networkRetryTimer) clearTimeout(_networkRetryTimer);
  _networkRetryTimer = null;
  _networkRetryStep = 0;
}

// Expose for workflows
export function getLoadAbortController() { return _loadAbortController; }
export function setLoadAbortController(ctrl) { _loadAbortController = ctrl; }
export function getLoadMoreTimer() { return _loadMoreTimer; }
export function setLoadMoreTimer(timer) { _loadMoreTimer = timer; }
export function getLoadEmailsGeneration() { return _loadEmailsGeneration; }
export function bumpLoadEmailsGeneration() { return ++_loadEmailsGeneration; }
export function getLoadEmailsRetried() { return _loadEmailsRetried; }
export function setLoadEmailsRetried(v) { _loadEmailsRetried = v; }
export function bumpFlagChangeCounter() { _flagChangeCounter++; }
export function invalidateChatAndThreadCaches() {
  _chatEmailsCache = [];
  _chatEmailsFingerprint = '';
  _threadsCache = new Map();
  _threadsFingerprint = '';
}

export const createMessageListSlice = (set, get) => ({
  // Emails
  emails: [],
  localEmails: [],
  savedEmailIds: new Set(),
  archivedEmailIds: new Set(),
  // The uids the server is known to hold, bound to whether that set is a
  // COMPLETE enumeration of the active mailbox. Window-derived and cleared
  // sets are incomplete. Absence from an incomplete set means "not seen yet",
  // never "not on the server" — deriving `local-only` from one made every
  // archived row read "deleted from server" for the whole account-switch
  // paint. See slices/serverUids.js for why the two travel together.
  serverUids: NO_SERVER_UIDS,

  // Uids present in the external backup mirror, keyed "<accountId>:<uid>".
  // null means "could not determine" — no backup location, or the drive is not
  // connected. Never conflate that with an empty Set, which is the positive
  // claim that nothing in this mailbox is mirrored.
  //
  // Keyed by account on purpose: archivedEmailIds is a flat uid Set and
  // collides across accounts in unified inbox. Not repeating that here.
  backedUpKeys: null,

  // Pre-sorted emails for performance (memoization)
  sortedEmails: [],

  // Sent folder headers for chat view (merged with INBOX for conversations)
  sentEmails: [],

  // Pagination
  currentPage: 1,
  hasMoreEmails: true,
  totalEmails: 0,

  // How many of `totalEmails` the local sidecar cache holds. Only grows for a
  // given mailbox, which is what makes it safe to show as progress — `emails`
  // is a window onto the cache and moves in both directions.
  cachedCount: 0,

  // Track which ranges have been loaded
  loadedRanges: [], // Array of {start, end} objects
  // Loading state for specific ranges
  loadingRanges: new Set(), // Set of "start-end" strings

  // Update sorted emails (memoization for performance) — pure synchronous derivation
  updateSortedEmails: () => {
    const { emails, localEmails, viewMode, savedEmailIds, archivedEmailIds, serverUids, unifiedInbox, activeAccountId, activeMailbox, deleteTombstones, _sortedEmailsFingerprint } = get();

    // Fingerprint check: skip if the input set hasn't materially changed.
    //
    // The string alone is not enough to decide that. It describes every
    // collection by its size, so two different one-element Sets look identical
    // to it — and that really happens during a folder switch, where the sets
    // arrive in stages: a derivation can run with `localEmails` already holding
    // this folder's message while `archivedEmailIds` still holds the previous
    // view's single uid, produce nothing (the uids don't match), and store this
    // exact fingerprint. When the correct set lands a moment later — same size,
    // different uid — the string matches and the recompute is skipped, so the
    // row never appears at all. Seen after a reload as an archived,
    // server-deleted message that would not come back as "Local only" even
    // though the store and the Maildir both had everything needed to render it.
    //
    // Identity closes that hole at O(1): every write replaces these with fresh
    // instances, so a changed collection is always a changed reference. Keep
    // the string too — it still catches in-place growth and the scalar inputs.
    const sameInputs = _sortedInputs !== null
      && _sortedInputs.emails === emails
      && _sortedInputs.localEmails === localEmails
      && _sortedInputs.archivedEmailIds === archivedEmailIds
      && _sortedInputs.savedEmailIds === savedEmailIds
      && _sortedInputs.serverUids === serverUids
      && _sortedInputs.deleteTombstones === deleteTombstones;
    const fp = `${activeAccountId}-${activeMailbox}-${viewMode}-${emails.length}-${emails[0]?.uid || 0}-${emails[emails.length - 1]?.uid || 0}-${localEmails.length}-${archivedEmailIds.size}-${savedEmailIds.size}-${serverUids.uids.size}-${serverUids.complete}-${_flagChangeCounter}-${deleteTombstones?.size || 0}`;
    if (fp === _sortedEmailsFingerprint && sameInputs) return;

    // In unified inbox, UIDs collide across accounts — use compound key for dedup
    const uidKey = unifiedInbox
      ? (e) => `${e._accountId || ''}:${e.uid}`
      : (e) => e.uid;

    let result = [];

    if (viewMode === 'server') {
      for (const e of emails) {
        e.isLocal = false;
        e.isArchived = false;
        e.source = 'server';
      }
      result = emails;
    } else if (viewMode === 'local') {
      result = [];
      for (const e of localEmails) {
        if (archivedEmailIds.has(e.uid)) {
          e.isLocal = true;
          e.isArchived = true;
          e.source = !serverUids.complete || serverUids.uids.has(e.uid) ? 'local' : 'local-only';
          result.push(e);
        }
      }
    } else {
      const loadedKeys = new Set(emails.map(e => uidKey(e)));
      for (const e of emails) {
        e.isLocal = savedEmailIds.has(e.uid);
        e.isArchived = archivedEmailIds.has(e.uid);
        e.source = 'server';
      }
      result = [...emails];

      for (const localEmail of localEmails) {
        if (!loadedKeys.has(uidKey(localEmail)) && archivedEmailIds.has(localEmail.uid)) {
          localEmail.isLocal = true;
          localEmail.isArchived = true;
          localEmail.source = !serverUids.complete || serverUids.uids.has(localEmail.uid) ? 'local' : 'local-only';
          result.push(localEmail);
        }
      }
    }

    // Hide messages the server flagged \Deleted but hasn't expunged yet. They
    // still count in EXISTS, so the list total can read one or two higher than
    // the rows shown. Archived copies stay visible — the local vault outranks
    // the server's opinion about a message it hasn't actually removed.
    result = result.filter(e => e.isArchived || !e.flags?.includes('\\Deleted'));

    // Drop tombstoned (deleted-but-not-yet-reconciled) emails — stale cache
    // hydration on account/folder switch must not resurrect them.
    if (deleteTombstones?.size) {
      result = result.filter(e => {
        const acct = e._accountId || activeAccountId;
        const mbox = activeMailbox === 'UNIFIED' ? (e._mailbox || 'INBOX') : activeMailbox;
        return !deleteTombstones.has(`${acct}|${mbox}|${e.uid}`);
      });
    }

    // Sort by date descending (newest first)
    for (const e of result) {
      e._ts = new Date(e.date || e.internalDate || 0).getTime();
    }
    result.sort((a, b) => b._ts - a._ts);

    // Apply persisted link safety alerts from settingsStore
    const { linkAlerts, linkSafetyEnabled } = useSettingsStore.getState();
    if (linkAlerts && Object.keys(linkAlerts).length > 0) {
      for (const e of result) {
        if (!e._linkAlert && linkAlerts[e.uid]) {
          e._linkAlert = linkAlerts[e.uid];
        }
      }
    }

    // Detect sender impersonation + reply-to domain mismatch
    if (linkSafetyEnabled) {
      for (const e of result) {
        const addr = (e.from?.address || '').toLowerCase();
        const addrDomain = addr.split('@')[1] || '';

        // Sender impersonation (display name looks like email/domain)
        if (e._senderAlert === undefined && addr) {
          const name = (e.from?.name || '').replace(/^["\\]+|["\\]+$/g, '').replace(/\\"/g, '"').trim();
          if (name) {
            const nameLower = name.toLowerCase();
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name) && nameLower !== addr) {
              const nameDomain = nameLower.split('@')[1] || '';
              if (nameDomain !== addrDomain && !addrDomain.endsWith('.' + nameDomain) && !nameDomain.endsWith('.' + addrDomain)) {
                e._senderAlert = 'red';
              }
            }
            else if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(nameLower)) {
              if (nameLower !== addrDomain && !addrDomain.endsWith('.' + nameLower) && !nameLower.endsWith('.' + addrDomain)) {
                e._senderAlert = 'yellow';
              }
            }
          }
        }

        // Reply-To domain mismatch: common phishing signal — legit bulk
        // senders usually route replies to the same domain (or a subdomain)
        // they send from. Detection lives in utils/replyToCheck.js so it's
        // unit-testable and can be shared by other consumers later.
        if (e._replyToMismatch === undefined) {
          const mismatch = detectReplyToMismatch(e);
          if (mismatch) e._replyToMismatch = mismatch;
        }
      }
    }

    _chatEmailsFingerprint = '';
    _threadsFingerprint = '';
    _sortedInputs = { emails, localEmails, archivedEmailIds, savedEmailIds, serverUids, deleteTombstones };
    set({ sortedEmails: result, _sortedEmailsFingerprint: fp });
  },

  // Rescan the external backup mirror for the active view (or every account,
  // in unified inbox) and rebuild backedUpKeys from scratch.
  refreshBackedUpUids: async () => {
    const generation = ++_backedUpGeneration;
    // Guarded setter — an older in-flight call resolving after a newer one
    // must drop its result on the floor instead of clobbering it.
    const commit = (backedUpKeys) => {
      if (generation === _backedUpGeneration) set({ backedUpKeys });
    };

    const { activeAccountId, activeMailbox, unifiedInbox, accounts, unifiedFolder } = get();
    const targets = unifiedInbox
      ? (accounts || []).map(a => ({ id: a.id, email: a.email, mailbox: unifiedFolder || 'INBOX' }))
      : (() => {
          const a = (accounts || []).find(x => x.id === activeAccountId);
          return a && activeMailbox ? [{ id: a.id, email: a.email, mailbox: activeMailbox }] : [];
        })();

    // No resolvable target (e.g. mid account-switch) is itself a
    // can't-determine case — it must not leave a different account's answer
    // sitting there looking current.
    if (!targets.length) { commit(null); return; }

    const keys = new Set();
    for (const t of targets) {
      let uids;
      try {
        uids = await api.backupScanUids(t.email, t.mailbox);
      } catch (e) {
        console.warn('[refreshBackedUpUids] backupScanUids failed:', e);
        uids = null;
      }
      // One unreadable target makes the whole answer unknown. A partial set
      // would render "not backed up" for accounts we simply could not scan.
      if (uids === null) { commit(null); return; }
      for (const uid of uids) keys.add(`${t.id}:${uid}`);
    }
    commit(keys);
  },

  // ── Passthrough wrappers to workflow functions ──

  loadEmails: () => _loadEmails(),
  _loadEmailsViaGraph: (account, activeAccountId, activeMailbox, generation) => _loadEmailsViaGraph(account, activeAccountId, activeMailbox, generation),
  loadMoreEmails: () => _loadMoreEmails(),
  loadEmailRange: (startIndex, endIndex) => _loadEmailRange(startIndex, endIndex),
  loadSentHeaders: (accountId) => _loadSentHeaders(accountId),

  // ── Pure synchronous derivations (stay inline) ──

  isIndexLoaded: (index) => {
    const { loadedRanges } = get();
    for (const range of loadedRanges) {
      if (index >= range.start && index < range.end) return true;
    }
    return false;
  },

  getEmailAtIndex: (index) => {
    const { emails } = get();
    return emails[index] || null;
  },

  getCombinedEmails: () => {
    return get().sortedEmails;
  },

  getSentMailboxPath: () => {
    const { mailboxes, accounts, activeAccountId } = get();
    const active = (accounts || []).find(a => a.id === activeAccountId);
    return findSentMailboxPath(mailboxes, active?.sentFolderOverride || null);
  },

  // Get merged INBOX + Sent emails for chat view (memoized via module-level cache)
  getChatEmails: () => {
    const { sortedEmails, sentEmails, archivedEmailIds, viewMode } = get();

    const { activeAccountId, activeMailbox } = get();
    const fp = `${activeAccountId}-${activeMailbox}-${viewMode}-${sortedEmails.length}-${sortedEmails[0]?.uid || 0}-${sortedEmails[sortedEmails.length - 1]?.uid || 0}-${sentEmails.length}-${sentEmails[0]?.uid || 0}-${_flagChangeCounter}-${archivedEmailIds.size}`;
    if (fp === _chatEmailsFingerprint && _chatEmailsCache.length > 0) return _chatEmailsCache;

    // Stamp the folder each message came from. This list mixes two mailboxes,
    // and UIDs only identify a message within one — without the tag, readers
    // downstream (body loader, delete, attachments) have to guess from the
    // active view and can land on a different message with the same UID.
    // `_srcAccountId` (not `_accountId`) because the UI treats `_accountId` as
    // "came from the unified list" and paints an account dot for it.
    // Unified lists span accounts and already carry `_accountId`/`_mailbox`;
    // stamping the active account over them would be a lie.
    const sentPath = get().getSentMailboxPath();
    if (activeMailbox && activeMailbox !== 'UNIFIED') {
      for (const email of sortedEmails) {
        if (!email._mailbox) email._mailbox = activeMailbox;
        if (activeAccountId && !email._srcAccountId) email._srcAccountId = activeAccountId;
      }
    }

    if (sentEmails.length === 0) {
      _chatEmailsCache = sortedEmails;
      _chatEmailsFingerprint = fp;
      return sortedEmails;
    }

    const seen = new Set();
    const merged = [];

    for (const email of sortedEmails) {
      if (email.messageId) seen.add(email.messageId);
      merged.push(email);
    }

    for (const email of sentEmails) {
      // Only merge sent emails from the active account to prevent cross-account thread contamination
      if (activeAccountId && email._accountId && email._accountId !== activeAccountId) continue;
      if (email.messageId && seen.has(email.messageId)) continue;
      if (email.messageId) seen.add(email.messageId);
      email._fromSentFolder = true;
      if (!email._mailbox && sentPath) email._mailbox = sentPath;
      merged.push(email);
    }

    for (const e of merged) {
      if (e._ts === undefined) e._ts = new Date(e.date || e.internalDate || 0).getTime();
    }
    merged.sort((a, b) => b._ts - a._ts);

    _chatEmailsCache = merged;
    _chatEmailsFingerprint = fp;
    return merged;
  },

  // Build threads from merged INBOX + Sent emails using RFC header chains (memoized)
  getThreads: () => {
    const chatEmails = get().getChatEmails();
    const { viewMode } = get();
    const fp = `${viewMode}-${chatEmails.length}-${chatEmails[0]?.uid || 0}-${chatEmails[chatEmails.length - 1]?.uid || 0}-${_flagChangeCounter}`;
    if (fp === _threadsFingerprint && _threadsCache.size > 0) {
      return _threadsCache;
    }
    const threads = buildThreads(chatEmails);
    _threadsCache = threads;
    _threadsFingerprint = fp;
    return threads;
  },
});
