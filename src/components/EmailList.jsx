import React, { memo, useState, useCallback, useRef, useEffect, useMemo, useId } from 'react';
import ReactDOM from 'react-dom';
import { displayText } from '../utils/bidiText';
import { useMailStore } from '../stores/mailStore';
import { useAccountStore } from '../stores/accountStore';
import { useMessageListStore } from '../stores/messageListStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useSyncStore } from '../stores/syncStore';
import { useUiStore } from '../stores/uiStore';
import { useSearchStore } from '../stores/searchStore';
import { useSettingsStore, getAccountInitial, hashColor } from '../stores/settingsStore';
import { shouldPrefetch } from '../services/cachePressure';
import { backfillTrackerVerdicts } from '../services/trackerVerdicts';
import { buildThreads, groupBySender, getSenderName, filterUnread, threadRowMembers } from '../utils/emailParser';
import { getLinkAlertLevel, getAlertsForEmails } from '../utils/linkSafety';
import { decodeImapUtf7 } from '../utils/imapUtf7';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Z } from './ui/layers';
import { LinkAlertIcon } from './LinkAlertIcon';
import { SenderAlertIcon, getSenderAlertLevel } from './SenderAlertIcon';
import { motion, AnimatePresence } from 'framer-motion';
import { formatEmailDate, formatDateOnly } from '../utils/dateFormat';
import { SearchBar } from './SearchBar';
import {
  RefreshCw,
  HardDrive,
  Cloud,
  CloudOff,
  ServerOff,
  Paperclip,
  CheckSquare,
  Square,
  Archive,
  X,
  Layers,
  Search,
  MessageSquare,
  Users,
  AlertTriangle,
  Trash2,
  Mail,
} from 'lucide-react';
import { BulkOperationsModal } from './BulkOperationsModal';
import { BulkSelectionBubble } from './BulkSelectionBubble';
import { BulkOperationProgress } from './BulkOperationProgress';
import { bulkOperationManager } from '../services/BulkOperationManager';
import { useVirtualizer } from '@tanstack/react-virtual';
import { EmailRow, CompactEmailRow } from './EmailRow';
import { ThreadRow, CompactThreadRow } from './ThreadRow';
import { ConnectedStateIcon, StateTooltip } from './email/MessageStateIcon';
import { t as tr, t, useT   } from '../i18n/index.js';

const ROW_HEIGHT_DEFAULT = 56;
const ROW_HEIGHT_COMPACT = 52;

// View-mode legend entries — three glyphs and one modifier. Cloud/HardDrive
// here are the same lucide icons the empty-state illustrations and
// ConnectedStateIcon use; the legend is static (no email to describe), so it
// renders them directly instead of going through describeMessageState.
const LEGEND_ENTRIES = () => ([
  {
    id: 'legend-server',
    glyph: <Cloud size={12} className="text-mail-server" />,
    text: tr('list.serverOnly'),
    label: tr('email.state.server'),
    detail: tr('list.savedVaultYetIfAccount'),
  },
  {
    id: 'legend-archived',
    glyph: <HardDrive size={12} className="text-mail-local" />,
    text: tr('list.vault'),
    label: tr('email.state.savedVault'),
    detail: tr('list.copyDiskAlsoShownWhen'),
  },
  {
    id: 'legend-local-only',
    glyph: <CloudOff size={12} className="text-mail-only-copy" />,
    text: tr('list.onlyCopy'),
    label: tr('email.state.onlyCopy'),
    detail: tr('list.confirmedGoneServerNothingElse'),
  },
  {
    id: 'legend-backed-up',
    glyph: <span className="w-[6px] h-[6px] rounded-full border bg-mail-text border-mail-text" />,
    text: tr('list.backupDrive'),
    label: tr('list.backupDrive2'),
    detail: tr('list.filledMeansBackupDriveToo'),
  },
]);

function getDateRange(emails) {
  if (!emails || emails.length === 0) return null;
  let oldest = null;
  let newest = null;
  for (const e of emails) {
    const d = e.date ? new Date(e.date) : null;
    if (!d || isNaN(d)) continue;
    if (!oldest || d < oldest) oldest = d;
    if (!newest || d > newest) newest = d;
  }
  if (!oldest || !newest) return null;
  const fmt = (d) => formatDateOnly(d, { alwaysShowYear: true });
  if (oldest.toDateString() === newest.toDateString()) return fmt(newest);
  return `${fmt(oldest)} – ${fmt(newest)}`;
}

// purgeEverywhere's four outcome counts aren't mutually exclusive — one run
// can produce several at once (e.g. a few uids held back for resync AND a
// few backup copies queued) — so every non-zero count gets its own clause
// instead of an if/else chain that would silently report only the first.
// A clean run (nothing held back, nothing queued, nothing failed) returns
// null: there's nothing to warn about, the list already reflects the delete.
export function formatPurgeEverywhereOutcome(result) {
  if (!result) return null;
  const { deleted = 0, failed = 0, queuedBackup = 0, needsResync = 0 } = result;
  if (!failed && !queuedBackup && !needsResync) return null;

  const clauses = [`${deleted} removed.`];
  if (failed > 0) {
    clauses.push(t('list.deleteFailedOnServer', { count: failed }));
  }
  if (queuedBackup > 0) {
    clauses.push(t('list.backupWillBeRemoved', { count: queuedBackup }));
  }
  if (needsResync > 0) {
    // The UID space couldn't be trusted, so these were held back entirely —
    // no server delete, no vault purge, no backup purge. Without this clause
    // a user selecting only stale-UID messages sees "0 removed" and nothing
    // else, with no hint that retrying won't help until the mailbox resyncs.
    clauses.push(t('list.skippedNeedsResync', { count: needsResync }));
  }
  return clauses.join(' ');
}

// The header's one line about how much of the mailbox is on screen.
//
// `shown` is what the list draws, `loaded` the window the store holds, `total`
// what the server says the mailbox has. With the unread filter on, the honest
// claim is about the loaded window only — the filter cannot see a message that
// was never fetched, so "12 unread" on a half-loaded 15k mailbox would be a
// promise the app can't keep.
export function formatListCount({ shown, loaded, total, unreadOnly }) {
  if (unreadOnly) {
    return loaded < total
      ? t('list.unreadLoaded', { shown: shown.toLocaleString(), loaded: loaded.toLocaleString() })
      : t('list.unread', { shown: shown.toLocaleString() });
  }
  return shown < total
    ? t('list.emails', { shown: shown.toLocaleString(), total: total.toLocaleString() })
    : t('list.emails2', { total: total.toLocaleString() });
}

function EmailListComponent() {
  const t = useT();
  // Individual selectors — component only re-renders when these specific fields change
  const loading = useSyncStore(s => s.loading);
  const loadingMore = useSyncStore(s => s.loadingMore);
  const activeMailbox = useAccountStore(s => s.activeMailbox);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const viewMode = useUiStore(s => s.viewMode);
  const totalEmails = useMessageListStore(s => s.totalEmails);
  const selectedEmailId = useSelectionStore(s => s.selectedEmailId);
  const selectedEmailIds = useSelectionStore(s => s.selectedEmailIds);
  const sortedEmails = useMessageListStore(s => s.sortedEmails);
  const sentEmails = useMessageListStore(s => s.sentEmails);
  const hasMoreEmails = useMessageListStore(s => s.hasMoreEmails);
  const unreadOnly = useUiStore(s => s.unreadOnly);
  const toggleUnreadOnly = useUiStore(s => s.toggleUnreadOnly);
  const searchActive = useSearchStore(s => s.searchActive);
  const searchResults = useSearchStore(s => s.searchResults);
  const flagSeq = useUiStore(s => s._flagSeq);
  const archivedSize = useMessageListStore(s => s.archivedEmailIds.size);
  const archivedEmailIds = useMessageListStore(s => s.archivedEmailIds);
  // Actions (stable references — never cause re-renders)
  const loadEmails = useMessageListStore(s => s.loadEmails);
  const loadMoreEmails = useMessageListStore(s => s.loadMoreEmails);
  const selectEmail = useSelectionStore(s => s.selectEmail);
  const selectThread = useSelectionStore(s => s.selectThread);
  const toggleEmailSelection = useSelectionStore(s => s.toggleEmailSelection);
  const setEmailsSelected = useSelectionStore(s => s.setEmailsSelected);
  const selectAllEmails = useSelectionStore(s => s.selectAllEmails);
  const clearSelection = useSelectionStore(s => s.clearSelection);
  const clearSearch = useSearchStore(s => s.clearSearch);
  const getChatEmails = useMessageListStore(s => s.getChatEmails);
  const getSentMailboxPath = useMessageListStore(s => s.getSentMailboxPath);
  const refreshBackedUpUids = useMessageListStore(s => s.refreshBackedUpUids);
  const activeAccountEmail = useAccountStore(s => s.accounts.find(a => a.id === s.activeAccountId)?.email);

  // Shared row props — subscribed once in parent, passed to all rows via props
  const saveEmailLocally = useAccountStore(s => s.saveEmailLocally);
  const removeLocalEmail = useAccountStore(s => s.removeLocalEmail);
  const deleteEmailFromServer = useAccountStore(s => s.deleteEmailFromServer);
  const saveEmailsLocally = useAccountStore(s => s.saveEmailsLocally);
  const unifiedInbox = useAccountStore(s => s.unifiedInbox);
  const accountColors = useSettingsStore(s => s.accountColors);
  // Stable actions ref — object identity doesn't change unless actions change (they don't)
  const rowActions = useMemo(() => ({ saveEmailLocally, removeLocalEmail, deleteEmailFromServer, saveEmailsLocally }), [saveEmailLocally, removeLocalEmail, deleteEmailFromServer, saveEmailsLocally]);

  const emailListStyle = useSettingsStore(s => s.emailListStyle);
  const emailListGrouping = useSettingsStore(s => s.emailListGrouping);
  const setEmailListGrouping = useSettingsStore(s => s.setEmailListGrouping);
  const layoutMode = useSettingsStore(s => s.layoutMode);
  const isCompact = emailListStyle === 'compact';
  const ROW_HEIGHT = isCompact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT_DEFAULT;
  const rowStyle = useMemo(() => ({ height: ROW_HEIGHT }), [ROW_HEIGHT]);
  const RowComponent = isCompact ? CompactEmailRow : EmailRow;

  const [showSearch, setShowSearch] = useState(false);
  // Same signal the sidebar's ConnectionErrorCard reads, so the empty
  // state and the account row can never disagree about reachability.
  const connectionStatus = useMailStore(s => s.connectionStatus);
  const bulkModalOpen = useMailStore(s => s.bulkModalOpen);
  const openBulkModal = useMailStore(s => s.openBulkModal);
  const minimizeBulkModal = useMailStore(s => s.minimizeBulkModal);
  const bulkSession = useMailStore(s => s.bulkSession);
  const endBulkSession = useMailStore(s => s.endBulkSession);
  const [bulkOpProgress, setBulkOpProgress] = useState(null);

  // A bulk session is bound to the (account, mailbox, viewMode) it was opened
  // against. The modal never unmounts on minimize, so a session for Spam
  // would otherwise sit there picking up Sent's rows once the user navigates
  // away — activateAccount already clears selectedEmailIds on account/mailbox
  // switch for exactly this cross-mailbox-bleed reason; this keeps the
  // session in agreement with that instead of resurrecting a selection it
  // just cleared. viewMode is bound too: "All" means a different pool of
  // messages in local-only view than in server view, even for the same
  // mailbox, so toggling it invalidates a session just as surely as
  // switching folders does.
  useEffect(() => {
    if (!bulkSession?.active) return;
    if (bulkSession.accountId !== activeAccountId || bulkSession.mailbox !== activeMailbox || bulkSession.viewMode !== viewMode) {
      endBulkSession();
    }
  }, [bulkSession, activeAccountId, activeMailbox, viewMode, endBulkSession]);

  // The mirror is scanned from exactly one place. Keying on archivedEmailIds is
  // what makes that enough: all fourteen paths that load archived state end by
  // replacing that Set, so account switch, folder switch, archive and unarchive
  // all land here without threading a call through any of them.
  useEffect(() => {
    refreshBackedUpUids();
  }, [activeAccountId, activeMailbox, unifiedInbox, archivedEmailIds, refreshBackedUpUids]);

  // Sender-grouped accordion state
  const [senderGroups, setSenderGroups] = useState(null);
  const senderGroupCacheRef = useRef({ fingerprint: null, groups: null });
  const [expandedSender, setExpandedSender] = useState(null);
  const [expandedTopics, setExpandedTopics] = useState(new Set());
  const [expandedEmail, setExpandedEmail] = useState(null);
  const [focusedRow, setFocusedRow] = useState(null);
  // Lifted row menu state — only one menu can be active at a time
  const [activeMenuRowId, setActiveMenuRowId] = useState(null);
  // Pending delete confirmation lifted out of rows so the modal escapes the
  // virtualizer's transform stacking context.
  // { executor, copy: { title, description, confirmLabel } } | null
  const [pendingDelete, setPendingDelete] = useState(null);
  // Lifted saving state — tracks which rows have active save operations
  const [savingRowIds, setSavingRowIds] = useState(() => new Set());
  const startSaving = useCallback((id) => setSavingRowIds(prev => { const next = new Set(prev); next.add(id); return next; }), []);
  const stopSaving = useCallback((id) => setSavingRowIds(prev => { const next = new Set(prev); next.delete(id); return next; }), []);

  // Rows are React.memo'd, so every prop has to be referentially stable or the
  // whole render window re-renders on any list state change. These four are the
  // ones each row used to receive as a freshly-minted closure or object.
  const openRowMenu = useCallback((id) => setActiveMenuRowId(id), []);
  const closeRowMenu = useCallback(() => setActiveMenuRowId(null), []);
  const requestRowDelete = useCallback((executor, copy) => {
    setActiveMenuRowId(null);
    setPendingDelete({ executor, copy });
  }, []);
  const scrollContainerRef = useRef(null);

  const expandedSenderRef = useRef(expandedSender);
  const expandedTopicsRef = useRef(expandedTopics);
  const expandedEmailRef = useRef(expandedEmail);
  const focusedRowRef = useRef(focusedRow);
  const senderGroupsRef = useRef(senderGroups);

  useEffect(() => { expandedSenderRef.current = expandedSender; }, [expandedSender]);
  useEffect(() => { expandedTopicsRef.current = expandedTopics; }, [expandedTopics]);
  useEffect(() => { expandedEmailRef.current = expandedEmail; }, [expandedEmail]);
  useEffect(() => { focusedRowRef.current = focusedRow; }, [focusedRow]);
  useEffect(() => { senderGroupsRef.current = senderGroups; }, [senderGroups]);

  useEffect(() => {
    if (emailListGrouping !== 'sender') return;

    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const groups = senderGroupsRef.current;
      if (!groups?.length) return;

      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const items = [];
        for (const sender of groups) {
          items.push({ type: 'sender', senderEmail: sender.senderEmail });
          if (expandedSenderRef.current === sender.senderEmail) {
            sender.topics.forEach((topic) => {
              const topicKey = `${sender.senderEmail}-${topic.subject}`;
              items.push({ type: 'topic', senderEmail: sender.senderEmail, topicKey });
              if (expandedTopicsRef.current.has(topicKey)) {
                topic.emails.forEach(email => {
                  items.push({ type: 'email', senderEmail: sender.senderEmail, topicKey, emailUid: email.uid });
                });
              }
            });
          }
        }

        const current = focusedRowRef.current;
        const currentIdx = current ? items.findIndex(item =>
          item.type === current.type &&
          item.senderEmail === current.senderEmail &&
          item.topicKey === current.topicKey &&
          item.emailUid === current.emailUid
        ) : -1;

        const nextIdx = e.key === 'j'
          ? Math.min(currentIdx + 1, items.length - 1)
          : Math.max(currentIdx - 1, 0);

        setFocusedRow(items[nextIdx] || null);
      }

      if (e.key === 'Enter' && focusedRowRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const fr = focusedRowRef.current;
        if (fr.type === 'sender') {
          setExpandedSender(expandedSenderRef.current === fr.senderEmail ? null : fr.senderEmail);
          setExpandedTopics(new Set());
          setExpandedEmail(null);
        } else if (fr.type === 'topic') {
          setExpandedTopics(prev => {
            const next = new Set(prev);
            if (next.has(fr.topicKey)) next.delete(fr.topicKey);
            else next.add(fr.topicKey);
            return next;
          });
          setExpandedEmail(null);
        } else if (fr.type === 'email') {
          if (expandedEmailRef.current === fr.emailUid) {
            setExpandedEmail(null);
          } else {
            setExpandedEmail(fr.emailUid);
            const groups = senderGroupsRef.current;
            const sender = groups.find(s => s.senderEmail === fr.senderEmail);
            const topic = sender?.topics.find(t => `${fr.senderEmail}-${t.subject}` === fr.topicKey);
            const email = topic?.emails.find(e => e.uid === fr.emailUid);
            if (email) selectEmail(email.uid, email.source, email._mailbox);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [emailListGrouping, selectEmail]);

  useEffect(() => {
    setFocusedRow(null);
    // Clear display row cache when grouping mode changes
    displayRowCache.current = { deferredThreads: null, rows: [], displayEmails: null };
  }, [emailListGrouping]);

  // Skeleton transition — show lightweight placeholders during account/mailbox switches
  const [showSkeleton, setShowSkeleton] = useState(false);
  const prevViewRef = useRef({ accountId: activeAccountId, mailbox: activeMailbox });

  useEffect(() => {
    const prev = prevViewRef.current;
    if (prev.accountId !== activeAccountId || prev.mailbox !== activeMailbox) {
      setShowSkeleton(true);
      // Aggressively clear all stale derived data to prevent retained memory
      displayRowCache.current = { deferredThreads: null, rows: [], displayEmails: null };
      threadCache.current = { fingerprint: '', threads: new Map() };
      senderGroupCacheRef.current = { fingerprint: null, groups: null };
      setDeferredThreads(null);
      setSenderGroups(null);
      setSavingRowIds(new Set());
      prevViewRef.current = { accountId: activeAccountId, mailbox: activeMailbox };
    }
    setExpandedSender(null);
    setExpandedTopics(new Set());
    setExpandedEmail(null);
    setFocusedRow(null);
    setActiveMenuRowId(null);
    setPendingDelete(null);
  }, [activeAccountId, activeMailbox]);

  // Pull-to-refresh
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const pullStartY = useRef(null);
  const isPulling = useRef(false);

  // sortedEmails is already combined (server + local-only), flagged (isLocal, isArchived, source),
  // and sorted by updateSortedEmails(). Use directly to avoid redundant 17k-object spread + sort.
  // filterUnread hands back the very same array when the filter is off, so the
  // identity checks downstream (row cache, thread cache) stay hot.
  const displayEmails = useMemo(
    () => filterUnread(searchActive ? searchResults : sortedEmails, unreadOnly, selectedEmailId),
    [searchActive, searchResults, sortedEmails, unreadOnly, selectedEmailId]
  );

  // Exit skeleton mode once loading finishes for the current view (even if empty)
  useEffect(() => {
    if (showSkeleton && !loading) {
      setShowSkeleton(false);
    }
  }, [showSkeleton, loading]);

  const dateRange = useMemo(() => getDateRange(displayEmails), [displayEmails]);

  // What share of the loaded window is already on this machine. A claim about
  // the rows the list is holding, never about the server total — the meter and
  // the sentence beside it read off the same two numbers, so colour is never
  // the only carrier. Null (renders nothing) when nothing is loaded.
  const vaultShare = useMemo(() => {
    const loaded = sortedEmails.length;
    if (!loaded) return null;
    let inVault = 0;
    for (const e of sortedEmails) if (e.isArchived) inVault++;
    return { loaded, inVault, pct: Math.round((inVault / loaded) * 100) };
  }, [sortedEmails]);

  // ponytail: the "loaded" suffix only earns its place while the server still
  // holds rows this window hasn't paged in — otherwise it invites a scroll that
  // can never move either number. Vault view is never partial in that sense:
  // its rows come off disk, while totalEmails keeps counting the server.
  const windowIsPartial = viewMode !== 'local' && sortedEmails.length < totalEmails;

  // Count emails with alerts — used in fingerprints to invalidate caches when alerts change
  const alertCount = useMemo(() => {
    let count = 0;
    for (const e of displayEmails) {
      if (e._linkAlert || e._senderAlert) count++;
    }
    return count;
  }, [displayEmails]);

  // Deferred threading — buildThreads(17k+) is too slow for synchronous render.
  // Show flat list instantly, then compute threads in background and re-render.
  const threadCache = useRef({ fingerprint: '', threads: new Map() });
  const [deferredThreads, setDeferredThreads] = useState(null); // null = not computed yet

  // Fingerprint for thread computation — only merge INBOX + Sent for INBOX view
  const mergedEmails = useMemo(
    () => searchActive ? null : (activeMailbox === 'INBOX' ? getChatEmails() : sortedEmails),
    [searchActive, getChatEmails, sortedEmails, sentEmails, activeMailbox]
  );
  // The `_accountId` stamps belong in the key. `threadedDisplay` matches cached
  // threads to rows by `accountId:uid`, and entering unified inbox swaps the
  // account's own INBOX rows for the SAME messages re-stamped with an
  // `_accountId` — same count, same first and last UID, so a key built from
  // those alone cannot tell the two lists apart. It kept the threads built from
  // the un-stamped rows, nothing matched them, and the list rendered zero rows
  // over a full store. (Only visible once the unified list stopped arriving
  // doubled, which had kept the two counts different.)
  const threadFingerprint = useMemo(
    () => mergedEmails ? `${activeAccountId}-${activeMailbox}-${viewMode}-${mergedEmails.length}-${mergedEmails[0]?.uid || 0}-${mergedEmails[mergedEmails.length - 1]?.uid || 0}-${mergedEmails[0]?._accountId || ''}-${mergedEmails[mergedEmails.length - 1]?._accountId || ''}-${flagSeq}-${archivedSize}-${alertCount}` : '',
    [mergedEmails, flagSeq, viewMode, archivedSize, alertCount, activeAccountId, activeMailbox]
  );

  // Compute threads in a deferred callback to avoid blocking render
  useEffect(() => {
    if (!mergedEmails || searchActive) {
      setDeferredThreads(null);
      return;
    }

    // Use cached threads if fingerprint matches
    if (threadCache.current.fingerprint === threadFingerprint) {
      setDeferredThreads(threadCache.current.threads);
      return;
    }

    // Schedule thread computation after paint — keeps UI responsive
    // Note: requestIdleCallback is NOT available in WebKit/Safari (Tauri macOS webview)
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return; // Guard against stale callback after view change
      const threads = buildThreads(mergedEmails);
      threadCache.current = { fingerprint: threadFingerprint, threads };
      setDeferredThreads(threads);
    }, 0);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [mergedEmails, threadFingerprint, searchActive, viewMode]);

  // Deferred sender grouping computation
  useEffect(() => {
    if (emailListGrouping !== 'sender') {
      setSenderGroups(null);
      return;
    }

    // Only merge INBOX + Sent when viewing INBOX; other folders use their own emails
    const usesMerged = activeAccountEmail && activeMailbox === 'INBOX';
    const emails = usesMerged ? filterUnread(getChatEmails(), unreadOnly, selectedEmailId) : displayEmails;
    const fp = `sender-${activeAccountId}-${activeMailbox}-${emails.length}-${emails[0]?.uid}-${emails[emails.length - 1]?.uid}-${archivedSize}-${activeAccountEmail}-${sentEmails.length}-${alertCount}-${unreadOnly}`;

    if (senderGroupCacheRef.current.fingerprint === fp) {
      if (senderGroups !== senderGroupCacheRef.current.groups) {
        setSenderGroups(senderGroupCacheRef.current.groups);
      }
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      const groups = groupBySender(emails, activeAccountEmail);
      senderGroupCacheRef.current = { fingerprint: fp, groups };
      setSenderGroups(groups);
    }, 0);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [displayEmails, sentEmails, emailListGrouping, archivedSize, activeAccountEmail, activeMailbox, alertCount, unreadOnly, selectedEmailId]);

  // ── Cached display-row builder ──
  // Separates structural rebuilds (membership/order) from lightweight flag-freshening passes.
  // Structural rebuild: when thread set or display email UIDs change.
  // Freshening: when only flags/archived state change, reuse existing rows and update email refs.
  const displayRowCache = useRef({ deferredThreads: null, rows: [], displayEmails: null });

  const emailKey = useCallback((e) => `${e._accountId || ''}:${e.uid}`, []);

  const threadedDisplay = useMemo(() => {
    const isFlat = searchActive || !deferredThreads || deferredThreads.size === 0;

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
    if (cache.deferredThreads === deferredThreads && cache.displayEmails === displayEmails) {
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
    for (const thread of result) {
      if (thread.messageCount === 1) {
        rows.push({ type: 'email', email: freshen(thread.emails[0]) });
      } else {
        thread.emails = thread.emails.map(freshen);
        thread.lastEmail = freshen(thread.lastEmail) || thread.emails[thread.emails.length - 1];
        rows.push({ type: 'thread', thread });
      }
    }

    displayRowCache.current = { deferredThreads, rows, displayEmails };
    return rows;
  }, [displayEmails, searchActive, deferredThreads, emailKey]);

  const isUnified = activeMailbox === 'UNIFIED';
  // In unified mode, selection keys are "accountId:uid" to avoid cross-account UID collisions
  const selKey = (email) => isUnified && email._accountId ? `${email._accountId}:${email.uid}` : email.uid;

  const hasSelection = selectedEmailIds.size > 0;
  const allSelected = displayEmails.length > 0 && selectedEmailIds.size === displayEmails.length;

  const rowCount = threadedDisplay.length;

  // Flatten sender-grouped hierarchy into a virtual list
  const senderFlatItems = useMemo(() => {
    if (emailListGrouping !== 'sender' || !senderGroups || senderGroups.length === 0) return [];
    const items = [];
    for (const sender of senderGroups) {
      items.push({ type: 'sender', sender });
      if (expandedSender === sender.senderEmail) {
        for (const topic of sender.topics) {
          const topicKey = `${sender.senderEmail}-${topic.subject}`;
          items.push({ type: 'topic', topic, sender, topicKey });
          if (expandedTopics.has(topicKey)) {
            for (const email of topic.emails) {
              items.push({ type: 'sender-email', email, sender, topic });
              if (expandedEmail === selKey(email) && layoutMode !== 'three-column') {
                items.push({ type: 'email-body', email });
              }
            }
          }
        }
      }
    }
    return items;
  }, [senderGroups, emailListGrouping, expandedSender, expandedTopics, expandedEmail, layoutMode]);

  const SENDER_ROW_HEIGHT = 56;
  const TOPIC_ROW_HEIGHT = 52;
  const SENDER_EMAIL_ROW_HEIGHT = 44;
  const EMAIL_BODY_HEIGHT = 120;

  // Identity-based key functions — stable keys prevent row shell churn during re-renders
  const getSenderItemKey = useCallback((index) => {
    const item = senderFlatItems[index];
    if (!item) return index;
    switch (item.type) {
      case 'sender': return `s-${item.sender.senderEmail}`;
      case 'topic': return `t-${item.topicKey}`;
      case 'sender-email': return `e-${item.email._accountId || ''}:${item.email.uid}`;
      case 'email-body': return `b-${item.email._accountId || ''}:${item.email.uid}`;
      default: return index;
    }
  }, [senderFlatItems]);

  const getChronoItemKey = useCallback((index) => {
    const item = threadedDisplay[index];
    if (!item) return index;
    if (item.type === 'thread') return `th-${item.thread.threadId}`;
    return `em-${item.email._accountId || ''}:${item.email.uid}`;
  }, [threadedDisplay]);

  const senderVirtualizer = useVirtualizer({
    count: senderFlatItems.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const item = senderFlatItems[index];
      if (!item) return SENDER_ROW_HEIGHT;
      switch (item.type) {
        case 'sender': return SENDER_ROW_HEIGHT;
        case 'topic': return TOPIC_ROW_HEIGHT;
        case 'sender-email': return SENDER_EMAIL_ROW_HEIGHT;
        case 'email-body': return EMAIL_BODY_HEIGHT;
        default: return SENDER_ROW_HEIGHT;
      }
    },
    getItemKey: getSenderItemKey,
    overscan: 5,
    enabled: emailListGrouping === 'sender',
  });

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: getChronoItemKey,
    overscan: 5,
    enabled: emailListGrouping !== 'sender',
  });

  // Diagnostic: trace loading spinner condition
  useEffect(() => {
    if (loading && rowCount === 0) {
      const state = useMailStore.getState();
      console.log('[EmailList] SPINNER VISIBLE — loading=%s, rowCount=%d, emails=%d, sortedEmails=%d, viewMode=%s, activeMailbox=%s',
        loading, rowCount, state.emails.length, state.sortedEmails.length, state.viewMode, state.activeMailbox);
    }
  }, [loading, rowCount]);

  // Reset scroll position when switching mailbox, account, or view mode
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [activeMailbox, activeAccountId, viewMode]);

  // Auto-load more emails when approaching the end of the loaded list
  useEffect(() => {
    if (searchActive || loadingMore || !hasMoreEmails || viewMode === 'local') return;
    const items = virtualizer.getVirtualItems();
    const lastVisible = items[items.length - 1];
    if (lastVisible && lastVisible.index >= threadedDisplay.length - 20) {
      const timer = setTimeout(() => { loadMoreEmails(); }, 100);
      return () => clearTimeout(timer);
    }
  }, [virtualizer, threadedDisplay.length, hasMoreEmails, loadingMore, searchActive, viewMode, loadMoreEmails]);

  // Tracker verdicts for rows nobody has opened. The scan needs a body and the
  // header cache has none, so the glyph used to appear only on messages that
  // had been read — invisible on a list of a thousand tracked newsletters.
  // Bodies already in the vault answer for free; this reads only what is on
  // screen, and only once per message.
  useEffect(() => {
    const container = scrollContainerRef.current;
    let timer = null;
    const run = () => {
      const headers = [];
      for (const item of virtualizer.getVirtualItems()) {
        const row = threadedDisplay[item.index];
        if (!row) continue;
        if (row.type === 'thread') headers.push(...row.thread.emails);
        else if (row.email) headers.push(row.email);
      }
      backfillTrackerVerdicts(headers);
    };
    // Settle, then read. Mid-fling the visible window is a different set every
    // frame, and each one would cost a vault read per row.
    const arm = () => { clearTimeout(timer); timer = setTimeout(run, 400); };
    arm();
    container?.addEventListener('scroll', arm, { passive: true });
    return () => { clearTimeout(timer); container?.removeEventListener('scroll', arm); };
  }, [virtualizer, threadedDisplay]);

  // Idle memory trim — after scrolling settles, check pressure and trim if needed
  const scrollIdleTimerRef = useRef(null);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      // Re-arm pagination from the real scroll position. The auto-load effect
      // above cannot fire on scroll — the virtualizer instance is referentially
      // stable, so that effect's deps only change when the DATA changes. It
      // keeps a running load chain going but can never restart a dead one,
      // which left the list permanently stuck when the chain died silently
      // (offline blip, aborted probe). loadMoreEmails self-guards against
      // double-entry via `loadingMore`.
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 20 * ROW_HEIGHT_DEFAULT) {
        const { hasMoreEmails, loadingMore, viewMode, loadMoreEmails } = useMailStore.getState();
        if (hasMoreEmails && !loadingMore && viewMode !== 'local' && !useSearchStore.getState().searchActive) {
          loadMoreEmails();
        }
      }
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = setTimeout(() => {
        if (!shouldPrefetch()) {
          const { evictPrefetchEntries } = useMailStore.getState();
          if (evictPrefetchEntries) evictPrefetchEntries();
        }
      }, 1500);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
    };
  }, []);

  // Pull-to-refresh handlers
  const PULL_THRESHOLD = 80;

  const handleTouchStart = useCallback((e) => {
    if (scrollContainerRef.current?.scrollTop === 0 && !isRefreshing) {
      pullStartY.current = e.touches[0].clientY;
      isPulling.current = true;
    }
  }, [isRefreshing]);

  const handleTouchMove = useCallback((e) => {
    if (!isPulling.current || pullStartY.current === null) return;
    const y = e.touches[0].clientY;
    const distance = Math.max(0, (y - pullStartY.current) * 0.5);
    if (distance > 0 && scrollContainerRef.current?.scrollTop === 0) {
      setPullDistance(Math.min(distance, PULL_THRESHOLD * 1.5));
    }
  }, []);

  const handleTouchEnd = useCallback(async () => {
    if (!isPulling.current) return;
    isPulling.current = false;
    pullStartY.current = null;

    if (pullDistance >= PULL_THRESHOLD) {
      setIsRefreshing(true);
      setPullDistance(PULL_THRESHOLD * 0.6);
      try {
        await useMailStore.getState().refreshCurrentView();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance]);

  const handleBulkConfirm = async ({ action, uids }) => {
    const { activeAccountId, accounts, activeMailbox } = useMailStore.getState();
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;

    // The run consumes the selection; the session is done either way.
    useMailStore.getState().endBulkSession();

    // Handle unarchive separately — not a bulk operation manager action
    if (action === 'unarchive') {
      const { removeLocalEmail, archivedEmailIds } = useMailStore.getState();
      // Only archived messages have anything to remove, and each call re-reads
      // the whole local index — running it over a 15k selection to unarchive a
      // handful would hang the app.
      for (const uid of uids.filter(u => archivedEmailIds.has(u))) {
        try { await removeLocalEmail(uid); } catch (e) { console.error(`Failed to unarchive ${uid}:`, e); }
      }
      useMailStore.getState().updateSortedEmails();
      return;
    }

    try {
      await bulkOperationManager.start({
        type: action,
        accountId: activeAccountId,
        account,
        mailbox: activeMailbox,
        uids,
        onProgress: (op) => setBulkOpProgress({ ...op }),
      });

      if (bulkOperationManager.operation?.status === 'complete') {
        await useMailStore.getState().loadEmails();
      }

      // Only delete_everywhere populates `result` (BulkOperationManager.js) —
      // null for every other action type, so this is a no-op for them.
      const outcomeMessage = formatPurgeEverywhereOutcome(bulkOperationManager.operation?.result);
      if (outcomeMessage) {
        // Reuses the store's `error` field, the one feedback channel already
        // wired to a Toast at the app root (App.jsx renders it off `error`/
        // `errorType`/`errorTypeFor`/`clearError`). `failed`/`queuedBackup`/
        // `needsResync` are caveats on a run that otherwise succeeded, not a
        // hard failure — `errorType: 'warning'` gets the warning-styled, 8s
        // Toast per docs/modal-standards.md instead of the default
        // error-red one. `errorTypeFor` must be set to this exact message:
        // App.jsx only trusts `errorType` when the two still match, which is
        // what stops this warning from tinting an unrelated later error.
        useMailStore.setState({ error: outcomeMessage, errorType: 'warning', errorTypeFor: outcomeMessage });
      }
    } catch (err) {
      console.error('[EmailList] Bulk operation failed:', err);
    }
  };

  const handleBulkCancel = async () => {
    await bulkOperationManager.cancel();
    setBulkOpProgress(null);
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Header */}
      <div data-tauri-drag-region data-testid="email-list-header" className="flex items-center justify-between px-4 py-3 border-b border-mail-border bg-mail-surface flex-shrink-0 min-h-[48px]">
        <div className="flex items-center gap-3">
          <Button variant="ghost" icon size="xs" className="hover:bg-mail-border"
            onClick={() => allSelected ? clearSelection() : openBulkModal()}
          >
            {allSelected ? (
              <CheckSquare size={18} className="text-mail-accent-text" />
            ) : (
              <Square size={18} className="text-mail-text-muted" />
            )}
          </Button>

          {searchActive ? (
            <div className="flex items-center gap-2">
              <Search size={16} className="text-mail-accent-text" />
              <span className="text-lg font-semibold text-mail-text">{t('list.searchResults')}</span>
              <span className="text-sm text-mail-text-muted">
                ({displayEmails.length} found)
              </span>
              <button
                onClick={() => {
                  clearSearch();
                  setShowSearch(false);
                }}
                className="ml-2 px-2 py-0.5 text-xs bg-mail-bg border border-mail-border rounded
                          text-mail-text-muted hover:text-mail-text hover:border-mail-accent transition-colors"
              >
                {t('common.clear')}
              </button>
            </div>
          ) : (
            <div className="flex flex-col">
              <h2 className="text-lg font-semibold text-mail-text">
                {activeMailbox === 'UNIFIED' ? t('sidebar.allInboxes') : decodeImapUtf7(activeMailbox.includes('.') ? activeMailbox.split('.').pop() : activeMailbox.includes('/') ? activeMailbox.split('/').pop() : activeMailbox)}
              </h2>
              <div className="text-xs text-mail-text-muted mt-0.5 flex items-center gap-1.5">
                {/* ponytail: the header used to always show the server total, so a
                    half-loaded window looked identical to a full one. Say what the
                    list actually holds whenever it's short of the total. */}
                <span data-testid="email-list-count">
                  {formatListCount({
                    shown: displayEmails.length,
                    loaded: sortedEmails.length,
                    total: totalEmails,
                    unreadOnly,
                  })}
                </span>
                <span>·</span>
                <span className="capitalize">{viewMode}</span>
                {dateRange && (
                  <>
                    <span>·</span>
                    <span>{dateRange}</span>
                  </>
                )}
              </div>
              {vaultShare && (
                <div className="flex items-center gap-2 mt-1 max-w-[260px]">
                  <span className="custody-meter flex-1 min-w-[40px]" aria-hidden="true">
                    <span style={{ transform: `scaleX(${vaultShare.pct / 100})` }} />
                  </span>
                  <span data-testid="email-list-vault-share" className="text-[11px] text-mail-text-muted whitespace-nowrap">
                    In your vault: {vaultShare.inVault.toLocaleString()} of {vaultShare.loaded.toLocaleString()}{windowIsPartial ? ' loaded' : ''}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Unread-only filter */}
          <button
            data-testid="unread-filter-toggle"
            onClick={toggleUnreadOnly}
            className={`p-1.5 rounded-lg transition-colors ${
              unreadOnly
                ? 'bg-mail-accent/10 text-mail-accent-text'
                : 'text-mail-text-muted hover:bg-mail-border'
            }`}
            title={unreadOnly ? t('list.showAllMessages') : t('list.showUnreadOnly')}
            aria-pressed={unreadOnly}
          >
            <Mail size={16} />
          </button>
          {/* Sender grouping toggle */}
          <button
            onClick={() => setEmailListGrouping(
              emailListGrouping === 'chronological' ? 'sender' : 'chronological'
            )}
            className={`p-1.5 rounded-lg transition-colors ${
              emailListGrouping === 'sender'
                ? 'bg-mail-accent/10 text-mail-accent-text'
                : 'text-mail-text-muted hover:text-mail-text'
            }`}
            title={emailListGrouping === 'sender' ? t('list.switchChronologicalView') : t('list.groupSender')}
          >
            <Users size={16} />
          </button>
          <button
            onClick={() => setShowSearch(!showSearch)}
            className={`p-2 rounded-lg transition-colors ${
              showSearch || searchActive
                ? 'bg-mail-accent/10 text-mail-accent-text'
                : 'hover:bg-mail-border text-mail-text-muted'
            }`}
            title={t('list.searchEmails')}
          >
            <Search size={18} />
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <AnimatePresence>
        {(showSearch || searchActive) && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-b border-mail-border bg-mail-surface/50 relative z-20 flex-shrink-0"
          >
            <div className="px-4 py-3">
              <SearchBar />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Email List */}
      <div
        ref={scrollContainerRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="flex-1 overflow-y-auto min-h-0"
      >
        {/* Pull-to-refresh indicator */}
        {(pullDistance > 0 || isRefreshing) && (
          <div
            className="flex items-center justify-center transition-all"
            style={{ height: pullDistance }}
          >
            <RefreshCw
              size={18}
              className={`text-mail-accent-text transition-transform ${isRefreshing ? 'animate-spin' : ''}`}
              style={{
                transform: `rotate(${Math.min(pullDistance / PULL_THRESHOLD, 1) * 360}deg)`,
                opacity: Math.min(pullDistance / PULL_THRESHOLD, 1),
              }}
            />
          </div>
        )}
        {(loading && rowCount === 0) || showSkeleton ? (
          /* Skeleton rows — lightweight placeholders during transitions */
          <div className="flex flex-col">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} style={{ height: ROW_HEIGHT }} className="flex items-center gap-3 px-4 border-b border-mail-border animate-pulse">
                <div className="w-4 h-4 rounded bg-mail-border/50" />
                <div className="w-4 h-4 rounded bg-mail-border/30" />
                <div className="w-32 h-3.5 rounded bg-mail-border/40" />
                <div className="flex-1 h-3.5 rounded bg-mail-border/30" />
                <div className="w-16 h-3 rounded bg-mail-border/20" />
              </div>
            ))}
          </div>
        ) : rowCount === 0 ? (
          <div
            data-testid="email-list-empty-state"
            className="flex flex-col items-center justify-center h-full text-mail-text-muted"
          >
            {unreadOnly && !searchActive ? (
              <>
                <Mail size={48} className="mb-4 opacity-50" />
                <p>{t('list.noUnreadMessages')}</p>
                <p className="text-sm mt-2">
                  {sortedEmails.length > 0
                    ? t('list.loadedAllRead', { count: sortedEmails.length })
                    : t('list.folderEmpty')}
                </p>
                <button
                  onClick={toggleUnreadOnly}
                  className="mt-4 px-4 py-2 bg-mail-surface border border-mail-border rounded-lg
                            text-sm hover:border-mail-accent transition-colors"
                >
                  {t('list.showAllMessages')}
                </button>
              </>
            ) : searchActive ? (
              <>
                <Search size={48} className="mb-4 opacity-50" />
                <p>{t('list.noResultsFound')}</p>
                <p className="text-sm mt-2">{t('list.tryDifferentKeywordsAdjustFilters')}</p>
                <button
                  onClick={() => {
                    clearSearch();
                    setShowSearch(false);
                  }}
                  className="mt-4 px-4 py-2 bg-mail-surface border border-mail-border rounded-lg
                            text-sm hover:border-mail-accent transition-colors"
                >
                  {t('list.clearSearch')}
                </button>
              </>
            ) : viewMode === 'local' ? (
              <>
                <HardDrive size={48} className="mb-4 opacity-50" />
                <p>{t('list.nothingVaultFolder')}</p>
                <p className="text-sm mt-2">{t('list.switchServerThenArchiveWhat')}</p>
              </>
            ) : viewMode === 'server' ? (
              <>
                {/* This used to read "This folder is empty or server is
                    unreachable" — one line for two states the app can already
                    tell apart, so neither answer was usable. connectionStatus
                    is the same signal the sidebar's error card reads. */}
                {connectionStatus === 'error' ? (
                  <>
                    <ServerOff size={48} className="mb-4 opacity-50" />
                    <p>Can&rsquo;t reach the server</p>
                    <p className="text-sm mt-2">{t('list.folderMayNotEmptyNothing')}</p>
                  </>
                ) : (
                  <>
                    <Cloud size={48} className="mb-4 opacity-50" />
                    <p>{t('list.nothingServerFolder')}</p>
                    <p className="text-sm mt-2">{t('list.anythingAlreadyArchivedStillVault')}</p>
                  </>
                )}
              </>
            ) : (
              <>
                <Layers size={48} className="mb-4 opacity-50" />
                <p>{t('list.noEmailsFolder')}</p>
              </>
            )}
          </div>
        ) : emailListGrouping === 'sender' ? (
          /* Virtualized sender-grouped view */
          senderGroups === null ? (
            <div className="flex items-center justify-center h-32 text-mail-text-muted">
              <RefreshCw size={16} className="animate-spin mr-2" />
              {t('list.grouping')}
            </div>
          ) : senderGroups.length === 0 ? null : (
            <div style={{ height: senderVirtualizer.getTotalSize() + 'px', position: 'relative' }}>
              {senderVirtualizer.getVirtualItems().map((vr) => {
                const item = senderFlatItems[vr.index];
                if (!item) return null;

                return (
                  <div
                    key={vr.key}
                    data-index={vr.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      width: '100%',
                      height: vr.size + 'px',
                      transform: `translateY(${vr.start}px)`,
                    }}
                  >
                    {item.type === 'sender' && (
                      <button
                        data-testid="sender-group-row"
                        onClick={() => {
                          setExpandedSender(expandedSender === item.sender.senderEmail ? null : item.sender.senderEmail);
                          setExpandedTopics(new Set());
                          setExpandedEmail(null);
                        }}
                        className={`w-full h-full flex items-center gap-3 px-4 text-left hover:bg-mail-surface-hover border-b border-mail-border ${
                          expandedSender === item.sender.senderEmail ? 'bg-mail-surface-hover' : ''
                        } ${focusedRow?.type === 'sender' && focusedRow?.senderEmail === item.sender.senderEmail ? 'ring-2 ring-mail-accent ring-inset' : ''}`}
                      >
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium flex-shrink-0"
                          style={{ backgroundColor: hashColor(item.sender.senderEmail) }}
                        >
                          {getAccountInitial({ email: item.sender.senderEmail }, item.sender.senderName)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm truncate ${item.sender.unreadCount > 0 ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
                              {item.sender.senderName || item.sender.senderEmail}
                            </span>
                            {item.sender.totalEmails && (
                              <span className="text-xs text-mail-text-muted">({item.sender.totalEmails})</span>
                            )}
                            {item.sender.senderName && item.sender.senderName !== item.sender.senderEmail && (
                              <span className="text-xs text-mail-text-muted truncate hidden sm:inline">{item.sender.senderEmail}</span>
                            )}
                          </div>
                        </div>
                        {item.sender.unreadCount > 0 && (
                          <span className="px-1.5 py-0.5 text-xs font-medium bg-mail-accent/15 text-mail-accent-text rounded-full">
                            {item.sender.unreadCount}
                          </span>
                        )}
                        <span className="text-xs text-mail-text-muted flex-shrink-0">
                          {item.sender.lastDate ? formatEmailDate(item.sender.lastDate) : ''}
                        </span>
                      </button>
                    )}

                    {item.type === 'topic' && (
                      <button
                        onClick={() => {
                          setExpandedTopics(prev => {
                            const next = new Set(prev);
                            if (next.has(item.topicKey)) next.delete(item.topicKey);
                            else next.add(item.topicKey);
                            return next;
                          });
                          setExpandedEmail(null);
                        }}
                        className={`w-full h-full flex items-center gap-3 pl-12 pr-4 text-left hover:bg-mail-surface-hover bg-mail-surface-hover/50 ${
                          expandedTopics.has(item.topicKey) ? 'bg-mail-surface-hover' : ''
                        } ${focusedRow?.type === 'topic' && focusedRow?.topicKey === item.topicKey ? 'ring-2 ring-mail-accent ring-inset' : ''}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm truncate flex items-center gap-1 ${item.topic.unreadCount > 0 ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
                            {(() => { const sa = getSenderAlertLevel(item.topic.emails); return sa ? <SenderAlertIcon level={sa.level} email={sa.email} size={13} /> : null; })()}
                            <LinkAlertIcon level={getLinkAlertLevel(item.topic.emails)} size={13} alerts={getAlertsForEmails(item.topic.emails, useMailStore.getState())} />
                            {item.topic.originalSubject || '(No subject)'}
                          </div>
                          <div className="text-xs text-mail-text-muted truncate mt-0.5">
                            {item.topic.participants
                              .filter(p => p !== item.sender.senderEmail)
                              .map(p => p.split('@')[0])
                              .join(', ')
                              || 'No other participants'
                            }
                            <span> · {t('common.emailCount', { count: item.topic.emails.length })}</span>
                          </div>
                        </div>
                        {item.topic.unreadCount > 0 && (
                          <span className="px-1.5 py-0.5 text-xs font-medium bg-mail-accent/15 text-mail-accent-text rounded-full">
                            {item.topic.unreadCount}
                          </span>
                        )}
                        <span className="text-xs text-mail-text-muted flex-shrink-0">
                          {item.topic.lastDate ? formatEmailDate(item.topic.lastDate) : ''}
                        </span>
                      </button>
                    )}

                    {item.type === 'sender-email' && (
                      <button
                        onClick={() => {
                          // The message's own tag first — `_fromSentFolder` is a
                          // guess about which folder a Sent row came from, and a
                          // stamped `_mailbox` is the answer.
                          const mailbox = item.email._mailbox
                            || (item.email._fromSentFolder ? getSentMailboxPath() : null);
                          selectEmail(item.email.uid, item.email.source, mailbox);
                          if (layoutMode !== 'three-column') {
                            setExpandedEmail(expandedEmail === selKey(item.email) ? null : selKey(item.email));
                          }
                        }}
                        className={`w-full h-full flex items-center gap-3 pl-16 pr-4 text-left hover:bg-mail-surface-hover bg-mail-surface border-b border-mail-border ${
                          expandedEmail === selKey(item.email) ? 'bg-mail-accent/10' : ''
                        } ${selectedEmailId === selKey(item.email) ? 'ring-1 ring-mail-accent/50' : ''} ${focusedRow?.type === 'email' && focusedRow?.emailUid === item.email.uid ? 'ring-2 ring-mail-accent ring-inset' : ''}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            {item.email._accountId && (
                              <div
                                className="w-2 h-2 rounded-full flex-shrink-0"
                                style={{ backgroundColor: hashColor(item.email._accountId) }}
                                title={item.email._accountId}
                              />
                            )}
                            <span className="text-xs text-mail-text-muted">
                              {item.email.date ? formatEmailDate(new Date(item.email.date)) : ''}
                            </span>
                            <span className={`text-xs ${!item.email.flags?.includes('\\Seen') ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
                              {item.email._fromSentFolder ? 'You' : getSenderName(item.email)}
                            </span>
                            {item.email._fromSentFolder && (
                              <span className="text-[10px] px-1 py-0.5 rounded bg-mail-accent/10 text-mail-accent-text font-medium">{t('list.sent')}</span>
                            )}
                          </div>
                          {item.email.snippet && (
                            <div className="text-xs text-mail-text-muted truncate mt-0.5">{item.email.snippet}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {item.email.has_attachments && <Paperclip size={12} className="text-mail-text-muted" />}
                          <ConnectedStateIcon email={item.email} size={13} />
                        </div>
                      </button>
                    )}

                    {item.type === 'email-body' && (
                      <div className="pl-16 pr-4 py-3 border-t border-mail-border bg-mail-surface h-full overflow-auto">
                        <div className="text-xs text-mail-text-muted mb-2">
                          From: {getSenderName(item.email)} · To: {item.email.to?.[0]?.address || ''}
                        </div>
                        <div className="text-sm text-mail-text whitespace-pre-wrap">
                          {item.email.text || item.email.textBody || item.email.snippet || item.email.subject || 'No content available'}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : (
          /* Virtualized chronological scroll rendering */
          /*
            `derivedFrom` below is read by no row. It exists so React.memo can
            see a change it structurally cannot: deriveDisplayRows writes
            isLocal/isArchived/source onto the store's OWN email objects in place
            (messageListSlice.js — copying every row on every derivation is what
            this list cannot afford), so archiving a message, restoring it, or
            proving it gone from the server never changes a row's `email`
            identity. Every other row prop is referentially stable, so the memo
            bails and the row paints its mount-time state forever. A comparator
            cannot save this — with one shared object, prev.email.isArchived and
            next.email.isArchived are the same read. `displayEmails` IS replaced
            on every re-derivation, which makes its identity the honest stamp,
            and covers any field the derivation starts mutating later.
          */
          <div key={`${activeAccountId}-${viewMode}`} style={{ height: virtualizer.getTotalSize() + 'px', position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vr) => {
              const item = threadedDisplay[vr.index];
              if (!item) return null;

              if (item.type === 'thread') {
                const ThreadRowComponent = isCompact ? CompactThreadRow : ThreadRow;
                // Over the row's own members, not every message the thread
                // holds: a merged Sent copy can carry the same uid as a
                // selected message in this folder and would tick the box for a
                // row nothing in it is selected.
                const members = threadRowMembers(item.thread.emails);
                const anyChecked = members.some(e => selectedEmailIds.has(selKey(e)));
                const rowId = `thread-${item.thread.threadId}`;
                return (
                  <div
                    key={vr.key}
                    data-index={vr.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      width: '100%',
                      height: vr.size + 'px',
                      transform: `translateY(${vr.start}px)`,
                    }}
                  >
                    <ThreadRowComponent
                      key={rowId}
                      rowId={rowId}
                      thread={item.thread}
                      isSelected={item.thread.emails.some(e => selectedEmailId === selKey(e))}
                      onSelectThread={selectThread}
                      onSetSelection={setEmailsSelected}
                      anyChecked={anyChecked}
                      style={rowStyle}
                      actions={rowActions}
                      menuOpen={activeMenuRowId === rowId}
                      onOpenMenu={openRowMenu}
                      onCloseMenu={closeRowMenu}
                      onRequestDelete={requestRowDelete}
                      isSaving={savingRowIds.has(rowId)}
                      onStartSaving={startSaving}
                      onStopSaving={stopSaving}
                      derivedFrom={displayEmails}
                    />
                  </div>
                );
              }

              return (
                <div
                  key={vr.key}
                  data-index={vr.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    width: '100%',
                    height: vr.size + 'px',
                    transform: `translateY(${vr.start}px)`,
                  }}
                >
                  <RowComponent
                    key={item.email.uid}
                    rowId={item.email.uid}
                    email={item.email}
                    isSelected={selectedEmailId === selKey(item.email)}
                    isChecked={selectedEmailIds.has(selKey(item.email))}
                    onSelect={selectEmail}
                    onToggleSelection={toggleEmailSelection}
                    style={rowStyle}
                    actions={rowActions}
                    unifiedInbox={unifiedInbox}
                    accountColors={accountColors}
                    menuOpen={activeMenuRowId === item.email.uid}
                    onOpenMenu={openRowMenu}
                    onCloseMenu={closeRowMenu}
                    onRequestDelete={requestRowDelete}
                    isSaving={savingRowIds.has(item.email.uid)}
                    onStartSaving={startSaving}
                    onStopSaving={stopSaving}
                    derivedFrom={displayEmails}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* View Mode Legend — three glyphs and one modifier, each explaining
          itself on hover or focus. Not one row per state: the dot is a
          modifier, and showing it as one is what teaches the composition. */}
      <div className="px-4 py-2.5 border-t border-mail-border bg-mail-surface/50
                      flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-mail-text-muted flex-shrink-0">
        {LEGEND_ENTRIES().map(entry => (
          <StateTooltip key={entry.id} label={entry.label} detail={entry.detail} state={entry.id} testId="legend-state-icon">
            <span className="flex items-center gap-1.5 whitespace-nowrap leading-none">
              {entry.glyph}
              <span>{entry.text}</span>
            </span>
          </StateTooltip>
        ))}
      </div>

      <BulkSelectionBubble />
      <BulkOperationsModal
        isOpen={bulkModalOpen}
        onClose={minimizeBulkModal}
        onConfirm={handleBulkConfirm}
      />
      <BulkOperationProgress
        operation={bulkOpProgress}
        onCancel={handleBulkCancel}
        onDismiss={() => setBulkOpProgress(null)}
      />
      <RowDeleteConfirmModal
        pending={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          const exec = pendingDelete.executor;
          setPendingDelete(null);
          // Not awaited, and the modal is already gone: every delete verb
          // behind this button pulls its rows from the list before it touches
          // the network (deleteEmailFromServer, purgeEverywhere), and puts
          // them back if the server refuses. Holding a modal open over a
          // backdrop for the seconds an IMAP round trip takes bought the user
          // nothing but a frozen window.
          Promise.resolve()
            .then(exec)
            .catch((err) => {
              console.error('[EmailList] row delete failed:', err);
              // Plain `error`: resolveErrorToastProps defaults an unmatched
              // message to the error-styled toast (utils/errorToast.js).
              useMailStore.setState({ error: t('list.deleteFailed', { err: err?.message || err }) });
            });
        }}
      />
    </div>
  );
}

function RowDeleteConfirmModal({ pending, onCancel, onConfirm }) {
  const t = useT();
  const descId = useId();

  return (
    <Dialog
      open={Boolean(pending)}
      onClose={onCancel}
      role="alertdialog"
      // Portal + the top layer: this is raised from inside a virtualized row,
      // whose ancestor `transform` would otherwise be its containing block.
      portal
      z={Z.fatal}
      size="sm"
      aria-describedby={descId}
      panelClassName="min-w-[320px] max-w-[420px]"
      footer={
        <div className="flex justify-end gap-2 w-full">
          {/* Cancel takes first focus: nothing destructive is ever one stray
              Return away. */}
          <Button variant="ghost" size="sm" onClick={onCancel} data-autofocus>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>
            <Trash2 size={14} /> {pending?.copy.confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={20} aria-hidden="true" className="text-mail-danger flex-shrink-0 mt-0.5" />
        <div>
          {/* Both delete verbs open this one modal. The title used to be
              hardcoded to "Delete from server?", so Delete everywhere
              asked about an action it was not about to perform. */}
          <h3 className="text-base font-semibold text-mail-text mb-1">{pending?.copy.title}</h3>
          <p id={descId} className="text-sm text-mail-text-muted" dir="auto">{displayText(pending?.copy.description)}</p>
        </div>
      </div>
    </Dialog>
  );
}

export const EmailList = memo(EmailListComponent);
