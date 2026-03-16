import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useMailStore } from '../../stores/mailStore';
import { useShallow } from 'zustand/react/shallow';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';
import { ComposeModal } from '../ComposeModal';
import { useChatBodyLoader, emailKey } from '../../hooks/useChatBodyLoader';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../../utils/iframeQuoteFolding';
import { splitQuotedContent } from '../../utils/quoteFolding';
import { splitSignature, hashSignature } from '../../utils/signatureFolding';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  Reply,
  ReplyAll,
  Forward,
  Paperclip,
  Archive,
  HardDrive,
  Cloud,
  ChevronDown,
  ChevronUp,
  Code,
  RefreshCw,
  Info,
} from 'lucide-react';
import { getRealAttachments, replaceCidUrls } from '../../services/attachmentUtils';
import { SenderInsightsPanel } from '../SenderInsightsPanel';
import { SenderVerificationBadge } from './EmailHeaderComponent';
import { AttachmentItem } from './AttachmentBar';
import { scanEmailLinks, checkLinkAlert } from '../../utils/linkSafety';
import { LinkSafetyModal } from '../LinkSafetyModal';
import { LinkAlertIcon } from '../LinkAlertIcon';

// ── Thread Email Item Content ────────────────────────────────────────────────

function ThreadEmailItemContent({ email, loadedEmail, isLoading, signatureDisplay, shouldShowSignature }) {
  const iframeRef = useRef(null);
  const [quotesExpanded, setQuotesExpanded] = useState(false);
  const [sigExpanded, setSigExpanded] = useState(false);
  const [linkSafetyAlert, setLinkSafetyAlert] = useState(null);
  const linkSafetyEnabled = useSettingsStore(s => s.linkSafetyEnabled);
  const linkSafetyClickConfirm = useSettingsStore(s => s.linkSafetyClickConfirm);

  const { newContent, quotedContent } = useMemo(
    () => splitQuotedContent(loadedEmail?.text || loadedEmail?.textBody || ''),
    [loadedEmail?.text, loadedEmail?.textBody]
  );

  // Split signature from the plain text content (after quote splitting)
  const { body: bodyWithoutSig, signature } = useMemo(
    () => splitSignature(newContent),
    [newContent]
  );

  // Determine if signature should be shown inline
  const showSigInline = signatureDisplay === 'always-show'
    || (signatureDisplay === 'smart' && shouldShowSignature);

  const iframeContent = useMemo(() => {
    if (!loadedEmail?.html) return '';
    const htmlWithCid = replaceCidUrls(loadedEmail.html, loadedEmail.attachments);
    const bodyMatch = htmlWithCid.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : htmlWithCid;
    let html = `
    <!DOCTYPE html>
    <html>
      <head>
        <base target="_blank">
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            padding: 16px;
            background: #ffffff;
            color: #333333;
            overflow-x: hidden;
            max-width: 100%;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-size: 14px;
            line-height: 1.6;
            word-wrap: break-word;
            overflow-wrap: break-word;
          }
          img { max-width: 100%; height: auto; }
          table { max-width: 100% !important; width: auto !important; }
          pre, code { white-space: pre-wrap; max-width: 100%; overflow-wrap: break-word; }
        </style>
      </head>
      <body>${bodyHtml}${getQuoteFoldingScript()}${getSignatureFoldingScript(signatureDisplay)}</body>
    </html>`;
    if (linkSafetyEnabled) {
      const { modifiedHtml, maxAlertLevel } = scanEmailLinks(html, email.uid);
      html = modifiedHtml;
      if (maxAlertLevel && !email._linkAlert) {
        email._linkAlert = maxAlertLevel;
        useMailStore.setState(state => ({
          emails: state.emails.map(e => e.uid === email.uid ? { ...e, _linkAlert: maxAlertLevel } : e),
          sortedEmails: state.sortedEmails.map(e => e.uid === email.uid ? { ...e, _linkAlert: maxAlertLevel } : e),
        }));
      }
    }
    return html;
  }, [loadedEmail?.html, signatureDisplay, linkSafetyEnabled]);

  // Auto-resize iframe and intercept links
  useEffect(() => {
    if (!iframeRef.current || !loadedEmail?.html) return;

    const iframe = iframeRef.current;
    let resizeTimers = [];

    const resizeIframe = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc && doc.body) {
          const height = Math.max(
            doc.body.scrollHeight,
            doc.body.offsetHeight,
            doc.documentElement?.scrollHeight || 0,
            doc.documentElement?.offsetHeight || 0
          );
          iframe.style.height = Math.max(height + 32, 100) + 'px';
        }
      } catch (e) {
        console.error('Failed to resize thread iframe:', e);
      }
    };

    const handleClick = (e) => {
      const link = e.target.closest('a');
      if (!link || !link.href) return;
      if (link.href.startsWith('cid:') || link.href.startsWith('mailto:') || link.href.startsWith('tel:') || link.href.startsWith('#')) return;
      e.preventDefault();
      e.stopPropagation();
      if (linkSafetyEnabled && linkSafetyClickConfirm) {
        const alert = checkLinkAlert(link);
        if (alert) { setLinkSafetyAlert(alert); return; }
      }
      import('@tauri-apps/plugin-shell').then(({ open }) => {
        open(link.href);
      }).catch(() => {
        window.open(link.href, '_blank');
      });
    };

    const onLoad = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) doc.addEventListener('click', handleClick);
      } catch (e) {}
      resizeIframe();
      resizeTimers.push(setTimeout(resizeIframe, 200));
      resizeTimers.push(setTimeout(resizeIframe, 1000));
    };

    const handleMessage = (e) => {
      if (e.data?.type === 'iframe-resize' && e.data.height && iframeRef.current) {
        iframeRef.current.style.height = Math.max(e.data.height + 32, 100) + 'px';
      }
    };
    window.addEventListener('message', handleMessage);

    iframe.addEventListener('load', onLoad);
    resizeTimers.push(setTimeout(resizeIframe, 100));

    return () => {
      iframe.removeEventListener('load', onLoad);
      window.removeEventListener('message', handleMessage);
      resizeTimers.forEach(t => clearTimeout(t));
    };
  }, [loadedEmail?.html]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-5 h-5 border-2 border-mail-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!loadedEmail) {
    return (
      <div className="py-3 text-sm text-mail-text-muted italic">
        {email.text || email.textBody || email.snippet || email.subject || 'No content available'}
      </div>
    );
  }

  return (
    <>
      {loadedEmail.html ? (
        <div className="rounded-lg overflow-hidden bg-white mt-2 max-w-full">
          <iframe
            ref={iframeRef}
            srcDoc={iframeContent}
            className="w-full border-0"
            style={{ minHeight: '100px', display: 'block', maxWidth: '100%' }}
            sandbox="allow-same-origin allow-popups allow-scripts"
            title={`Email from ${email.from?.name || email.from?.address}`}
          />
        </div>
      ) : (
        <div className="email-content whitespace-pre-wrap text-mail-text mt-2 text-sm break-words overflow-hidden">
          {bodyWithoutSig || 'No content'}
          {signature && signatureDisplay !== 'always-hide' && (
            showSigInline
              ? (
                <div className="mt-2 text-mail-text-muted text-xs whitespace-pre-wrap opacity-60">
                  {signature}
                </div>
              )
              : (
                <>
                  <button
                    onClick={() => setSigExpanded(prev => !prev)}
                    className="block mt-2 text-xs text-mail-text-muted hover:text-mail-accent cursor-pointer select-none"
                  >
                    {sigExpanded ? '\u25BE Hide signature' : '\u2014 Show signature'}
                  </button>
                  {sigExpanded && (
                    <div className="mt-1 text-mail-text-muted text-xs whitespace-pre-wrap opacity-60">
                      {signature}
                    </div>
                  )}
                </>
              )
          )}
          {quotedContent && (
            <>
              <button
                onClick={() => setQuotesExpanded(prev => !prev)}
                className="block mt-2 text-xs text-mail-text-muted hover:text-mail-accent bg-mail-surface border border-mail-border rounded px-2 py-0.5 cursor-pointer select-none"
              >
                {quotesExpanded ? '\u25BE Hide quoted text' : '\u22EF'}
              </button>
              {quotesExpanded && (
                <div className="mt-1 text-mail-text-muted border-l-2 border-mail-border pl-3">
                  {quotedContent}
                </div>
              )}
            </>
          )}
        </div>
      )}
      <LinkSafetyModal
        alert={linkSafetyAlert}
        onCancel={() => setLinkSafetyAlert(null)}
        onOpenAnyway={() => {
          const url = linkSafetyAlert.actualUrl;
          setLinkSafetyAlert(null);
          import('@tauri-apps/plugin-shell').then(({ open }) => open(url)).catch(() => window.open(url, '_blank'));
        }}
      />
    </>
  );
}

// ── Thread Email Item (one email in a thread conversation view) ──────────────

function ThreadEmailItem({ email, bodiesMapRef, registerListener, isLast, activeAccountId, activeMailbox, archivedEmailIds, signatureDisplay, shouldShowSignature }) {
  const [expanded, setExpanded] = useState(isLast);
  const [, forceUpdate] = useState(0);
  const [composeMode, setComposeMode] = useState(null);
  const [headerExpanded, setHeaderExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [rawSource, setRawSource] = useState(null);
  const [loadingRaw, setLoadingRaw] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const key = emailKey(email);

  // Register for body load notifications
  useEffect(() => {
    return registerListener(key, () => forceUpdate(n => n + 1));
  }, [key, registerListener]);

  const bodyEntry = bodiesMapRef.current.get(key);
  const loadedEmail = bodyEntry?.status === 'loaded' ? bodyEntry.email : null;
  const isLoading = bodyEntry?.status === 'loading';

  const realAttachments = loadedEmail ? getRealAttachments(loadedEmail.attachments, loadedEmail.html) : [];

  return (
    <div className={`border-b border-mail-border overflow-hidden ${expanded ? '' : 'hover:bg-mail-surface-hover'}`} style={{ contain: 'inline-size' }}>
      {/* Header — always visible */}
      <div
        className="flex items-start gap-2 px-3 py-2.5 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Avatar */}
        <div className="w-7 h-7 bg-mail-accent rounded-full flex items-center justify-center flex-shrink-0">
          <span className="text-white font-semibold text-[11px]">
            {(email.from?.name || email.from?.address || '?')[0].toUpperCase()}
          </span>
        </div>

        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {email.source === 'local-only' ? (
                <HardDrive size={12} className="text-mail-warning flex-shrink-0" title="Local only" />
              ) : archivedEmailIds?.has(email.uid) ? (
                <HardDrive size={12} className="text-mail-local flex-shrink-0" title="Archived" />
              ) : (
                <Cloud size={12} className="flex-shrink-0" style={{ color: 'rgba(59, 130, 246, 0.5)' }} title="Server" />
              )}
              <span className="font-semibold text-sm text-mail-text truncate">
                {email.from?.name || email.from?.address || 'Unknown'}
              </span>
              <SenderVerificationBadge email={email} />
              {email.from?.name && (
                <span className="text-xs text-mail-text-muted truncate">
                  &lt;{email.from.address}&gt;
                </span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); setShowInsights(!showInsights); }}
                className={`p-0.5 rounded transition-colors flex-shrink-0 ${showInsights ? 'text-mail-accent' : 'text-mail-text-muted hover:text-mail-text'}`}
                title="Sender insights"
              >
                <Info size={12} />
              </button>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-[11px] text-mail-text-muted">
                {format(new Date(email.date), 'MMM d, h:mm a')}
              </span>
              {expanded ? <ChevronUp size={14} className="text-mail-text-muted" /> : <ChevronDown size={14} className="text-mail-text-muted" />}
            </div>
          </div>
          {!expanded && (
            <p className="text-xs text-mail-text-muted truncate mt-0.5">
              {loadedEmail?.text?.substring(0, 200) || email.subject || ''}
            </p>
          )}
        </div>
      </div>

      {/* Sender Insights (thread email) */}
      <AnimatePresence>
        {showInsights && email?.from?.address && (
          <SenderInsightsPanel senderEmail={email.from.address} />
        )}
      </AnimatePresence>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 overflow-hidden" style={{ contain: 'inline-size' }}>
          {/* To/CC line */}
          <div className="text-xs text-mail-text-muted mb-2 pl-9">
            <div>
              To: {(Array.isArray(email.to) ? email.to : []).map(t => t.name || t.address).join(', ') || 'Unknown'}
              {email.cc?.length > 0 && (
                <span className="ml-2">CC: {email.cc.map(c => c.name || c.address).join(', ')}</span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); setHeaderExpanded(!headerExpanded); }}
                className="ml-2 text-mail-accent hover:underline"
              >
                {headerExpanded ? 'Less' : 'More'}
              </button>
            </div>
            <AnimatePresence>
              {headerExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="mt-1 space-y-0.5 overflow-hidden"
                >
                  <div>Date: {format(new Date(email.date), 'PPpp')}</div>
                  {email.messageId && <div className="break-all">Message-ID: {email.messageId}</div>}
                  {email.replyTo?.length > 0 && (
                    <div>Reply-To: {email.replyTo.map(r => r.address || r).join(', ')}</div>
                  )}
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (showRaw) { setShowRaw(false); return; }
                      if (!rawSource) {
                        setLoadingRaw(true);
                        try {
                          const isTauri = !!window.__TAURI__;
                          if (isTauri) {
                            const { invoke } = window.__TAURI__.core;
                            const b64 = await invoke('maildir_read_raw_source', {
                              accountId: activeAccountId,
                              mailbox: activeMailbox,
                              uid: email.uid,
                            });
                            setRawSource(b64);
                          }
                        } catch (err) {
                          console.error('[ThreadEmailItem] Failed to load raw source:', err);
                        } finally {
                          setLoadingRaw(false);
                        }
                      }
                      setShowRaw(true);
                    }}
                    disabled={loadingRaw}
                    className={`mt-1 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                               ${showRaw
                                 ? 'bg-mail-accent text-white'
                                 : 'bg-mail-surface hover:bg-mail-surface-hover text-mail-text-muted'}
                               disabled:opacity-50`}
                  >
                    {loadingRaw ? <RefreshCw size={12} className="animate-spin" /> : <Code size={12} />}
                    {loadingRaw ? 'Loading...' : showRaw ? 'Rendered' : 'View Source'}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Body */}
          <div className="pl-9 overflow-hidden" style={{ contain: 'inline-size' }}>
            {showRaw && rawSource ? (
              <pre className="text-xs font-mono text-mail-text bg-mail-surface rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-all">
                {atob(rawSource)}
              </pre>
            ) : (
              <ThreadEmailItemContent email={email} loadedEmail={loadedEmail} isLoading={isLoading} signatureDisplay={signatureDisplay} shouldShowSignature={shouldShowSignature} />
            )}
          </div>

          {/* Attachments */}
          {realAttachments.length > 0 && (
            <div className="mt-3 pl-9">
              <div className="flex items-center gap-2 text-xs text-mail-text-muted mb-2">
                <Paperclip size={12} />
                <span>{realAttachments.length} Attachment{realAttachments.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {realAttachments.map((attachment, index) => (
                  <AttachmentItem
                    key={index}
                    attachment={attachment}
                    attachmentIndex={attachment._originalIndex}
                    emailUid={email.uid}
                    account={activeAccountId}
                    folder={activeMailbox}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Reply actions */}
          <div className="flex items-center gap-2 mt-3 pl-9">
            <button
              onClick={(e) => { e.stopPropagation(); setComposeMode('reply'); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-mail-text-muted
                        bg-mail-surface hover:bg-mail-surface-hover rounded-lg border border-mail-border transition-colors"
            >
              <Reply size={14} />
              Reply
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setComposeMode('replyAll'); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-mail-text-muted
                        bg-mail-surface hover:bg-mail-surface-hover rounded-lg border border-mail-border transition-colors"
            >
              <ReplyAll size={14} />
              Reply All
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setComposeMode('forward'); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-mail-text-muted
                        bg-mail-surface hover:bg-mail-surface-hover rounded-lg border border-mail-border transition-colors"
            >
              <Forward size={14} />
              Forward
            </button>
          </div>
        </div>
      )}

      {/* Compose Modal for this email */}
      <AnimatePresence>
        {composeMode && (
          <ComposeModal
            mode={composeMode}
            replyTo={loadedEmail || email}
            onClose={() => setComposeMode(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Thread View (shows all emails in a thread) ──────────────────────────────

export function ThreadView({ thread }) {
  const { activeAccountId, activeMailbox, savedEmailIds, archivedEmailIds, saveEmailsLocally } = useMailStore(
    useShallow(s => ({ activeAccountId: s.activeAccountId, activeMailbox: s.activeMailbox, savedEmailIds: s.savedEmailIds, archivedEmailIds: s.archivedEmailIds, saveEmailsLocally: s.saveEmailsLocally }))
  );
  const signatureDisplay = useSettingsStore(s => s.signatureDisplay);
  const threadSortOrder = useSettingsStore(s => s.threadSortOrder);
  const [saving, setSaving] = useState(false);
  const scrollContainerRef = useRef(null);
  const lastEmailRef = useRef(null);

  // Sort emails by user preference (oldest-first or newest-first)
  const sortedEmails = useMemo(() =>
    [...thread.emails].sort((a, b) =>
      threadSortOrder === 'newest-first'
        ? new Date(b.date) - new Date(a.date)
        : new Date(a.date) - new Date(b.date)
    ),
    [thread.emails, threadSortOrder]
  );

  const { bodiesMapRef, registerListener } = useChatBodyLoader(sortedEmails);

  // Smart mode: track seen signatures per sender to show only first occurrence
  const sigVisMap = useMemo(() => {
    if (signatureDisplay !== 'smart') return {};
    const seenBySender = {};
    const result = {};
    for (const email of sortedEmails) {
      const sender = email.from?.address || '';
      const body = bodiesMapRef.current?.get(emailKey(email));
      const text = body?.email?.text || body?.email?.textBody || '';
      const { signature } = splitSignature(text);
      const sigHash = hashSignature(signature);

      if (!seenBySender[sender]) seenBySender[sender] = new Set();

      if (!signature || !sigHash) {
        result[email.uid] = true;
      } else if (!seenBySender[sender].has(sigHash)) {
        seenBySender[sender].add(sigHash);
        result[email.uid] = true; // first occurrence — show
      } else {
        result[email.uid] = false; // duplicate — collapse
      }
    }
    return result;
  }, [sortedEmails, signatureDisplay]);

  // Scroll to the newest (last) email on mount — scoped to the scroll container
  const threadId = thread.threadId;
  useEffect(() => {
    const timer = setTimeout(() => {
      if (lastEmailRef.current && scrollContainerRef.current) {
        const container = scrollContainerRef.current;
        const el = lastEmailRef.current;
        container.scrollTop = el.offsetTop;
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [threadId]);

  const allArchived = thread.emails.every(e => archivedEmailIds.has(e.uid));

  const handleArchiveThread = async () => {
    setSaving(true);
    try {
      const uids = thread.emails.filter(em => !archivedEmailIds.has(em.uid)).map(em => em.uid);
      if (uids.length > 0) await saveEmailsLocally(uids);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-mail-bg overflow-hidden min-h-0 min-w-0 h-full">
      {/* Thread header */}
      <div data-tauri-drag-region className="flex items-center justify-between px-3 py-2.5 border-b border-mail-border">
        <div className="flex flex-col justify-center flex-1 min-w-0 min-h-[34px]">
          <h1 className="text-sm font-semibold text-mail-text truncate">
            {thread.subject}
          </h1>
          <span className="text-xs text-mail-text-muted">
            {thread.messageCount} message{thread.messageCount !== 1 ? 's' : ''} in thread
          </span>
        </div>

        {!allArchived && (
          <button
            onClick={handleArchiveThread}
            disabled={saving}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm
                      font-medium transition-colors disabled:opacity-50 ml-2 text-mail-local"
            style={{ backgroundColor: 'color-mix(in srgb, var(--mail-local) 10%, transparent)' }}
            onMouseEnter={e => e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--mail-local) 20%, transparent)'}
            onMouseLeave={e => e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--mail-local) 10%, transparent)'}
          >
            <Archive size={14} />
            {saving ? 'Archiving...' : 'Archive All'}
          </button>
        )}
      </div>

      {/* Thread emails — w-0 min-w-full prevents children from expanding container beyond viewport */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 w-full" style={{ contain: 'inline-size' }}>
        {sortedEmails.map((email, idx) => {
          const isLast = idx === sortedEmails.length - 1;
          return (
            <div key={emailKey(email)} ref={isLast ? lastEmailRef : undefined} className="w-full overflow-hidden" style={{ contain: 'inline-size' }}>
              <ThreadEmailItem
                email={email}
                bodiesMapRef={bodiesMapRef}
                registerListener={registerListener}
                isLast={isLast}
                activeAccountId={activeAccountId}
                activeMailbox={activeMailbox}
                archivedEmailIds={archivedEmailIds}
                signatureDisplay={signatureDisplay}
                shouldShowSignature={sigVisMap[email.uid] !== false}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
