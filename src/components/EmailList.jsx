import React, { memo, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useAccountStore } from '../stores/accountStore';
import { useMessageListStore } from '../stores/messageListStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useSyncStore } from '../stores/syncStore';
import { useUiStore } from '../stores/uiStore';
import { useSearchStore } from '../stores/searchStore';
import { useSettingsStore, getAccountInitial, hashColor } from '../stores/settingsStore';
import { shouldPrefetch } from '../services/cachePressure';
import { buildThreads, groupBySender, getSenderName } from '../utils/emailParser';
import { getLinkAlertLevel, getAlertsForEmails } from '../utils/linkSafety';
import { LinkAlertIcon } from './LinkAlertIcon';
import { SenderAlertIcon, getSenderAlertLevel } from './SenderAlertIcon';
import { motion, AnimatePresence } from 'framer-motion';
import { formatEmailDate, formatDateOnly } from '../utils/dateFormat';
import { SearchBar } from './SearchBar';
import {
  RefreshCw,
  HardDrive,
  Cloud,
  Paperclip,
  CheckSquare,
  Square,
  Archive,
  X,
  Layers,
  Search,
  MessageSquare,
  Users
} from 'lucide-react';
import { BulkOperationsModal } from './BulkOperationsModal';
import { BulkOperationProgress } from './BulkOperationProgress';
import { bulkOperationManager } from '../services/BulkOperationManager';
import { useVirtualizer } from '@tanstack/react-virtual';
import { EmailRow, CompactEmailRow } from './EmailRow';
import { ThreadRow, CompactThreadRow } from './ThreadRow';

const ROW_HEIGHT_DEFAULT = 56;
const ROW_HEIGHT_COMPACT = 52;


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

function EmailListComponent() {
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
  const searchActive = useSearchStore(s => s.searchActive);
  const searchResults = useSearchStore(s => s.searchResults);
  const flagSeq = useUiStore(s => s._flagSeq);
  const archivedSize = useMessageListStore(s => s.archivedEmailIds.size);
  // Actions (stable references — never cause re-renders)
  const loadEmails = useMessageListStore(s => s.loadEmails);
  const loadMoreEmails = useMessageListStore(s => s.loadMoreEmails);
  const selectEmail = useSelectionStore(s => s.selectEmail);
  const selectThread = useSelectionStore(s => s.selectThread);
  const toggleEmailSelection = useSelectionStore(s => s.toggleEmailSelection);
  const selectAllEmails = useSelectionStore(s => s.selectAllEmails);
  const clearSelection = useSelectionStore(s => s.clearSelection);
  const clearSearch = useSearchStore(s => s.clearSearch);
  const getChatEmails = useMessageListStore(s => s.getChatEmails);
  const getSentMailboxPath = useMessageListStore(s => s.getSentMailboxPath);
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
  const RowComponent = isCompact ? CompactEmailRow : EmailRow;

  const [showSearch, setShowSearch] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkOpProgress, setBulkOpProgress] = useState(null);

  // Sender-grouped accordion state
  const [senderGroups, setSenderGroups] = useState(null);
  const senderGroupCacheRef = useRef({ fingerprint: null, groups: null });
  const [expandedSender, setExpandedSender] = useState(null);
  const [expandedTopics, setExpandedTopics] = useState(new Set());
  const [expandedEmail, setExpandedEmail] = useState(null);
  const [focusedRow, setFocusedRow] = useState(null);
  // Lifted row menu state — only one menu/confirm can be active at a time
  const [activeMenuRowId, setActiveMenuRowId] = useState(null);
  const [confirmingDeleteRowId, setConfirmingDeleteRowId] = useState(null);
  // Lifted saving state — tracks which rows have active save operations
  const [savingRowIds, setSavingRowIds] = useState(() => new Set());
  const startSaving = useCallback((id) => setSavingRowIds(prev => { const next = new Set(prev); next.add(id); return next; }), []);
  const stopSaving = useCallback((id) => setSavingRowIds(prev => { const next = new Set(prev); next.delete(id); return next; }), []);
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
            if (email) selectEmail(email.uid, email.source);
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
    setConfirmingDeleteRowId(null);
  }, [activeAccountId, activeMailbox]);

  // Pull-to-refresh
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const pullStartY = useRef(null);
  const isPulling = useRef(false);

  // sortedEmails is already combined (server + local-only), flagged (isLocal, isArchived, source),
  // and sorted by updateSortedEmails(). Use directly to avoid redundant 17k-object spread + sort.
  const displayEmails = useMemo(
    () => searchActive ? searchResults : sortedEmails,
    [searchActive, searchResults, sortedEmails]
  );

  // Exit skeleton mode once loading finishes for the current view (even if empty)
  useEffect(() => {
    if (showSkeleton && !loading) {
      setShowSkeleton(false);
    }
  }, [showSkeleton, loading]);

  const dateRange = useMemo(() => getDateRange(displayEmails), [displayEmails]);

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
  const threadFingerprint = useMemo(
    () => mergedEmails ? `${activeAccountId}-${activeMailbox}-${viewMode}-${mergedEmails.length}-${mergedEmails[0]?.uid || 0}-${mergedEmails[mergedEmails.length - 1]?.uid || 0}-${flagSeq}-${archivedSize}-${alertCount}` : '',
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
    const emails = usesMerged ? getChatEmails() : displayEmails;
    const fp = `sender-${activeAccountId}-${activeMailbox}-${emails.length}-${emails[0]?.uid}-${emails[emails.length - 1]?.uid}-${archivedSize}-${activeAccountEmail}-${sentEmails.length}-${alertCount}`;

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
  }, [displayEmails, sentEmails, emailListGrouping, archivedSize, activeAccountEmail, activeMailbox, alertCount]);

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

  // Idle memory trim — after scrolling settles, check pressure and trim if needed
  const scrollIdleTimerRef = useRef(null);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
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

    clearSelection();

    // Handle unarchive separately — not a bulk operation manager action
    if (action === 'unarchive') {
      const removeLocalEmail = useMailStore.getState().removeLocalEmail;
      for (const uid of uids) {
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
      <div data-tauri-drag-region className="flex items-center justify-between px-4 py-3 border-b border-mail-border bg-mail-surface flex-shrink-0 min-h-[48px]">
        <div className="flex items-center gap-3">
          <button
            onClick={() => allSelected ? clearSelection() : setBulkModalOpen(true)}
            className="p-1 hover:bg-mail-border rounded transition-colors"
          >
            {allSelected ? (
              <CheckSquare size={18} className="text-mail-accent" />
            ) : (
              <Square size={18} className="text-mail-text-muted" />
            )}
          </button>

          {searchActive ? (
            <div className="flex items-center gap-2">
              <Search size={16} className="text-mail-accent" />
              <span className="text-lg font-semibold text-mail-text">Search Results</span>
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
                Clear
              </button>
            </div>
          ) : (
            <div className="flex flex-col">
              <h2 className="text-lg font-semibold text-mail-text">
                {activeMailbox === 'UNIFIED' ? 'All Inboxes' : activeMailbox}
              </h2>
              <div className="text-xs text-mail-text-muted mt-0.5 flex items-center gap-1.5">
                <span>{totalEmails.toLocaleString()} emails</span>
                <span>·</span>
                <span className="capitalize">{viewMode}</span>
                {dateRange && (
                  <>
                    <span>·</span>
                    <span>{dateRange}</span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Sender grouping toggle */}
          <button
            onClick={() => setEmailListGrouping(
              emailListGrouping === 'chronological' ? 'sender' : 'chronological'
            )}
            className={`p-1.5 rounded-lg transition-colors ${
              emailListGrouping === 'sender'
                ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
            }`}
            title={emailListGrouping === 'sender' ? 'Switch to chronological view' : 'Group by sender'}
          >
            <Users size={16} />
          </button>
          <button
            onClick={() => setShowSearch(!showSearch)}
            className={`p-2 rounded-lg transition-colors ${
              showSearch || searchActive
                ? 'bg-mail-accent/10 text-mail-accent'
                : 'hover:bg-mail-border text-mail-text-muted'
            }`}
            title="Search emails"
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
              className={`text-mail-accent transition-transform ${isRefreshing ? 'animate-spin' : ''}`}
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
            {searchActive ? (
              <>
                <Search size={48} className="mb-4 opacity-50" />
                <p>No results found</p>
                <p className="text-sm mt-2">Try different keywords or adjust your filters</p>
                <button
                  onClick={() => {
                    clearSearch();
                    setShowSearch(false);
                  }}
                  className="mt-4 px-4 py-2 bg-mail-surface border border-mail-border rounded-lg
                            text-sm hover:border-mail-accent transition-colors"
                >
                  Clear search
                </button>
              </>
            ) : viewMode === 'local' ? (
              <>
                <HardDrive size={48} className="mb-4 opacity-50" />
                <p>No locally archived emails</p>
                <p className="text-sm mt-2">Archive emails from "Server" view to access them offline</p>
              </>
            ) : viewMode === 'server' ? (
              <>
                <Cloud size={48} className="mb-4 opacity-50" />
                <p>No emails on server</p>
                <p className="text-sm mt-2">This folder is empty or server is unreachable</p>
              </>
            ) : (
              <>
                <Layers size={48} className="mb-4 opacity-50" />
                <p>No emails in this folder</p>
              </>
            )}
          </div>
        ) : emailListGrouping === 'sender' ? (
          /* Virtualized sender-grouped view */
          senderGroups === null ? (
            <div className="flex items-center justify-center h-32 text-gray-400">
              <RefreshCw size={16} className="animate-spin mr-2" />
              Grouping...
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
                          <span className="px-1.5 py-0.5 text-xs font-medium bg-mail-accent/15 text-mail-accent rounded-full">
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
                            <LinkAlertIcon level={getLinkAlertLevel(item.topic.emails)} size={13} alerts={getAlertsForEmails(item.topic.emails)} />
                            {item.topic.originalSubject || '(No subject)'}
                          </div>
                          <div className="text-xs text-mail-text-muted truncate mt-0.5">
                            {item.topic.participants
                              .filter(p => p !== item.sender.senderEmail)
                              .map(p => p.split('@')[0])
                              .join(', ')
                              || 'No other participants'
                            }
                            <span> · {item.topic.emails.length} email{item.topic.emails.length !== 1 ? 's' : ''}</span>
                          </div>
                        </div>
                        {item.topic.unreadCount > 0 && (
                          <span className="px-1.5 py-0.5 text-xs font-medium bg-mail-accent/15 text-mail-accent rounded-full">
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
                          const mailbox = item.email._fromSentFolder ? getSentMailboxPath() : null;
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
                              <span className="text-[10px] px-1 py-0.5 rounded bg-mail-accent/10 text-mail-accent font-medium">Sent</span>
                            )}
                          </div>
                          {item.email.snippet && (
                            <div className="text-xs text-mail-text-muted truncate mt-0.5">{item.email.snippet}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {item.email.has_attachments && <Paperclip size={12} className="text-mail-text-muted" />}
                          {item.email.source === 'local-only' ? (
                            <HardDrive size={13} className="text-mail-warning" title="Local only" />
                          ) : item.email.isArchived ? (
                            <HardDrive size={13} className="text-mail-local" title="Archived" />
                          ) : (
                            <Cloud size={13} style={{ color: 'rgba(59, 130, 246, 0.5)' }} />
                          )}
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
          <div key={`${activeAccountId}-${viewMode}`} style={{ height: virtualizer.getTotalSize() + 'px', position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vr) => {
              const item = threadedDisplay[vr.index];
              if (!item) return null;

              if (item.type === 'thread') {
                const ThreadRowComponent = isCompact ? CompactThreadRow : ThreadRow;
                const anyChecked = item.thread.emails.some(e => selectedEmailIds.has(selKey(e)));
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
                      key={`thread-${item.thread.threadId}`}
                      thread={item.thread}
                      isSelected={item.thread.emails.some(e => selectedEmailId === selKey(e))}
                      onSelectThread={selectThread}
                      onToggleSelection={toggleEmailSelection}
                      anyChecked={anyChecked}
                      style={{ height: ROW_HEIGHT }}
                      actions={rowActions}
                      menuOpen={activeMenuRowId === `thread-${item.thread.threadId}`}
                      confirmingDelete={confirmingDeleteRowId === `thread-${item.thread.threadId}`}
                      onOpenMenu={() => { setActiveMenuRowId(`thread-${item.thread.threadId}`); setConfirmingDeleteRowId(null); }}
                      onCloseMenu={() => { setActiveMenuRowId(null); setConfirmingDeleteRowId(null); }}
                      onConfirmDelete={() => setConfirmingDeleteRowId(`thread-${item.thread.threadId}`)}
                      isSaving={savingRowIds.has(`thread-${item.thread.threadId}`)}
                      onStartSaving={() => startSaving(`thread-${item.thread.threadId}`)}
                      onStopSaving={() => stopSaving(`thread-${item.thread.threadId}`)}
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
                    email={item.email}
                    isSelected={selectedEmailId === selKey(item.email)}
                    isChecked={selectedEmailIds.has(selKey(item.email))}
                    onSelect={selectEmail}
                    onToggleSelection={toggleEmailSelection}
                    style={{ height: ROW_HEIGHT }}
                    actions={rowActions}
                    unifiedInbox={unifiedInbox}
                    accountColors={accountColors}
                    menuOpen={activeMenuRowId === item.email.uid}
                    confirmingDelete={confirmingDeleteRowId === item.email.uid}
                    onOpenMenu={() => { setActiveMenuRowId(item.email.uid); setConfirmingDeleteRowId(null); }}
                    onCloseMenu={() => { setActiveMenuRowId(null); setConfirmingDeleteRowId(null); }}
                    onConfirmDelete={() => setConfirmingDeleteRowId(item.email.uid)}
                    isSaving={savingRowIds.has(item.email.uid)}
                    onStartSaving={() => startSaving(item.email.uid)}
                    onStopSaving={() => stopSaving(item.email.uid)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* View Mode Legend */}
      <div className="px-4 py-2 border-t border-mail-border bg-mail-surface/50
                      flex items-center gap-4 text-xs text-mail-text-muted flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <HardDrive size={12} className="text-mail-local" />
          <span>Archived</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Cloud size={12} className="text-mail-server" />
          <span>Server only</span>
        </div>
        <div className="flex items-center gap-1.5">
          <HardDrive size={12} className="text-mail-warning" />
          <span>Local only (deleted from server)</span>
        </div>
      </div>

      <BulkOperationsModal
        isOpen={bulkModalOpen}
        onClose={() => setBulkModalOpen(false)}
        onConfirm={handleBulkConfirm}
      />
      <BulkOperationProgress
        operation={bulkOpProgress}
        onCancel={handleBulkCancel}
        onDismiss={() => setBulkOpProgress(null)}
      />
    </div>
  );
}

export const EmailList = memo(EmailListComponent);
