import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAccountStore } from '../../stores/accountStore';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { useLearningStore } from '../../stores/learningStore';
import * as classificationService from '../../services/classificationService';
import { bulkOperationManager } from '../../services/BulkOperationManager';
import { ensureFreshToken } from '../../services/authUtils';
// Lazy-loaded in openPreview to avoid circular import at startup
let _getRealAttachments = null;
let _replaceCidUrls = null;
let _AttachmentItem = null;

async function loadAttachmentDeps() {
  if (!_getRealAttachments) {
    const utils = await import('../../services/attachmentUtils');
    _getRealAttachments = utils.getRealAttachments;
    _replaceCidUrls = utils.replaceCidUrls;
  }
  if (!_AttachmentItem) {
    const bar = await import('../email/AttachmentBar');
    _AttachmentItem = bar.AttachmentItem;
  }
}
import { motion, AnimatePresence } from 'framer-motion';
import {
  Lock, Loader, Trash2, Archive, Clock, Sparkles, ChevronLeft, Paperclip,
} from 'lucide-react';
import { formatEmailDate } from '../../utils/dateFormat';

const DEFAULT_CATEGORIES = [
  'newsletter', 'promotional', 'notification', 'transactional',
  'personal', 'work', 'spam-likely',
];

const CATEGORY_LABELS = {
  newsletter: 'Newsletter',
  promotional: 'Promotional',
  notification: 'Notification',
  transactional: 'Transactional',
  personal: 'Personal',
  work: 'Work',
  'spam-likely': 'Spam',
};

const ACTION_LABELS = { keep: 'Keep', archive: 'Archive', 'delete-from-server': 'Delete', review: 'Review' };
const ACTIONS = ['keep', 'archive', 'delete-from-server', 'review'];

// ── Dropdowns ─────────────────────────────────────────────────────────────

function CategoryDropdown({ current, categories, onChange }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const handleOpen = (e) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const menuW = 140;
      let left = r.left;
      if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
      if (left < 8) left = 8;
      let top = r.bottom + 4;
      if (top + 200 > window.innerHeight) top = r.top - 4; // flip above if near bottom
      setPos({ top, left });
    }
    setOpen(!open);
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={handleOpen}
        className="text-[11px] px-2 py-0.5 rounded-full bg-mail-surface-hover text-mail-text-muted hover:bg-mail-accent/10 hover:text-mail-accent transition-colors"
      >
        {CATEGORY_LABELS[current] || current}
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div
            className="fixed bg-mail-bg border border-mail-border rounded-lg shadow-lg z-[9999] py-1 min-w-[140px]"
            style={{ top: pos.top, left: pos.left }}
          >
            {categories.map(cat => (
              <button
                key={cat}
                onClick={(e) => { e.stopPropagation(); onChange(cat); setOpen(false); }}
                className={`w-full px-3 py-1.5 text-left text-xs hover:bg-mail-surface-hover ${cat === current ? 'text-mail-accent font-medium' : 'text-mail-text'}`}
              >
                {CATEGORY_LABELS[cat] || cat}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

function ActionDropdown({ current, onChange }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const handleOpen = (e) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const menuW = 120;
      let left = r.left;
      if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
      if (left < 8) left = 8;
      let top = r.bottom + 4;
      if (top + 150 > window.innerHeight) top = r.top - 4;
      setPos({ top, left });
    }
    setOpen(!open);
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={handleOpen}
        className="text-[11px] px-2 py-0.5 rounded-full bg-mail-surface-hover text-mail-text-muted hover:bg-mail-accent/10 hover:text-mail-accent transition-colors"
      >
        {ACTION_LABELS[current] || current}
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div
            className="fixed bg-mail-bg border border-mail-border rounded-lg shadow-lg z-[9999] py-1 min-w-[120px]"
            style={{ top: pos.top, left: pos.left }}
          >
            {ACTIONS.map(act => (
              <button
                key={act}
                onClick={(e) => { e.stopPropagation(); onChange(act); setOpen(false); }}
                className={`w-full px-3 py-1.5 text-left text-xs hover:bg-mail-surface-hover ${act === current ? 'text-mail-accent font-medium' : 'text-mail-text'}`}
              >
                {ACTION_LABELS[act]}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function senderName(from) {
  if (!from) return 'Unknown';
  // "Name <email>" → Name
  const match = from.match(/^(.+?)\s*<.*>$/);
  if (match) return match[1].trim();
  // Just email
  return from.split('@')[0];
}

// ── HTML Body (auto-resizing iframe) ─────────────────────────────────────

function CleanupHtmlBody({ html }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(400);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;

    let body = html;
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) body = bodyMatch[1];

    const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; color: #1a1a1a; background: #fff; margin: 0; padding: 16px 24px; line-height: 1.5; word-wrap: break-word; overflow-wrap: break-word; }
      img { max-width: 100%; height: auto; }
      a { color: #6366f1; }
      pre, code { white-space: pre-wrap; word-wrap: break-word; }
      table { max-width: 100%; }
    </style></head><body>${body}</body></html>`;

    iframe.srcdoc = doc;

    const onLoad = () => {
      try {
        const h = iframe.contentDocument?.body?.scrollHeight;
        if (h) setHeight(Math.min(h + 32, 2000));
      } catch {}
    };
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [html]);

  return (
    <iframe
      ref={ref}
      sandbox="allow-same-origin"
      style={{ width: '100%', height: `${height}px`, border: 'none' }}
      title="Email preview"
    />
  );
}

// ── Memoized Row ─────────────────────────────────────────────────────────

const ROW_HEIGHT = 60;

const CleanupRow = React.memo(function CleanupRow({
  item, isSelected, allCategories, onToggleSelect, onPreview, onCorrectCategory, onCorrectAction,
}) {
  const c = item.classification || item;
  const mid = item.messageId;
  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${
        isSelected ? 'border-mail-accent bg-mail-accent/5' : 'border-mail-border hover:bg-mail-surface-hover'
      }`}
      onClick={() => onPreview(item)}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggleSelect(mid)}
        className="custom-checkbox"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-mail-text truncate">{senderName(item.from)}</p>
          {item.date && (
            <span className="text-[11px] text-mail-text-muted shrink-0">{formatEmailDate(item.date)}</span>
          )}
        </div>
        <p className="text-xs text-mail-text-muted truncate">{item.subject || '(No subject)'}</p>
      </div>
      <CategoryDropdown current={c.category} categories={allCategories} onChange={(cat) => onCorrectCategory(item, cat)} />
      <ActionDropdown current={c.action} onChange={(act) => onCorrectAction(item, act)} />
      <span className="text-[11px] text-mail-text-muted w-8 text-right shrink-0">
        {Math.round((c.confidence || 0) * 100)}%
      </span>
    </div>
  );
});

// ── Exported Modal ────────────────────────────────────────────────────────

export function CleanupView({ accountId, onDetailChange }) {
  const activeAccountId = accountId || useAccountStore(s => s.activeAccountId);
  const activeMailbox = useAccountStore(s => s.activeMailbox);
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const customCategories = useSettingsStore(s => s.customCategories);
  const isPremium = hasPremiumAccess(billingProfile);
  const { recordCorrection } = useLearningStore();

  const threadSortOrder = useSettingsStore(s => s.threadSortOrder);

  const [summary, setSummary] = useState(null);
  const [results, setResults] = useState([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [classStatus, setClassStatus] = useState(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [previewItem, setPreviewItem] = useState(null);
  const [previewEmail, setPreviewEmail] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [bulkAction, setBulkAction] = useState(null); // 'delete' | 'archive' — confirmation pending
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);
  const listParentRef = useRef(null);

  const allCategories = [...DEFAULT_CATEGORIES, ...customCategories];

  const load = useCallback(async () => {
    if (!activeAccountId) return;
    // Phase 1: summary + status (fast, renders cards immediately)
    setSummaryLoading(true);
    setResultsLoading(true);
    try {
      const [s, cs] = await Promise.all([
        classificationService.getSummary(activeAccountId),
        classificationService.getStatus().catch(() => null),
      ]);
      setSummary(s);
      setClassStatus(cs);
    } catch {}
    setSummaryLoading(false);
    // Phase 2: full results list (may be large)
    try {
      const r = await classificationService.getResults(activeAccountId);
      const list = Array.isArray(r)
        ? r
        : Object.entries(r).map(([messageId, c]) => ({ messageId, classification: c }));
      setResults(list);
    } catch {}
    setResultsLoading(false);
  }, [activeAccountId]);

  const autoTriggered = useRef(false);

  useEffect(() => {
    closePreview();
    setSelectedIds(new Set());
    setActiveCategory('all');
    autoTriggered.current = false;
    load();
  }, [activeAccountId]);

  // Auto-trigger classification when view mounts with no results
  useEffect(() => {
    if (!activeAccountId || summaryLoading || resultsLoading) return;
    if (autoTriggered.current) return;
    if (summary && summary.total === 0 && !classStatus?.status?.includes?.('Running')) {
      autoTriggered.current = true;
      classificationService.run(activeAccountId).catch(() => {});
    }
  }, [activeAccountId, summary, summaryLoading, resultsLoading, classStatus]);

  // Re-run classification when custom categories change
  const prevCategoriesRef = useRef(customCategories);
  useEffect(() => {
    if (!activeAccountId) return;
    if (prevCategoriesRef.current !== customCategories) {
      prevCategoriesRef.current = customCategories;
      setClassStatus({ status: 'Running', classified: 0, total: 0, skipped_by_rules: 0 });
      classificationService.run(activeAccountId).catch(() => {});
    }
  }, [activeAccountId, customCategories]);

  useEffect(() => {
    if (!activeAccountId) return;
    const interval = setInterval(async () => {
      try {
        const cs = await classificationService.getStatus();
        setClassStatus(cs);
        if (cs?.status === 'Complete' || cs?.status === 'Idle') load();
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [activeAccountId, load]);

  // ESC to go back from preview
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && previewItem) {
        e.preventDefault();
        closePreview();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewItem]);

  const handleClassifyNow = async () => {
    if (!activeAccountId) return;
    setClassStatus({ status: 'Running', classified: 0, total: 0, skipped_by_rules: 0 });
    try { await classificationService.run(activeAccountId); } catch {}
  };

  const openPreview = async (item) => {
    setPreviewItem(item);
    onDetailChange?.(true);
    setPreviewEmail(null);
    if (!item.uid || !activeAccountId) return;
    setPreviewLoading(true);
    await loadAttachmentDeps();
    try {
      const invoke = window.__TAURI__?.core?.invoke;
      if (invoke) {
        // Try maildir first (archived/local)
        let email = null;
        try {
          email = await invoke('maildir_read_light', { accountId: activeAccountId, mailbox: item.mailbox || 'INBOX', uid: item.uid });
        } catch {}
        // Fall back to IMAP fetch
        if (!email) {
          const accounts = useAccountStore.getState().accounts;
          const account = accounts.find(a => a.id === activeAccountId);
          if (account) {
            try {
              const data = await invoke('imap_get_email_light', { account, uid: item.uid, mailbox: item.mailbox || 'INBOX', accountId: activeAccountId });
              email = data?.email;
            } catch {}
          }
        }
        if (email) setPreviewEmail(email);
      }
    } catch (e) {
      console.warn('[CleanupPreview] Failed to load email:', e);
    }
    setPreviewLoading(false);
  };

  const closePreview = () => {
    setPreviewItem(null);
    setPreviewEmail(null);
    onDetailChange?.(false);
  };

  const handleCorrectCategory = async (item, newCategory) => {
    const c = item.classification || item;
    const mid = item.messageId;
    await classificationService.overrideClassification(activeAccountId, mid, { category: newCategory });
    await recordCorrection(activeAccountId, { messageId: mid, from: item.from || mid, subject: item.subject || '' }, {
      originalCategory: c.category,
      correctedCategory: newCategory,
      correctedAction: c.action,
    });
    load();
  };

  const handleCorrectAction = async (item, newAction) => {
    const mid = item.messageId;
    await classificationService.overrideClassification(activeAccountId, mid, { action: newAction });
    load();
  };

  const handleBulkAction = async (action) => {
    if (!activeAccountId || bulkRunning) return;
    const uids = mailboxResults
      .filter(r => selectedIds.has(r.messageId) && r.uid)
      .map(r => r.uid);
    if (uids.length === 0) return;

    const accounts = useAccountStore.getState().accounts;
    const account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;

    setBulkRunning(true);
    setBulkAction(null);
    setBulkProgress({ total: uids.length, completed: 0, status: action === 'delete' ? 'deleting' : 'archiving' });

    try {
      const freshAccount = await ensureFreshToken(account);
      await bulkOperationManager.start({
        type: action,
        accountId: activeAccountId,
        account: freshAccount,
        mailbox: activeMailbox || 'INBOX',
        uids,
        onProgress: (op) => {
          setBulkProgress({ total: op.total, completed: op.completed, status: op.status });
          if (op.status === 'complete' || op.status === 'error' || op.status === 'cancelled') {
            setBulkRunning(false);
            setBulkProgress(null);
            setSelectedIds(new Set());
            load();
          }
        },
      });
    } catch (e) {
      console.error('[Cleanup] Bulk action failed:', e);
      setBulkRunning(false);
      setBulkProgress(null);
    }
  };

  const sortedResults = useMemo(() => {
    const parseTs = (d) => { if (!d) return 0; const t = new Date(d).getTime(); return isNaN(t) ? 0 : t; };
    const sorted = [...results].sort((a, b) => {
      const ta = parseTs(a.date);
      const tb = parseTs(b.date);
      return threadSortOrder === 'oldest-first' ? ta - tb : tb - ta;
    });
    return sorted;
  }, [results, threadSortOrder]);

  const mailboxResults = useMemo(() => {
    if (!activeMailbox) return sortedResults;
    return sortedResults.filter(r => (r.mailbox || 'INBOX') === activeMailbox);
  }, [sortedResults, activeMailbox]);

  const filteredResults = useMemo(() => {
    return activeCategory === 'all'
      ? mailboxResults
      : mailboxResults.filter(r => (r.classification?.category || r.category) === activeCategory);
  }, [mailboxResults, activeCategory]);

  const virtualizer = useVirtualizer({
    count: filteredResults.length,
    getScrollElement: () => listParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const toggleSelect = useCallback((mid) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(mid)) next.delete(mid); else next.add(mid);
      return next;
    });
  }, []);

  // Compute counts from mailbox-filtered results (not raw summary which spans all mailboxes)
  const { mailboxTotal, deletableCount, archivableCount, mailboxByCategory } = useMemo(() => {
    let del = 0, arch = 0;
    const byCat = {};
    for (const r of mailboxResults) {
      const action = r.classification?.action || r.action;
      if (action === 'delete-from-server') del++;
      if (action === 'archive') arch++;
      const cat = r.classification?.category || r.category;
      if (cat) byCat[cat] = (byCat[cat] || 0) + 1;
    }
    return { mailboxTotal: mailboxResults.length, deletableCount: del, archivableCount: arch, mailboxByCategory: byCat };
  }, [mailboxResults]);

  const isClassifying = classStatus?.status === 'Running';
  const hasResults = summary && summary.total > 0;

  // ── Content sections ──────────────────────────────────────────────────

  let content;

  if (!isPremium) {
    content = (
      <div className="flex flex-col items-center justify-center h-full px-8 text-center">
        <Lock className="w-10 h-10 text-mail-text-muted mb-4" />
        <h3 className="font-semibold text-lg mb-2">Email Cleanup is a Premium Feature</h3>
        <p className="text-sm text-mail-text-muted max-w-sm">Automatically classify your emails into categories like newsletters, promotions, and notifications — then clean up in bulk with smart keep, archive, and delete suggestions.</p>
      </div>
    );
  } else if (summaryLoading && !hasResults && !isClassifying) {
    content = (
      <div className="flex items-center justify-center h-full">
        <Loader className="w-6 h-6 animate-spin text-mail-text-muted" />
      </div>
    );
  } else if (isClassifying && !hasResults) {
    const pct = classStatus.total > 0 ? (classStatus.classified / classStatus.total * 100) : 0;
    content = (
      <div className="flex flex-col items-center justify-center h-full text-center">
        <Loader className="w-10 h-10 text-mail-accent mb-4 animate-spin" />
        <h3 className="font-semibold text-base mb-2">Classifying Emails...</h3>
        <p className="text-sm text-mail-text-muted mb-4">
          {classStatus.total > 0 ? `${classStatus.classified} / ${classStatus.total} processed` : 'Preparing...'}
        </p>
        <div className="w-full max-w-xs h-2 bg-mail-surface-hover rounded-full overflow-hidden">
          {classStatus.total > 0
            ? <div className="h-full bg-mail-accent rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
            : <div className="h-full bg-mail-accent/50 rounded-full animate-pulse" style={{ width: '100%' }} />}
        </div>
      </div>
    );
  } else if (!hasResults) {
    content = (
      <div className="flex flex-col items-center justify-center h-full text-center">
        <Sparkles className="w-10 h-10 text-mail-text-muted mb-4" />
        <h3 className="font-semibold text-base mb-2">No Classifications Yet</h3>
        <p className="text-sm text-mail-text-muted max-w-sm">
          Emails are automatically classified as they arrive. Starting classification now...
        </p>
      </div>
    );
  } else if (previewItem) {
    // Email preview — use full email data if loaded
    const c = previewItem.classification || previewItem;
    const email = previewEmail || previewItem;
    const from = typeof email.from === 'object'
      ? `${email.from?.name || ''} <${email.from?.address || ''}>`.trim()
      : (email.from || 'Unknown');
    const to = Array.isArray(email.to)
      ? email.to.map(a => typeof a === 'object' ? `${a.name || ''} <${a.address || ''}>`.trim() : a).join(', ')
      : '';
    const rawAttachments = Array.isArray(previewEmail?.attachments) ? previewEmail.attachments : [];
    const attachments = _getRealAttachments ? _getRealAttachments(rawAttachments, previewEmail?.html) : [];
    const htmlContent = previewEmail?.html
      ? (attachments.length > 0 && _replaceCidUrls ? _replaceCidUrls(previewEmail.html, rawAttachments) : previewEmail.html)
      : null;

    content = (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Email header */}
        <div className="px-6 py-4 border-b border-mail-border shrink-0">
          <h3 className="text-lg font-semibold text-mail-text mb-2">{email.subject || previewItem.subject || '(No subject)'}</h3>
          <div className="text-sm text-mail-text-muted space-y-0.5">
            <p><span className="font-medium w-12 inline-block">From</span> <span className="text-mail-text">{from}</span></p>
            {to && <p><span className="font-medium w-12 inline-block">To</span> <span className="text-mail-text">{to}</span></p>}
            <p><span className="font-medium w-12 inline-block">Date</span> <span className="text-mail-text">{email.date || previewItem.date || ''}</span></p>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <CategoryDropdown current={c.category} categories={allCategories} onChange={(cat) => handleCorrectCategory(previewItem, cat)} />
            <ActionDropdown current={c.action} onChange={(act) => handleCorrectAction(previewItem, act)} />
            <span className="text-[11px] text-mail-text-muted">{Math.round((c.confidence || 0) * 100)}% confidence</span>
          </div>
        </div>

        {/* Email body */}
        <div className="flex-1 overflow-y-auto">
          {previewLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader className="w-5 h-5 animate-spin text-mail-text-muted" />
            </div>
          ) : htmlContent ? (
            <CleanupHtmlBody html={htmlContent} />
          ) : previewEmail?.textBody || previewEmail?.text ? (
            <pre className="text-sm text-mail-text whitespace-pre-wrap font-sans px-6 py-4">{previewEmail.textBody || previewEmail.text}</pre>
          ) : null}
        </div>

        {/* Attachments */}
        {attachments.length > 0 && (
          <div className="px-6 py-3 border-t border-mail-border shrink-0">
            <p className="text-xs text-mail-text-muted mb-2 flex items-center gap-1">
              <Paperclip size={12} />
              {attachments.length} attachment{attachments.length !== 1 ? 's' : ''}
            </p>
            <div className="flex flex-wrap gap-2">
              {attachments.map((att, i) => {
                const AttItem = _AttachmentItem;
                return AttItem ? (
                  <AttItem
                    key={i}
                    attachment={att}
                    attachmentIndex={att._originalIndex ?? i}
                    emailUid={previewItem.uid}
                    accountId={activeAccountId}
                    mailbox="INBOX"
                    compact
                  />
                ) : (
                  <span key={i} className="text-xs text-mail-text-muted">{att.filename || 'attachment'}</span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  } else {
    // Main results view
    content = (
      <div className="p-6 flex flex-col h-full overflow-hidden gap-5">
        {/* Inline progress when classifying with existing results */}
        {isClassifying && (
          <div className="flex items-center gap-3 p-3 rounded-lg bg-mail-accent/5 border border-mail-accent/20">
            <Loader size={16} className="animate-spin text-mail-accent shrink-0" />
            <span className="text-sm text-mail-text">
              Classifying... {classStatus.total > 0 ? `${classStatus.classified}/${classStatus.total}` : 'Preparing...'}
            </span>
            <div className="flex-1 h-1.5 bg-mail-surface-hover rounded-full overflow-hidden">
              {classStatus.total > 0
                ? <div className="h-full bg-mail-accent rounded-full transition-all duration-300" style={{ width: `${classStatus.classified / classStatus.total * 100}%` }} />
                : <div className="h-full bg-mail-accent/50 rounded-full animate-pulse" style={{ width: '100%' }} />}
            </div>
          </div>
        )}

        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-4">
          <div className="p-4 rounded-xl bg-mail-surface border border-mail-border text-center">
            <p className="text-2xl font-bold text-mail-text">{mailboxTotal.toLocaleString()}</p>
            <p className="text-xs text-mail-text-muted mt-1">Classified</p>
          </div>
          <button
            onClick={() => {
              const ids = new Set(mailboxResults.filter(r => (r.classification?.action || r.action) === 'delete-from-server').map(r => r.messageId));
              setSelectedIds(ids);
            }}
            className="p-4 rounded-xl bg-red-500/5 border border-red-500/20 text-center hover:bg-red-500/10 transition-colors"
          >
            <p className="text-2xl font-bold text-red-500">{deletableCount.toLocaleString()}</p>
            <p className="text-xs text-mail-text-muted mt-1">Can Delete</p>
          </button>
          <button
            onClick={() => {
              const ids = new Set(mailboxResults.filter(r => (r.classification?.action || r.action) === 'archive').map(r => r.messageId));
              setSelectedIds(ids);
            }}
            className="p-4 rounded-xl bg-blue-500/5 border border-blue-500/20 text-center hover:bg-blue-500/10 transition-colors"
          >
            <p className="text-2xl font-bold text-blue-500">{archivableCount.toLocaleString()}</p>
            <p className="text-xs text-mail-text-muted mt-1">Can Archive</p>
          </button>
        </div>

        {/* Category Tabs */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setActiveCategory('all')}
            className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
              activeCategory === 'all' ? 'bg-mail-accent text-white border-mail-accent' : 'border-mail-border text-mail-text-muted hover:border-mail-accent'
            }`}
          >
            All ({mailboxTotal})
          </button>
          {allCategories.map(cat => {
            const count = mailboxByCategory[cat] || 0;
            if (count === 0) return null;
            return (
              <button key={cat} onClick={() => setActiveCategory(cat)}
                className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
                  activeCategory === cat ? 'bg-mail-accent text-white border-mail-accent' : 'border-mail-border text-mail-text-muted hover:border-mail-accent'
                }`}
              >
                {CATEGORY_LABELS[cat] || cat} ({count})
              </button>
            );
          })}
        </div>

        {/* Bulk Progress */}
        {bulkProgress && (
          <div className="flex items-center gap-3 p-3 rounded-lg bg-mail-surface border border-mail-accent/30">
            <Loader size={14} className="animate-spin text-mail-accent shrink-0" />
            <span className="text-sm text-mail-text capitalize">{bulkProgress.status}...</span>
            <div className="flex-1 h-1.5 bg-mail-border rounded-full overflow-hidden">
              <div
                className="h-full bg-mail-accent rounded-full transition-all"
                style={{ width: `${bulkProgress.total ? (bulkProgress.completed / bulkProgress.total) * 100 : 0}%` }}
              />
            </div>
            <span className="text-xs text-mail-text-muted shrink-0">{bulkProgress.completed}/{bulkProgress.total}</span>
          </div>
        )}

        {/* Selection Bar */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-mail-surface border border-mail-border">
          {selectedIds.size > 0 ? (
            <>
              <span className="text-sm text-mail-text font-medium">{selectedIds.size} selected</span>
              <button
                onClick={() => setBulkAction('delete')}
                disabled={bulkRunning}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors disabled:opacity-50"
              >
                <Trash2 size={13} /> Delete ({selectedIds.size})
              </button>
              <button
                onClick={() => setBulkAction('archive')}
                disabled={bulkRunning}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors disabled:opacity-50"
              >
                <Archive size={13} /> Archive ({selectedIds.size})
              </button>
              <button onClick={() => setSelectedIds(new Set())} className="ml-auto text-xs text-mail-text-muted hover:text-mail-text">Deselect All</button>
            </>
          ) : (
            <button
              onClick={() => setSelectedIds(new Set(filteredResults.map(r => r.messageId)))}
              className="text-xs text-mail-text-muted hover:text-mail-text transition-colors"
            >
              Select All ({filteredResults.length})
            </button>
          )}
        </div>

        {/* Email List — Virtualized */}
        {resultsLoading && results.length === 0 ? (
          <div className="space-y-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={`skel-${i}`} className="flex items-center gap-3 p-3 rounded-lg border border-mail-border animate-pulse">
                <div className="w-4 h-4 rounded bg-mail-surface-hover shrink-0" />
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="h-3.5 w-28 rounded bg-mail-surface-hover" />
                    <div className="h-3 w-16 rounded bg-mail-surface-hover" />
                  </div>
                  <div className="h-3 w-48 rounded bg-mail-surface-hover" />
                </div>
                <div className="h-5 w-16 rounded-full bg-mail-surface-hover" />
                <div className="h-5 w-14 rounded-full bg-mail-surface-hover" />
                <div className="h-3 w-8 rounded bg-mail-surface-hover" />
              </div>
            ))}
          </div>
        ) : (
          <div ref={listParentRef} className="flex-1 overflow-y-auto min-h-0">
            <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
              {virtualizer.getVirtualItems().map(virtualItem => {
                const item = filteredResults[virtualItem.index];
                return (
                  <div
                    key={virtualItem.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualItem.size}px`,
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <CleanupRow
                      item={item}
                      isSelected={selectedIds.has(item.messageId)}
                      allCategories={allCategories}
                      onToggleSelect={toggleSelect}
                      onPreview={openPreview}
                      onCorrectCategory={handleCorrectCategory}
                      onCorrectAction={handleCorrectAction}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </div>
    );
  }

  // ── Modal shell (same pattern as TimeCapsule) ─────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      {/* Sub-header for preview navigation */}
      {previewItem && (
        <div className="flex items-center gap-2 px-6 py-2 border-b border-mail-border shrink-0">
          <button onClick={() => closePreview()} className="p-1.5 hover:bg-mail-surface-hover rounded-lg transition-colors">
            <ChevronLeft size={18} className="text-mail-text-muted" />
          </button>
          <span className="text-sm font-medium text-mail-text truncate">{previewItem.subject || 'Email'}</span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {content}
      </div>

      {/* Bulk Action Confirmation */}
      <AnimatePresence>
        {bulkAction && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/40 flex items-center justify-center z-50 rounded-xl"
            onClick={() => setBulkAction(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-mail-surface border border-mail-border rounded-xl p-6 shadow-xl max-w-sm mx-4"
            >
              <h3 className="text-lg font-semibold text-mail-text mb-2">
                {bulkAction === 'delete' ? 'Delete emails?' : 'Archive emails?'}
              </h3>
              <p className="text-sm text-mail-text-muted mb-4">
                {bulkAction === 'delete'
                  ? `${selectedIds.size} email${selectedIds.size !== 1 ? 's' : ''} will be permanently deleted from the server.`
                  : `${selectedIds.size} email${selectedIds.size !== 1 ? 's' : ''} will be saved to your local archive.`}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setBulkAction(null)}
                  className="px-4 py-2 text-sm text-mail-text bg-mail-bg border border-mail-border rounded-lg hover:bg-mail-surface-hover transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleBulkAction(bulkAction)}
                  className={`px-4 py-2 text-sm text-white rounded-lg transition-colors ${
                    bulkAction === 'delete' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  {bulkAction === 'delete' ? 'Delete' : 'Archive'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
