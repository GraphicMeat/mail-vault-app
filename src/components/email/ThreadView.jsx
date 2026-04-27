import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useMailStore } from '../../stores/mailStore';
import { useAccountStore } from '../../stores/accountStore';
import { useMessageListStore } from '../../stores/messageListStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence } from 'framer-motion';
import { ComposeModal } from '../ComposeModal';
import { useChatBodyLoader, emailKey } from '../../hooks/useChatBodyLoader';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../../utils/iframeQuoteFolding';
import { splitQuotedContent } from '../../utils/quoteFolding';
import { splitSignature, hashSignature } from '../../utils/signatureFolding';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThemeStore } from '../../stores/themeStore';
import { buildEmailIframeHtml, getEmailBodyContent } from '../../utils/emailIframeTemplate';
import { getDarkReaderInlineScripts } from '../../utils/darkReaderInject';
import {
  Paperclip,
  Archive,
} from 'lucide-react';
import { getRealAttachments, replaceCidUrls } from '../../services/attachmentUtils';
import { SenderInsightsPanel } from '../SenderInsightsPanel';
import { EmailSenderInfo } from './EmailSenderInfo';
import { EmailActionBar } from './EmailActionBar';
import { AttachmentItem } from './AttachmentBar';
import { scanEmailLinks, checkLinkAlert } from '../../utils/linkSafety';
import { getSenderName } from '../../utils/emailParser';
import { LinkSafetyModal } from '../LinkSafetyModal';
import { LinkAlertIcon } from '../LinkAlertIcon';

// ── Thread Email Item Content ────────────────────────────────────────────────

function ThreadEmailItemContent({ email, loadedEmail, isLoading, signatureDisplay, shouldShowSignature, effectiveTheme }) {
  const iframeRef = useRef(null);
  const [quotesExpanded, setQuotesExpanded] = useState(false);
  const [sigExpanded, setSigExpanded] = useState(false);
  const [linkSafetyAlert, setLinkSafetyAlert] = useState(null);
  const linkSafetyEnabled = useSettingsStore(s => s.linkSafetyEnabled);
  const linkSafetyClickConfirm = useSettingsStore(s => s.linkSafetyClickConfirm);
  const appTheme = useThemeStore(s => s.theme);
  const theme = effectiveTheme ?? appTheme;
  const isDark = theme === 'dark';

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

  const { iframeContent, scanAlertLevel: threadScanAlert } = useMemo(() => {
    if (!loadedEmail?.html) return { iframeContent: '', scanAlertLevel: null };
    const htmlWithCid = replaceCidUrls(loadedEmail.html, loadedEmail.attachments);
    const bodyHtml = getEmailBodyContent(htmlWithCid);
    // Scan body (stable per uid → cacheable); wrap with iframe template so
    // theme toggles don't invalidate the scan cache.
    let renderedBody = bodyHtml;
    let indicatorStyle = '';
    let alertLevel = null;
    if (linkSafetyEnabled) {
      const scan = scanEmailLinks(bodyHtml, email.uid);
      renderedBody = scan.modifiedBodyHtml;
      indicatorStyle = scan.indicatorStyle;
      alertLevel = scan.maxAlertLevel;
    }
    // Light baseline; DR inlined when dark so it runs during load —
    // no post-load injection race, no flash on theme toggle.
    const extraHead = `${isDark ? getDarkReaderInlineScripts() : ''}${indicatorStyle ? `<style>${indicatorStyle}</style>` : ''}`;
    const html = buildEmailIframeHtml({
      bodyHtml: renderedBody,
      themeTag: theme,
      extraHead,
      extraBody: `${getQuoteFoldingScript()}${getSignatureFoldingScript(signatureDisplay)}`,
    });
    return { iframeContent: html, scanAlertLevel: alertLevel };
  }, [loadedEmail?.html, signatureDisplay, linkSafetyEnabled, theme]);

  // Persist link alert outside render
  useEffect(() => {
    if (threadScanAlert && !email._linkAlert) {
      email._linkAlert = threadScanAlert;
      useMailStore.setState(state => ({
        emails: state.emails.map(e => e.uid === email.uid ? { ...e, _linkAlert: threadScanAlert } : e),
        sortedEmails: state.sortedEmails.map(e => e.uid === email.uid ? { ...e, _linkAlert: threadScanAlert } : e),
      }));
      useSettingsStore.getState().setLinkAlert(email.uid, threadScanAlert);
    }
  }, [threadScanAlert, email.uid]);

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
        // Dark Reader is inlined into the iframe HTML (see useMemo above);
        // runs during load, so no post-load injection is needed here.
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
    // Theme is NOT a dep: DR is inlined into the iframe HTML (see useMemo),
    // so theme toggles don't need to tear down the load listener.
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
        <div
          className="rounded-lg overflow-hidden mt-2 max-w-full"
          style={{ backgroundColor: isDark ? '#0a0a0f' : '#ffffff' }}
        >
          <iframe
            ref={iframeRef}
            srcDoc={iframeContent}
            className="w-full border-0"
            style={{ minHeight: '100px', display: 'block', maxWidth: '100%' }}
            sandbox="allow-same-origin allow-popups allow-scripts"
            title={`Email from ${getSenderName(email)}`}
          />
        </div>
      ) : (
        <div
          className="email-content whitespace-pre-wrap mt-2 text-sm break-words overflow-hidden rounded-lg p-3"
          style={{
            backgroundColor: isDark ? '#0a0a0f' : '#ffffff',
            color: isDark ? '#e4e4e7' : '#333333',
          }}
        >
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

function ThreadEmailItem({ email, bodiesMapRef, registerListener, isNewest, activeAccountId, activeMailbox, archivedEmailIds, signatureDisplay, shouldShowSignature }) {
  const [expanded, setExpanded] = useState(isNewest);
  const [, forceUpdate] = useState(0);
  const [composeMode, setComposeMode] = useState(null);
  const [headerExpanded, setHeaderExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [rawSource, setRawSource] = useState(null);
  const [loadingRaw, setLoadingRaw] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const [emailThemeOverride, setEmailThemeOverride] = useState(null);
  const appTheme = useThemeStore(s => s.theme);
  const emailViewerTheme = useSettingsStore(s => s.emailViewerTheme);
  // Default: user preference ('light'|'dark') or follow app theme.
  const defaultEmailTheme = emailViewerTheme === 'system' ? appTheme : emailViewerTheme;
  const effectiveTheme = emailThemeOverride ?? defaultEmailTheme;
  const emailDarkMode = effectiveTheme === 'dark';
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
      <div onClick={() => setExpanded(!expanded)}>
        <EmailSenderInfo
          email={email}
          variant="thread"
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
          showRaw={showRaw}
          onToggleRaw={async () => {
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
          loadingRaw={loadingRaw}
          showInsights={showInsights}
          onToggleInsights={() => setShowInsights(!showInsights)}
          archivedEmailIds={archivedEmailIds}
        />
        {!expanded && (
          <p className="text-xs text-mail-text-muted truncate mt-0.5 pl-12 pb-1">
            {loadedEmail?.text?.substring(0, 200) || email.subject || ''}
          </p>
        )}
      </div>

      {/* Action bar — below sender info, above content */}
      {expanded && (
        <div className="px-3 pb-1">
          <EmailActionBar
            email={email}
            variant="thread"
            onReply={() => setComposeMode('reply')}
            onReplyAll={() => setComposeMode('replyAll')}
            onForward={() => setComposeMode('forward')}
            onArchive={null}
            onDelete={null}
            onMove={null}
            onToggleRead={null}
            onOpenInWindow={() => {
              const invoke = window.__TAURI__?.core?.invoke;
              if (!invoke) return;
              const bodyEntry = bodiesMapRef.current.get(key);
              const loaded = bodyEntry?.email;
              const rawHtml = loaded?.html || '';
              if (!rawHtml) return;
              const bodyHtml = getEmailBodyContent(rawHtml);
              const popupHtml = buildEmailIframeHtml({
                bodyHtml,
                themeTag: effectiveTheme,
                extraHead: emailDarkMode ? getDarkReaderInlineScripts() : '',
              });
              invoke('open_email_window', { html: popupHtml, title: email.subject || 'Email' });
            }}
            onViewSource={async () => {
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
            onToggleEmailTheme={() => setEmailThemeOverride(emailDarkMode ? 'light' : 'dark')}
            emailThemeDark={emailDarkMode}
            isArchived={archivedEmailIds?.has(email.uid)}
            isRead={!email.flags?.includes('\\Unseen')}
            isLocalOnly={email.source === 'local-only'}
            isSentEmail={false}
            singleRecipient={(email.to || []).length <= 1 && !(email.cc?.length > 0)}
          />
        </div>
      )}

      {/* Sender Insights (thread email) */}
      <AnimatePresence>
        {showInsights && email?.from?.address && (
          <SenderInsightsPanel senderEmail={email.from.address} />
        )}
      </AnimatePresence>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 overflow-hidden" style={{ contain: 'inline-size' }}>
          {/* Body */}
          <div className="pl-9 overflow-hidden" style={{ contain: 'inline-size' }}>
            {showRaw && rawSource ? (
              <pre className="text-xs font-mono text-mail-text bg-mail-surface rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-all">
                {atob(rawSource)}
              </pre>
            ) : (
              <ThreadEmailItemContent email={email} loadedEmail={loadedEmail} isLoading={isLoading} signatureDisplay={signatureDisplay} shouldShowSignature={shouldShowSignature} effectiveTheme={effectiveTheme} />
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
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const activeMailbox = useAccountStore(s => s.activeMailbox);
  const savedEmailIds = useMessageListStore(s => s.savedEmailIds);
  const archivedEmailIds = useMessageListStore(s => s.archivedEmailIds);
  const saveEmailsLocally = useSelectionStore(s => s.saveEmailsLocally);
  const signatureDisplay = useSettingsStore(s => s.signatureDisplay);
  const threadSortOrder = useSettingsStore(s => s.threadSortOrder);
  const [saving, setSaving] = useState(false);
  const scrollContainerRef = useRef(null);

  // Sort emails by user preference (oldest-first or newest-first)
  const sortedEmails = useMemo(() =>
    [...thread.emails].sort((a, b) =>
      threadSortOrder === 'newest-first'
        ? new Date(b.date) - new Date(a.date)
        : new Date(a.date) - new Date(b.date)
    ),
    [thread.emails, threadSortOrder]
  );

  // Determine newest email by date (sort-order independent)
  const newestUid = useMemo(() => {
    if (!thread.emails.length) return null;
    return thread.emails.reduce((newest, email) =>
      new Date(email.date) > new Date(newest.date) ? email : newest
    ).uid;
  }, [thread.emails]);

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

  const THREAD_ROW_HEIGHT = 72;
  const virtualizer = useVirtualizer({
    count: sortedEmails.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => THREAD_ROW_HEIGHT,
    overscan: 8,
    measureElement: (el) => el?.getBoundingClientRect().height ?? THREAD_ROW_HEIGHT,
  });

  // Scroll to the newest (last) email on mount — scoped to the scroll container
  const threadId = thread.threadId;
  useEffect(() => {
    const timer = setTimeout(() => {
      if (sortedEmails.length > 0) {
        virtualizer.scrollToIndex(sortedEmails.length - 1, { align: 'end' });
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

      {/* Thread emails — virtualized */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 w-full" style={{ contain: 'inline-size' }}>
        <div style={{ height: virtualizer.getTotalSize() + 'px', position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((vr) => {
            const email = sortedEmails[vr.index];
            if (!email) return null;
            const isNewest = email.uid === newestUid;
            return (
              <div
                key={vr.key}
                data-index={vr.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  width: '100%',
                  transform: `translateY(${vr.start}px)`,
                }}
              >
                <ThreadEmailItem
                  email={email}
                  bodiesMapRef={bodiesMapRef}
                  registerListener={registerListener}
                  isNewest={isNewest}
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
    </div>
  );
}
