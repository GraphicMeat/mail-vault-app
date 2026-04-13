import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useSnapshotStore } from '../stores/snapshotStore';
import { useAccountStore } from '../stores/accountStore';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AttachmentItem } from './email/AttachmentBar';
import {
  Clock, ChevronLeft, Download, Trash2, Inbox, Send, Archive,
  Folder, Mail, Calendar, Loader, AlertCircle, Lock, File, Paperclip,
  Cloud, HardDrive,
} from 'lucide-react';
import { formatDateTime, formatDateOnly } from '../utils/dateFormat';

const ROW_HEIGHT = 56;

/**
 * Time Capsule — settings-style modal for browsing point-in-time mailbox snapshots.
 */
export function TimeCapsuleView({ accountId, onDetailChange }) {
  const store = useSnapshotStore();
  const resolvedAccountId = accountId || useAccountStore(s => s.activeAccountId);
  const accounts = useAccountStore(s => s.accounts);
  const activeAccount = accounts.find(a => a.id === resolvedAccountId);
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPremium = hasPremiumAccess(billingProfile);

  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  useEffect(() => {
    if (resolvedAccountId && isPremium) store.loadSnapshots(resolvedAccountId);
    return () => store.reset();
  }, [resolvedAccountId, isPremium]);

  const handleCreate = async () => {
    if (!resolvedAccountId || !activeAccount) return;
    setCreating(true);
    await store.createSnapshot(resolvedAccountId, activeAccount.email);
    setCreating(false);
  };

  // Determine which "page" to show
  const page = store.viewerEmail ? 'viewer'
    : store.activeSnapshot ? 'browser'
    : 'list';

  useEffect(() => {
    onDetailChange?.(page !== 'list');
  }, [page]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Sub-header for internal navigation */}
      {page !== 'list' && (
        <div className="flex items-center gap-2 px-6 py-2 border-b border-mail-border shrink-0">
          <button
            onClick={page === 'viewer' ? store.closeViewer : store.closeSnapshot}
            className="p-1.5 hover:bg-mail-surface-hover rounded-lg transition-colors"
          >
            <ChevronLeft size={18} className="text-mail-text-muted" />
          </button>
          <span className="text-sm font-medium text-mail-text truncate">
            {page === 'viewer'
              ? (store.viewerEmail?.subject || 'Email')
              : `Snapshot — ${formatSnapshotDate(store.activeSnapshot?.timestamp)}`}
          </span>
          {page === 'browser' && (
            <span className="text-xs text-mail-text-muted shrink-0 ml-1">Read-only</span>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {!isPremium ? (
          <PremiumGate />
        ) : page === 'viewer' ? (
          <SnapshotViewer email={store.viewerEmail} loading={store.loadingViewer} accountId={resolvedAccountId} mailbox={store.mailboxMap[store.selectedMailbox] || store.selectedMailbox} />
        ) : page === 'browser' ? (
          <SnapshotBrowser accountId={resolvedAccountId} />
        ) : (
          <SnapshotList
            snapshots={store.snapshots} loading={store.loadingSnapshots}
            creating={creating} error={store.error}
            confirmDelete={confirmDelete}
            onOpen={fn => store.openSnapshot(resolvedAccountId, fn)}
            onCreate={handleCreate}
            onDelete={async fn => { await store.deleteSnapshot(resolvedAccountId, fn); setConfirmDelete(null); }}
            onConfirmDelete={setConfirmDelete}
            accountEmail={activeAccount?.email}
          />
        )}
      </div>
    </div>
  );
}

// ── Premium Gate ──────────────────────────────────────────────────────────

function PremiumGate() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-8 text-center">
      <Lock size={40} className="text-mail-text-muted mb-4" />
      <h3 className="text-base font-semibold text-mail-text mb-2">Time Capsule is a Premium Feature</h3>
      <p className="text-sm text-mail-text-muted max-w-md">
        Browse your mailbox as it was at any point in time. Restore deleted emails with one click.
        Snapshots are created automatically after each backup.
      </p>
    </div>
  );
}

// ── Snapshot List ─────────────────────────────────────────────────────────

function SnapshotList({ snapshots, loading, creating, error, confirmDelete, onOpen, onCreate, onDelete, onConfirmDelete, accountEmail }) {
  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      {/* Header card */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-mail-text">Mailbox Snapshots</h4>
            <p className="text-xs text-mail-text-muted mt-0.5">
              {accountEmail ? `Point-in-time records for ${accountEmail}` : 'Select an account to view snapshots'}
            </p>
          </div>
          <button
            onClick={onCreate} disabled={creating}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-mail-accent text-white hover:bg-mail-accent/90 disabled:opacity-50 transition-colors"
          >
            {creating ? <Loader size={14} className="animate-spin" /> : <Download size={14} />}
            {creating ? 'Creating...' : 'Take Snapshot'}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-xs">
          <AlertCircle size={14} className="shrink-0" />{error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader size={20} className="animate-spin text-mail-text-muted" />
        </div>
      ) : snapshots.length === 0 ? (
        <div className="bg-mail-surface border border-mail-border rounded-xl p-8 text-center">
          <Calendar size={32} className="text-mail-text-muted mx-auto mb-3" />
          <p className="text-sm font-medium text-mail-text mb-1">No snapshots yet</p>
          <p className="text-xs text-mail-text-muted">Snapshots are created automatically after each backup, or click "Take Snapshot" above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {snapshots.map(snap => (
            <div
              key={snap.filename}
              className="group bg-mail-surface border border-mail-border rounded-xl p-4 flex items-center justify-between hover:border-mail-accent/40 cursor-pointer transition-all"
              onClick={() => onOpen(snap.filename)}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-full bg-mail-accent/10 flex items-center justify-center shrink-0">
                  <Clock size={18} className="text-mail-accent" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-mail-text truncate">{formatSnapshotDate(snap.timestamp)}</p>
                  <p className="text-xs text-mail-text-muted">
                    {snap.total_emails.toLocaleString()} emails &middot; {snap.mailbox_count} folders &middot; {formatBytes(snap.size_bytes)}
                  </p>
                </div>
              </div>
              <div className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                {confirmDelete === snap.filename ? (
                  <div className="flex items-center gap-1">
                    <button onClick={() => onDelete(snap.filename)} className="px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-500/10 rounded-lg">Delete</button>
                    <button onClick={() => onConfirmDelete(null)} className="px-2.5 py-1 text-xs text-mail-text-muted hover:bg-mail-surface-hover rounded-lg">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => onConfirmDelete(snap.filename)} className="p-1.5 rounded-lg hover:bg-red-500/10 text-mail-text-muted hover:text-red-500 transition-colors">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Snapshot Browser (split pane: folder tabs + virtualized list) ─────────

function SnapshotBrowser({ accountId }) {
  const mailboxList = useSnapshotStore(s => s.mailboxList);
  const selectedMailbox = useSnapshotStore(s => s.selectedMailbox);
  const selectMailbox = useSnapshotStore(s => s.selectMailbox);
  const openEmail = useSnapshotStore(s => s.openEmail);
  const selectedEmailUid = useSnapshotStore(s => s.selectedEmailUid);
  const manifestEmails = useSnapshotStore(s => s.manifestEmails);
  const hydratedEmails = useSnapshotStore(s => s.hydratedEmails);
  const hydrateVisibleRows = useSnapshotStore(s => s.hydrateVisibleRows);
  const activeSnapshot = useSnapshotStore(s => s.activeSnapshot);

  const emails = useMemo(
    () => manifestEmails.map(e => hydratedEmails[e.uid] || e),
    [manifestEmails, hydratedEmails]
  );

  const scrollRef = useRef(null);
  const virtualizer = useVirtualizer({
    count: emails.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // Hydrate visible rows
  const visibleItems = virtualizer.getVirtualItems();
  const prevKeyRef = useRef('');
  useEffect(() => {
    if (!accountId || visibleItems.length === 0) return;
    const uids = visibleItems.map(vi => emails[vi.index]?.uid).filter(Boolean);
    const key = uids.join(',');
    if (key === prevKeyRef.current) return;
    prevKeyRef.current = key;
    hydrateVisibleRows(accountId, uids);
  }, [visibleItems, accountId, emails]);

  return (
    <div className="flex h-full">
      {/* Folder sidebar */}
      <div className="w-48 bg-mail-surface border-r border-mail-border flex flex-col shrink-0">
        <div className="p-3 border-b border-mail-border">
          <p className="text-[11px] text-mail-text-muted">{activeSnapshot?.account_email}</p>
        </div>
        <nav className="flex-1 p-2 overflow-y-auto">
          {mailboxList.map(({ name, totalEmails }) => (
            <button
              key={name}
              onClick={() => selectMailbox(name)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors mb-0.5 ${
                selectedMailbox === name
                  ? 'bg-mail-accent/10 text-mail-accent'
                  : 'text-mail-text-muted hover:bg-mail-surface-hover hover:text-mail-text'
              }`}
            >
              <MailboxIcon name={name} />
              <span className="text-sm font-medium flex-1 truncate">{name}</span>
              <span className="text-[11px] opacity-60">{totalEmails}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Email list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {emails.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-mail-text-muted">No emails in this folder</p>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize() + 'px', position: 'relative' }}>
            {virtualizer.getVirtualItems().map(vr => {
              const email = emails[vr.index];
              if (!email) return null;
              const isHydrated = !!(email.subject || email.from?.name || email.from?.address);
              const fromStr = typeof email.from === 'object'
                ? (email.from?.name || email.from?.address || '')
                : (email.from || '');
              const hasAttach = email.hasAttachments || (email.attachments && email.attachments.length > 0);

              return (
                <div
                  key={vr.key}
                  style={{
                    position: 'absolute', top: 0, width: '100%',
                    height: `${vr.size}px`, transform: `translateY(${vr.start}px)`,
                  }}
                >
                  <button
                    onClick={() => openEmail(accountId, email.uid)}
                    className={`w-full flex items-center gap-3 px-4 h-full text-left hover:bg-mail-surface-hover transition-colors border-b border-mail-border ${
                      selectedEmailUid === email.uid ? 'bg-mail-accent/10' : ''
                    }`}
                  >
                    <HardDrive size={14} className="text-mail-text-muted shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm truncate flex-1 ${isHydrated ? 'font-medium text-mail-text' : 'text-mail-text-muted italic'}`}>
                          {email.subject || (isHydrated ? '(No subject)' : `UID ${email.uid}`)}
                        </span>
                        {hasAttach && <Paperclip size={12} className="text-mail-text-muted shrink-0" />}
                        {email.date && <span className="text-[11px] text-mail-text-muted shrink-0">{formatTcEmailDate(email.date)}</span>}
                      </div>
                      {fromStr && (
                        <p className="text-xs text-mail-text-muted truncate mt-0.5">{fromStr}</p>
                      )}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Read-only Email Viewer (reuses AttachmentItem for downloads) ─────────

function SnapshotViewer({ email, loading, accountId, mailbox }) {
  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader size={20} className="animate-spin text-mail-text-muted" /></div>;
  }
  if (!email) {
    return <div className="flex items-center justify-center h-full"><p className="text-sm text-mail-text-muted">Email not found in local storage</p></div>;
  }

  const from = typeof email.from === 'object'
    ? `${email.from?.name || ''} <${email.from?.address || ''}>`.trim()
    : (email.from || 'Unknown');
  const to = Array.isArray(email.to)
    ? email.to.map(a => typeof a === 'object' ? `${a.name || ''} <${a.address || ''}>`.trim() : a).join(', ')
    : (email.to || '');
  const cc = Array.isArray(email.cc)
    ? email.cc.map(a => typeof a === 'object' ? `${a.name || ''} <${a.address || ''}>`.trim() : a).join(', ')
    : '';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Read-only banner */}
      <div className="px-6 py-1.5 bg-amber-500/10 border-b border-amber-500/20 shrink-0">
        <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium text-center">Read-only snapshot view — no actions available</p>
      </div>

      {/* Email header */}
      <div className="px-6 py-4 border-b border-mail-border shrink-0">
        <h3 className="text-lg font-semibold text-mail-text mb-2">{email.subject || '(No subject)'}</h3>
        <div className="text-sm text-mail-text-muted space-y-0.5">
          <p><span className="text-mail-text-muted font-medium w-12 inline-block">From</span> <span className="text-mail-text">{from}</span></p>
          {to && <p><span className="text-mail-text-muted font-medium w-12 inline-block">To</span> <span className="text-mail-text">{to}</span></p>}
          {cc && <p><span className="text-mail-text-muted font-medium w-12 inline-block">Cc</span> <span className="text-mail-text">{cc}</span></p>}
          <p><span className="text-mail-text-muted font-medium w-12 inline-block">Date</span> <span className="text-mail-text">{formatDateTime(email.date)}</span></p>
        </div>
      </div>

      {/* Email body */}
      <div className="flex-1 overflow-y-auto">
        {email.html ? (
          <EmailHtmlBody html={email.html} />
        ) : email.text || email.textBody ? (
          <pre className="text-sm text-mail-text whitespace-pre-wrap font-sans px-6 py-4">{email.text || email.textBody}</pre>
        ) : (
          <p className="text-sm text-mail-text-muted italic px-6 py-4">No message body available</p>
        )}
      </div>

      {/* Attachments — using real AttachmentItem for download support */}
      {email.attachments && email.attachments.length > 0 && (
        <div className="px-6 py-3 border-t border-mail-border shrink-0">
          <p className="text-xs text-mail-text-muted mb-2">{email.attachments.length} attachment{email.attachments.length > 1 ? 's' : ''}</p>
          <div className="flex flex-wrap gap-2">
            {email.attachments.map((att, i) => (
              <AttachmentItem
                key={i}
                attachment={att}
                attachmentIndex={att._originalIndex ?? i}
                emailUid={email.uid}
                accountId={accountId}
                mailbox={mailbox}
                compact
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Sandboxed HTML email body — mirrors the main EmailViewer's iframe approach. */
function EmailHtmlBody({ html }) {
  const iframeRef = useRef(null);
  const [height, setHeight] = useState(400);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // Extract body content to avoid nesting <html> in <html>
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
      ref={iframeRef}
      sandbox="allow-same-origin"
      style={{ width: '100%', height: `${height}px`, border: 'none' }}
      title="Snapshot email body"
    />
  );
}

// ── Shared helpers ───────────────────────────────────────────────────────

function MailboxIcon({ name }) {
  const lower = (name || '').toLowerCase();
  const size = 16;
  if (lower === 'inbox') return <Inbox size={size} />;
  if (lower === 'sent') return <Send size={size} />;
  if (lower.includes('trash') || lower.includes('deleted')) return <Trash2 size={size} />;
  if (lower.includes('archive')) return <Archive size={size} />;
  if (lower.includes('draft')) return <File size={size} />;
  if (lower.includes('junk') || lower.includes('spam')) return <AlertCircle size={size} />;
  return <Folder size={size} />;
}

function formatSnapshotDate(ts) {
  const result = formatDateTime(ts);
  return result || ts;
}

function formatTcEmailDate(d) {
  const result = formatDateOnly(d);
  return result || d;
}

function formatBytes(b) {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}
