// ── messageListSlice — email list, sorting, pagination, loading ──
// Large async orchestration functions are extracted to src/services/workflows/.
// This slice contains state, pure synchronous derivations, and passthrough wrappers.

import * as api from '../../services/api';
import { useSettingsStore } from '../settingsStore';
import { buildThreads } from '../../utils/emailParser';
import { annotateRowAlerts } from './rowAlerts';
import { NO_SERVER_UIDS } from './serverUids';
import { custodySource } from './custody';
import {
  loadEmails as _loadEmails,
  _loadEmailsViaGraph,
  loadSentHeaders as _loadSentHeaders,
} from '../../services/workflows/loadEmails';
import { loadMoreEmails as _loadMoreEmails } from '../../services/workflows/loadMoreEmails';
import { sentMailboxPathFor } from '../../utils/sentFolder';
import { _resolveMailboxPath, rowIdentity, vaultHas, vaultKey } from './unifiedHelpers';
import { getAccountCacheMailboxes } from '../../services/cacheManager';
import { rowMailbox } from '../../utils/autoTagInboxFilter';
import { rowVisibility } from '../../utils/rowVisibility';
import { useTagStore, requestRowTags } from '../tagStore';
import { useAutoTagStore } from '../autoTagStore';
import { useSnoozeStore, localSnoozeKeys } from '../snoozeStore';
import { recountInbox } from '../unreadCounts';

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

// ── Per-(account,mailbox) archived-id cache ──
//
// `archivedEmailIds` used to be one flat union built by hand at each write
// site, seeded from its own current value so a failed re-read kept whatever
// the store already had. That fallback was the bug: on a failed read it kept
// the WHOLE prior union, including accounts/mailboxes no longer in view. A
// switch out of unified inbox into a single mailbox whose own re-read failed
// left every other account's archived ids sitting in the narrowed view. This
// map is the real source of truth, one entry per (accountId, mailbox);
// `archivedEmailIds` is always re-derived from it, so the ~40 existing
// readers of that field never change.
let _archivedIdsByGroup = new Map();
const _groupKey = (accountId, mailbox) => `${accountId} ${mailbox}`;

// A failed read (`ids == null`) keeps the group's existing entry rather than
// wiping it, the same I-5 rule the old per-call-site fallbacks encoded, now
// enforced once, here.
export function setArchivedGroup(accountId, mailbox, ids) {
  if (ids != null) _archivedIdsByGroup.set(_groupKey(accountId, mailbox), ids);
}

export function getArchivedGroup(accountId, mailbox) {
  return _archivedIdsByGroup.get(_groupKey(accountId, mailbox));
}

// Add one uid to a group without a full re-read (the archive-progress painter).
export function addArchivedGroupUid(accountId, mailbox, uid) {
  const key = _groupKey(accountId, mailbox);
  const existing = _archivedIdsByGroup.get(key);
  if (existing?.has(uid)) return;
  const updated = existing ? new Set(existing) : new Set();
  updated.add(uid);
  _archivedIdsByGroup.set(key, updated);
}

// The union of exactly these (accountId, mailbox) pairs, never every group
// the session has ever read, so a group that left the view stops
// contributing to it. The group cache holds bare uids; the union is KEYED
// (`accountId:mailbox:uid`, vaultKey), because a uid names a message only
// inside its own folder and the union spans accounts and folders.
//
// Returns the SAME Set instance passed in as `currentSet` when nothing
// actually changed: the re-sort guard below short-circuits on Set identity,
// and handing it a fresh-but-equal Set on every group write would force a
// needless re-sort.
export function deriveArchivedUnion(currentSet, pairs) {
  const union = new Set();
  let anyKnown = false;
  for (const [accountId, mailbox] of pairs) {
    const ids = _archivedIdsByGroup.get(_groupKey(accountId, mailbox));
    if (ids) { anyKnown = true; for (const uid of ids) union.add(vaultKey(accountId, mailbox, uid)); }
  }
  // None of the groups in view has ever gone through this map (e.g. this
  // round's own read is a miss, and a failed read skips the write) and
  // `currentSet` was seeded before this group was ever known to the map.
  // There is nothing to narrow FROM, so leave the field alone rather than
  // claiming "nothing is archived", which is the exact bug this map exists
  // to prevent.
  if (!anyKnown) return currentSet;
  if (union.size === currentSet.size && [...union].every(k => currentSet.has(k))) return currentSet;
  return union;
}

// A spanning view (unified inbox, a folder subtree) only ever GROWS as
// accounts/mailboxes come into it; narrowing is handled by whichever writer
// takes the view out of span. So this merges one group's cached ids into the
// existing union rather than re-deriving the whole thing, with the same
// identity discipline as deriveArchivedUnion.
export function mergeArchivedGroup(currentSet, accountId, mailbox) {
  const ids = _archivedIdsByGroup.get(_groupKey(accountId, mailbox));
  if (!ids) return currentSet;
  for (const uid of ids) {
    if (currentSet.has(vaultKey(accountId, mailbox, uid))) continue;
    const merged = new Set(currentSet);
    for (const u of ids) merged.add(vaultKey(accountId, mailbox, u));
    return merged;
  }
  return currentSet;
}

// Test-only: module-level state must not leak between specs.
export function _resetArchivedGroupsForTest() { _archivedIdsByGroup = new Map(); }

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

/**
 * The display-row derivation, exactly as the store runs it.
 *
 * Exported because it used to have a twin: `services/emailListUtils.js`
 * reimplemented this logic for tests only, and drifted — its default was
 * `known = serverUidSet ? !!serverUidsKnown : true`, so omitting the set made
 * it stamp `local-only` with no proof at all, while production (correctly)
 * refuses to. The twin was MORE lenient than production in the one direction
 * that matters, which is why ~47 assertions could pass for months while the
 * real derivation could not reach its amber state. One implementation, one
 * place to be wrong.
 *
 * Mutates the row objects in place and returns them — `updateSortedEmails`'s
 * memo compares by identity, and copying every row on every derivation is what
 * this list cannot afford. Callers own the arrays they pass in.
 */
export function deriveDisplayRows({
  emails = [],
  localEmails = [],
  viewMode = 'all',
  savedEmailIds = new Set(),
  archivedEmailIds = new Set(),
  // Kept in the signature (and in updateSortedEmails' memo key) so a caller
  // cannot quietly stop passing it: custody no longer reads it, but the set
  // still changes what the LIST holds, and callers pass both together.
  serverUids = NO_SERVER_UIDS,
  unifiedInbox = false,
  activeAccountId = null,
  activeMailbox = null,
  deleteTombstones = null,
  // Auto Tags (Phase 4) "hide from Inbox" — both null by default, so a
  // caller that never passes them (most of this file's own tests) gets
  // exactly today's behavior. See isHiddenFromInbox.
  hiddenTagIds = null,
  tagsByRow = null,
  // snoozeStore's localSnoozeKeys: messages a local snooze holds out of the
  // folder they are still in.
  localSnoozes = null,
}) {
  // In unified inbox, UIDs collide across accounts — use compound key for dedup
  const uidKey = unifiedInbox
    ? (e) => `${e._accountId || ''}:${e.uid}`
    : (e) => e.uid;
  // The vault sets are keyed by where a message lives (vaultKey), so a row is
  // looked up by its own folder and account, never by its bare uid.
  const view = { activeAccountId, activeMailbox };
  const vaulted = (set, e) => vaultHas(set, e, view);
  // A row's two vault marks from one placement: this runs per row on every
  // derivation, the flag click's repaint included.
  const vaultKeyOf = (e) => {
    const id = rowIdentity(e, view);
    return id ? vaultKey(id.accountId, id.mailbox, id.uid) : null;
  };

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
      if (vaulted(archivedEmailIds, e)) {
        e.isLocal = true;
        e.isArchived = true;
        e.source = custodySource(e);
        result.push(e);
      }
    }
  } else {
    const loadedKeys = new Set(emails.map(e => uidKey(e)));
    for (const e of emails) {
      const key = vaultKeyOf(e);
      e.isLocal = key !== null && savedEmailIds.has(key);
      e.isArchived = key !== null && archivedEmailIds.has(key);
      e.source = 'server';
    }
    result = [...emails];

    for (const localEmail of localEmails) {
      if (!loadedKeys.has(uidKey(localEmail)) && vaulted(archivedEmailIds, localEmail)) {
        localEmail.isLocal = true;
        localEmail.isArchived = true;
        // Not "missing from this mailbox" — see custodySource. A vault row the
        // server list does not shadow is an ordinary vault row.
        localEmail.source = custodySource(localEmail);
        result.push(localEmail);
      }
    }
  }

  // What the list holds back (\Deleted-not-expunged, auto-tag hidden, deleted
  // and not yet reconciled, locally snoozed) is one rule set, rowVisibility:
  // the Bulk Operations pool asks the same predicate of the cache.
  result = result.filter(rowVisibility({
    activeAccountId, activeMailbox, unifiedInbox, archivedEmailIds,
    deleteTombstones, hiddenTagIds, tagsByRow, localSnoozes,
  }));

  // Sort by date descending (newest first)
  for (const e of result) {
    e._ts = new Date(e.date || e.internalDate || 0).getTime();
  }
  result.sort((a, b) => b._ts - a._ts);
  return result;
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

  // Uids present in the external backup mirror, keyed
  // "<accountId>:<mailbox>:<uid>". null means "could not determine" — no backup
  // location, or the drive is not connected. Never conflate that with an empty
  // Set, which is the positive claim that nothing scanned is mirrored.
  //
  // Keyed by account AND mailbox on purpose. A uid names a message only inside
  // one mailbox, and the INBOX view merges Sent copies into its threads
  // (getChatEmails), so both live in this list at once. Keyed by account alone,
  // Sent uid 4102 matched INBOX's mirror entry 4102 and a message that had
  // never been backed up wore a filled dot. archivedEmailIds is the flat-Set
  // version of the same mistake — not repeating it here.
  backedUpKeys: null,

  // Whether an external backup location is configured at all. `false` says the
  // dot's whole axis does not apply — there is nowhere for a copy to be — and
  // is NOT the same claim as `backedUpKeys === null`, which is a drive that
  // exists and could not be read. `backup_scan_uids` answers null to both,
  // which is why this is asked separately, and only when a scan comes back
  // empty-handed. Without it every message in a vault with no backup drive
  // carried "Backup drive not connected — can't verify", a complaint about a
  // feature the user had never turned on.
  backupConfigured: null,

  // Which "<accountId>:<mailbox>" scopes the last scan actually read. A row
  // outside them has NO answer: absence from backedUpKeys is not evidence about
  // a mailbox nobody opened, and reporting it as "not on the backup drive"
  // would be the same unearned claim the gold row exists to prevent.
  backedUpScopes: null,

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

  // Update sorted emails (memoization for performance) — pure synchronous derivation
  updateSortedEmails: () => {
    const { emails, localEmails, viewMode, savedEmailIds, archivedEmailIds, serverUids, unifiedInbox, activeAccountId, activeMailbox, mailboxScope, deleteTombstones, _sortedEmailsFingerprint } = get();

    // Auto Tags "hide from Inbox" (Phase 4): gated on an actual hide rule
    // existing, so the common case (feature unused) pays nothing extra —
    // no tagStore read, no fingerprint change, no prefetch loop below.
    const hiddenTagIds = useAutoTagStore.getState().hiddenTagIds();
    const tagsByRow = hiddenTagIds.size ? useTagStore.getState().byRow : null;
    if (hiddenTagIds.size) {
      // A row's tags load lazily (TagChips fetches per rendered row), which
      // would let a hidden-tag message flash into view before its tags are
      // known. Prefetch the whole loaded list instead of waiting for it to
      // render — requestRowTags already dedupes/batches into one RPC.
      // ponytail: still one round-trip of "briefly visible" on a fresh
      // load until the prefetch answers; a server-side prefilter would
      // close that, not worth it for a locally-cached header lookup.
      for (const e of emails) if (rowMailbox(e, unifiedInbox, activeMailbox) === 'INBOX') {
        requestRowTags(e, { accountId: e._accountId || activeAccountId, mailbox: 'INBOX' });
      }
      for (const e of localEmails) if (rowMailbox(e, unifiedInbox, activeMailbox) === 'INBOX') {
        requestRowTags(e, { accountId: e._accountId || activeAccountId, mailbox: 'INBOX' });
      }
    }

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
    // The rows live in snoozeStore; mailStore.js re-derives when they change.
    const snoozeRows = useSnoozeStore.getState().rows;
    const localSnoozes = localSnoozeKeys(snoozeRows);
    const sameInputs = _sortedInputs !== null
      && _sortedInputs.emails === emails
      && _sortedInputs.localEmails === localEmails
      && _sortedInputs.archivedEmailIds === archivedEmailIds
      && _sortedInputs.savedEmailIds === savedEmailIds
      && _sortedInputs.serverUids === serverUids
      && _sortedInputs.deleteTombstones === deleteTombstones
      && _sortedInputs.tagsByRow === tagsByRow
      && _sortedInputs.snoozeRows === snoozeRows;
    const hiddenTagKey = hiddenTagIds.size ? [...hiddenTagIds].sort().join(',') : '';
    const fp = `${activeAccountId}-${activeMailbox}-${viewMode}-${emails.length}-${emails[0]?.uid || 0}-${emails[emails.length - 1]?.uid || 0}-${localEmails.length}-${archivedEmailIds.size}-${savedEmailIds.size}-${serverUids.uids.size}-${serverUids.complete}-${_flagChangeCounter}-${deleteTombstones?.size || 0}-${hiddenTagKey}-${localSnoozes.size}`;
    if (fp === _sortedEmailsFingerprint && sameInputs) return;

    const result = deriveDisplayRows({
      emails, localEmails, viewMode, savedEmailIds, archivedEmailIds, serverUids,
      unifiedInbox, activeAccountId, activeMailbox, deleteTombstones, hiddenTagIds, tagsByRow, localSnoozes,
    });

    annotateRowAlerts(result, get(), useSettingsStore.getState());

    // ── the sidebar's unread badge ──
    //
    // Recounted here, from the list this derivation just ran on, because this
    // is the one point EVERY change to the inbox list already passes through.
    // It used to be written by the loads (activateAccount, loadEmails) and by a
    // \Seen change and nowhere else, so every other way an unread message
    // leaves the inbox — delete, move, purge, an undo putting one back — left
    // the badge on its old value until the next server round trip finished.
    // That is the "0 emails in this folder, 1 on the badge" report: the message
    // was already in the Bin, and the badge caught up a round trip later.
    //
    // INBOX only, and never a scoped branch listing (that list holds the
    // descendant folders' mail too) or the unified list (its rows span
    // accounts). Only when `emails` is the whole inbox (unreadCounts): a window
    // onto a big one says nothing about the rest, and what leaves it is
    // shifted by whoever removed it. A message a local snooze holds out of the
    // list is not counted either.
    if (activeAccountId && !unifiedInbox && !mailboxScope && activeMailbox === 'INBOX') {
      recountInbox(activeAccountId, { emails, totalEmails: get().totalEmails });
    }

    _chatEmailsFingerprint = '';
    _threadsFingerprint = '';
    _sortedInputs = { emails, localEmails, archivedEmailIds, savedEmailIds, serverUids, deleteTombstones, tagsByRow, snoozeRows };
    set({ sortedEmails: result, _sortedEmailsFingerprint: fp });
  },

  // Rescan the external backup mirror for the active view (or every account,
  // in unified inbox) and rebuild backedUpKeys from scratch.
  refreshBackedUpUids: async () => {
    const generation = ++_backedUpGeneration;
    // Guarded setter — an older in-flight call resolving after a newer one
    // must drop its result on the floor instead of clobbering it.
    const commit = (backedUpKeys, backedUpScopes = null, backupConfigured = true) => {
      if (generation === _backedUpGeneration) set({ backedUpKeys, backedUpScopes, backupConfigured });
    };

    const { activeAccountId, activeMailbox, unifiedInbox, accounts, unifiedFolder } = get();
    const targets = unifiedInbox
      // Per account, through the SAME resolver loadUnifiedInbox stamps its rows
      // with. A unified Sent view is 'Sent' to the picker and '[Gmail]/Sent
      // Mail' to one of the accounts in it; scanning the picker's name would
      // read a folder no row claims to be in.
      ? (accounts || []).flatMap(a => {
          const mailbox = _resolveMailboxPath(getAccountCacheMailboxes(a.id) || [], unifiedFolder || 'INBOX');
          // All inboxes threads each account's Sent copies into its INBOX
          // rows, so that account's Sent mirror is read too — at ITS path.
          const sentPath = mailbox === 'INBOX' ? get().getSentMailboxPath(a.id) : null;
          return [mailbox, ...(sentPath && sentPath !== mailbox ? [sentPath] : [])]
            .map(box => ({ id: a.id, email: a.email, mailbox: box }));
        })
      : (() => {
          const a = (accounts || []).find(x => x.id === activeAccountId);
          if (!a || !activeMailbox) return [];
          // Sent copies are merged into INBOX threads and appear in this list
          // wearing a dot of their own, so the Sent mirror has to be read too —
          // scanning only the active mailbox left every one of those rows
          // answerable solely by uid collision. One extra readdir, and
          // backup_scan_uids already early-returns when no drive is configured.
          const sentPath = get().getSentMailboxPath();
          const boxes = sentPath && sentPath !== activeMailbox
            ? [activeMailbox, sentPath]
            : [activeMailbox];
          return boxes.map(mailbox => ({ id: a.id, email: a.email, mailbox }));
        })();

    // No resolvable target (e.g. mid account-switch) is itself a
    // can't-determine case — it must not leave a different account's answer
    // sitting there looking current.
    if (!targets.length) { commit(null); return; }

    const keys = new Set();
    const scopes = new Set();
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
      //
      // Unless there is no backup drive at all, which is not an unknown: ask,
      // once, on the only path that can reach it.
      if (uids === null) {
        let configured = true;
        try {
          configured = (await api.backupGetExternalLocation())?.status !== 'not_configured';
        } catch (e) {
          console.warn('[refreshBackedUpUids] backupGetExternalLocation failed:', e);
        }
        commit(null, null, configured);
        return;
      }
      scopes.add(`${t.id}:${t.mailbox}`);
      for (const uid of uids) keys.add(`${t.id}:${t.mailbox}:${uid}`);
    }
    commit(keys, scopes);
  },

  // ── Passthrough wrappers to workflow functions ──

  loadEmails: (opts) => _loadEmails(opts),
  _loadEmailsViaGraph: (account, activeAccountId, activeMailbox, generation) => _loadEmailsViaGraph(account, activeAccountId, activeMailbox, generation),
  loadMoreEmails: () => _loadMoreEmails(),
  loadSentHeaders: (accountId, opts) => _loadSentHeaders(accountId, opts),

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

  // The active account's Sent path, or, given an id, that account's: from its
  // own cached folder list, never the active account's.
  getSentMailboxPath: (accountId = null) => {
    const state = get();
    const id = accountId || state.activeAccountId;
    return sentMailboxPathFor(state, id, id === state.activeAccountId ? null : getAccountCacheMailboxes(id));
  },

  // Get merged INBOX + Sent emails for chat view (memoized via module-level cache)
  getChatEmails: () => {
    const { sortedEmails, sentEmails, archivedEmailIds, viewMode } = get();

    const { activeAccountId, activeMailbox, unifiedFolder } = get();
    // Hidden accounts decide which Sent rows All inboxes merges, so they are
    // part of the key: hiding one must drop its replies at once.
    const { hiddenAccounts } = useSettingsStore.getState() || {};
    const hiddenKey = Object.keys(hiddenAccounts || {}).filter(id => hiddenAccounts[id]).sort().join(',');
    const fp = `${activeAccountId}-${activeMailbox}-${unifiedFolder}-${hiddenKey}-${viewMode}-${sortedEmails.length}-${sortedEmails[0]?.uid || 0}-${sortedEmails[sortedEmails.length - 1]?.uid || 0}-${sentEmails.length}-${sentEmails[0]?.uid || 0}-${_flagChangeCounter}-${archivedEmailIds.size}`;
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

    // All inboxes holds every visible account's INBOX, so every visible
    // account's Sent joins it; one account's view takes that account's only,
    // or another account's replies would thread into its conversations.
    const spans = activeMailbox === 'UNIFIED';
    for (const email of sentEmails) {
      const foreign = activeAccountId && email._accountId && email._accountId !== activeAccountId;
      if (spans ? hiddenAccounts?.[email._accountId] : foreign) continue;
      if (email.messageId && seen.has(email.messageId)) continue;
      if (email.messageId) seen.add(email.messageId);
      email._fromSentFolder = true;
      // The active account's path fits the active account's rows only.
      if (!email._mailbox && sentPath && !foreign) email._mailbox = sentPath;
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
