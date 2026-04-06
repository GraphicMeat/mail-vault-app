// ── messageListSlice — email list, sorting, pagination, loading ──
// Large async orchestration functions are extracted to src/services/workflows/.
// This slice contains state, pure synchronous derivations, and passthrough wrappers.

import { useSettingsStore } from '../settingsStore';
import { buildThreads } from '../../utils/emailParser';
import {
  loadEmails as _loadEmails,
  _loadEmailsViaGraph,
  loadSentHeaders as _loadSentHeaders,
} from '../../services/workflows/loadEmails';
import {
  loadMoreEmails as _loadMoreEmails,
  loadEmailRange as _loadEmailRange,
} from '../../services/workflows/loadMoreEmails';

// Module-level flag change counter — used in updateSortedEmails fingerprint
let _flagChangeCounter = 0;

// Module-level cache for getChatEmails() — avoids calling set() during render
let _chatEmailsCache = [];
let _chatEmailsFingerprint = '';

// Module-level cache for getThreads() — avoids rebuilding threads on every call
let _threadsCache = new Map();
let _threadsFingerprint = '';

// Module-level loadMore dedup timer
let _loadMoreTimer = null;

// Module-level loadEmails generation counter — prevents stale concurrent calls
let _loadEmailsGeneration = 0;
// Module-level retry flag — prevents infinite retry loops on persistent errors
let _loadEmailsRetried = false;

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
  _chatEmailsFingerprint = '';
  _threadsFingerprint = '';
}

export const createMessageListSlice = (set, get) => ({
  // Emails
  emails: [],
  localEmails: [],
  savedEmailIds: new Set(),
  archivedEmailIds: new Set(),
  serverUidSet: new Set(), // Full set of UIDs known to exist on the IMAP server

  // Pre-sorted emails for performance (memoization)
  sortedEmails: [],

  // Sent folder headers for chat view (merged with INBOX for conversations)
  sentEmails: [],

  // Pagination
  currentPage: 1,
  hasMoreEmails: true,
  totalEmails: 0,

  // Track which ranges have been loaded
  loadedRanges: [], // Array of {start, end} objects
  // Loading state for specific ranges
  loadingRanges: new Set(), // Set of "start-end" strings

  // Update sorted emails (memoization for performance) — pure synchronous derivation
  updateSortedEmails: () => {
    const { emails, localEmails, viewMode, savedEmailIds, archivedEmailIds, serverUidSet, unifiedInbox, activeAccountId, activeMailbox, _sortedEmailsFingerprint } = get();

    // Fingerprint check: skip if the input set hasn't materially changed
    const fp = `${activeAccountId}-${activeMailbox}-${viewMode}-${emails.length}-${emails[0]?.uid || 0}-${emails[emails.length - 1]?.uid || 0}-${localEmails.length}-${archivedEmailIds.size}-${savedEmailIds.size}-${serverUidSet.size}-${_flagChangeCounter}`;
    if (fp === _sortedEmailsFingerprint) return;

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
          e.source = serverUidSet.has(e.uid) ? 'local' : 'local-only';
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
          localEmail.source = serverUidSet.has(localEmail.uid) ? 'local' : 'local-only';
          result.push(localEmail);
        }
      }
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

    // Detect sender impersonation
    if (linkSafetyEnabled) {
      for (const e of result) {
        if (e._senderAlert !== undefined) continue;
        const name = (e.from?.name || '').replace(/^["\\]+|["\\]+$/g, '').replace(/\\"/g, '"').trim();
        const addr = (e.from?.address || '').toLowerCase();
        if (!name || !addr) continue;
        const nameLower = name.toLowerCase();
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name) && nameLower !== addr) {
          const nameDomain = nameLower.split('@')[1] || '';
          const addrDomain = addr.split('@')[1] || '';
          if (nameDomain !== addrDomain && !addrDomain.endsWith('.' + nameDomain) && !nameDomain.endsWith('.' + addrDomain)) {
            e._senderAlert = 'red';
          }
        }
        else if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(nameLower)) {
          const senderDomain = addr.split('@')[1] || '';
          if (nameLower !== senderDomain && !senderDomain.endsWith('.' + nameLower) && !nameLower.endsWith('.' + senderDomain)) {
            e._senderAlert = 'yellow';
          }
        }
      }
    }

    _chatEmailsFingerprint = '';
    _threadsFingerprint = '';
    set({ sortedEmails: result, _sortedEmailsFingerprint: fp });
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
    const { mailboxes } = get();
    const findSent = (boxes) => {
      for (const box of boxes) {
        if (box.specialUse === '\\Sent') return box.path;
        if (box.children?.length > 0) {
          const found = findSent(box.children);
          if (found) return found;
        }
      }
      return null;
    };
    return findSent(mailboxes);
  },

  // Get merged INBOX + Sent emails for chat view (memoized via module-level cache)
  getChatEmails: () => {
    const { sortedEmails, sentEmails, archivedEmailIds, viewMode } = get();

    const { activeAccountId, activeMailbox } = get();
    const fp = `${activeAccountId}-${activeMailbox}-${viewMode}-${sortedEmails.length}-${sortedEmails[0]?.uid || 0}-${sortedEmails[sortedEmails.length - 1]?.uid || 0}-${sentEmails.length}-${sentEmails[0]?.uid || 0}-${_flagChangeCounter}-${archivedEmailIds.size}`;
    if (fp === _chatEmailsFingerprint && _chatEmailsCache.length > 0) return _chatEmailsCache;

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
      if (email.messageId && seen.has(email.messageId)) continue;
      if (email.messageId) seen.add(email.messageId);
      email._fromSentFolder = true;
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
