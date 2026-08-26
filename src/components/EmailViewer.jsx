import React, { memo, useState, useEffect, useRef, useMemo } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useMessageListStore } from '../stores/messageListStore';
import { useAccountStore } from '../stores/accountStore';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Paperclip,
  Download,
  HardDrive,
  CloudOff,
  Cloud,
  FileText,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { getRealAttachments, replaceCidUrls } from '../services/attachmentUtils';
import { describeMessageState } from './email/MessageStateIcon';
import { useCustodyLanding } from '../hooks/useCustodyLanding';
import { MoveToFolderDropdown } from './MoveToFolderDropdown';
import { SenderInsightsPanel } from './SenderInsightsPanel';
import { ThreadView } from './email/ThreadView';
import { EmailSenderInfo } from './email/EmailSenderInfo';
import { EmailActionBar } from './email/EmailActionBar';
import { AttachmentItem, DownloadAllButton } from './email/AttachmentBar';
import { scanEmailLinks, checkLinkAlert } from '../utils/linkSafety';
import { LinkSafetyModal } from './LinkSafetyModal';
import { LinkAlertIcon } from './LinkAlertIcon';
import { SenderAlertIcon } from './SenderAlertIcon';
import { ReplyToAlertIcon } from './ReplyToAlertIcon';
import { getCachedAlerts } from '../utils/linkSafety';
import { emailScopeKey } from '../stores/slices/unifiedHelpers';
import { useSettingsStore } from '../stores/settingsStore';
import { useThemeStore } from '../stores/themeStore';
import { buildEmailIframeHtml, getEmailBodyContent, getContextMenuColors, measureEmailIframeHeight } from '../utils/emailIframeTemplate';
import { getDarkReaderInlineScripts } from '../utils/darkReaderInject';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../utils/iframeQuoteFolding';
import { MAIL_DARK_BG, MAIL_DARK_TEXT } from '../utils/mailChrome';

// Re-export AttachmentItem for any external consumers
export { AttachmentItem } from './email/AttachmentBar';

// ── Single Email Viewer ─────────────────────────────────────────────────────

function EmailViewerComponent({ onComposeReply }) {
  const selectedEmail = useSelectionStore(s => s.selectedEmail);
  const selectedEmailSource = useSelectionStore(s => s.selectedEmailSource);
  const selectedThread = useSelectionStore(s => s.selectedThread);
  const loadingEmail = useSelectionStore(s => s.loadingEmail);
  const savedEmailIds = useMessageListStore(s => s.savedEmailIds);
  const archivedEmailIds = useMessageListStore(s => s.archivedEmailIds);
  const saveEmailLocally = useSelectionStore(s => s.saveEmailLocally);
  const removeLocalEmail = useSelectionStore(s => s.removeLocalEmail);
  const exportEmail = useSelectionStore(s => s.exportEmail);
  const markEmailReadStatus = useSelectionStore(s => s.markEmailReadStatus);
  const selectEmail = useSelectionStore(s => s.selectEmail);
  const deleteEmailFromServer = useSelectionStore(s => s.deleteEmailFromServer);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const activeMailbox = useAccountStore(s => s.activeMailbox);
  // Gold requires proof of server absence, so the band reads the same
  // uid-set completeness flag ConnectedStateIcon does — never `isLocalOnly`
  // on its own, which is only "the list didn't have it".
  const serverKnown = useMailStore(s => s.serverUids.complete);

  const linkSafetyEnabled = useSettingsStore(s => s.linkSafetyEnabled);
  const linkSafetyClickConfirm = useSettingsStore(s => s.linkSafetyClickConfirm);
  const emailViewerTheme = useSettingsStore(s => s.emailViewerTheme);
  const signatureDisplay = useSettingsStore(s => s.signatureDisplay);
  const appTheme = useThemeStore(s => s.theme);
  // Default email theme: user preference ('light'|'dark') or follow app theme.
  const theme = emailViewerTheme === 'system' ? appTheme : emailViewerTheme;
  const [linkSafetyAlert, setLinkSafetyAlert] = useState(null);
  const [headerExpanded, setHeaderExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingRead, setTogglingRead] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUnarchive, setConfirmUnarchive] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [rawSource, setRawSource] = useState(null);
  const [loadingRaw, setLoadingRaw] = useState(false);
  const [showMoveDropdown, setShowMoveDropdown] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  // Per-email theme override. null = follow app theme; 'light'|'dark' = forced.
  const [emailThemeOverride, setEmailThemeOverride] = useState(null);
  const moveButtonRef = useRef(null);
  const iframeRef = useRef(null);

  const effectiveEmailTheme = emailThemeOverride ?? theme;
  const emailDarkMode = effectiveEmailTheme === 'dark';

  const isCached = selectedEmail && savedEmailIds.has(selectedEmail.uid);
  const isArchived = selectedEmail && archivedEmailIds.has(selectedEmail.uid);
  const isLocalOnly = selectedEmailSource === 'local-only';
  const isRead = selectedEmail?.flags?.includes('\\Seen');
  // One custody statement per message, in the vocabulary the rows already use.
  //
  // The row's chip and this band are two visible claims about the same message,
  // so they have to read the same fields or they will contradict each other on
  // screen. The row goes through `describeMessageState(email, …)` — the email's
  // own `isArchived`/`source`. This band was reading two *store* sets instead
  // (`archivedEmailIds`, and the selection store's `selectedEmailSource`), a
  // third carrier of provenance that a click has to keep populated. Read the
  // message first and let the optimistic sets only ADD archived state, which is
  // the one direction they ever move within a session.
  //
  // NOT `selectedEmailSource`. That field's declared contract is
  // `'server' | 'local' | 'local-only'` (selectionSlice.js), but
  // selectEmail.js also writes `'header-only'` into it to mean the BODY has not
  // been fetched — a loading state wearing a provenance field's name. Reading
  // it here rendered "Saved in your vault" over a row whose own glyph said
  // "your only copy", because 'header-only' is simply not 'local-only'.
  const custody = describeMessageState(
    { isArchived: isArchived || !!selectedEmail?.isArchived, source: selectedEmail?.source },
    { serverKnown }
  );

  // Reset view states when switching emails
  useEffect(() => {
    setShowRaw(false);
    setRawSource(null);
    setConfirmDelete(false);
    setConfirmUnarchive(false);
    setShowInsights(false);
    setEmailThemeOverride(null);
  }, [selectedEmail?.uid]);

  const handleSave = async () => {
    if (!selectedEmail) return;
    setSaving(true);
    try {
      await saveEmailLocally(selectedEmail.uid);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveLocal = () => {
    if (!selectedEmail) return;
    setConfirmUnarchive(true);
  };

  const confirmRemoveLocal = async () => {
    setConfirmUnarchive(false);
    await removeLocalEmail(selectedEmail.uid);
  };

  const handleExport = async () => {
    if (!selectedEmail) return;
    const exported = await exportEmail(selectedEmail.uid);
    if (!exported) return;

    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { invoke } = window.__TAURI__.core;

      const destPath = await save({
        defaultPath: exported.filename,
        title: 'Export Email',
      });
      if (!destPath) return; // user cancelled

      await invoke('save_attachment_to', {
        filename: exported.filename,
        contentBase64: exported.rawBase64,
        destPath,
      });
    } catch (err) {
      console.error('[Export] Save As failed:', err);
    }
  };

  const handleToggleReadStatus = async () => {
    if (!selectedEmail || togglingRead) return;
    setTogglingRead(true);
    try {
      await markEmailReadStatus(selectedEmail.uid, !isRead);
    } finally {
      setTogglingRead(false);
    }
  };

  const handleDelete = () => {
    if (!selectedEmail || deleting) return;
    setConfirmDelete(true);
  };

  const confirmDeleteEmail = async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await deleteEmailFromServer(selectedEmail.uid);
    } finally {
      setDeleting(false);
    }
  };

  // Render email with theme-aware iframe (low-specificity body defaults;
  // inline email styles always win). Also sets color-scheme so emails with
  // `@media (prefers-color-scheme: dark)` honor the app theme, not the OS.
  // `accountId-mailbox-uid`, not the bare uid: the scan cache and the persisted
  // alert map are both shared across accounts and folders.
  const scopeKey = selectedEmail ? emailScopeKey(selectedEmail, useMailStore.getState()) : null;
  // The same handoff the row plays, at reading-pane scale: archive the message
  // you are reading and the band above it hands over while you watch, instead
  // of having quietly always said what it now says.
  const custodyLanded = useCustodyLanding(scopeKey, custody.tone);

  const { iframeContent, scanAlertLevel } = useMemo(() => {
    if (!selectedEmail?.html) return { iframeContent: '', scanAlertLevel: null };
    const bodyHtml = getEmailBodyContent(replaceCidUrls(selectedEmail.html, selectedEmail.attachments));
    // Scan body HTML (stable per uid → cacheable); theme/DR is layered on
    // top via buildEmailIframeHtml so toggling theme doesn't invalidate the
    // scan cache or strip Dark Reader scripts from a cached modifiedHtml.
    let renderedBody = bodyHtml;
    let indicatorStyle = '';
    let alertLevel = null;
    if (linkSafetyEnabled) {
      const scan = scanEmailLinks(bodyHtml, scopeKey);
      renderedBody = scan.modifiedBodyHtml;
      indicatorStyle = scan.indicatorStyle;
      alertLevel = scan.maxAlertLevel;
    }
    // Light baseline always. When dark, Dark Reader is INLINED into the
    // iframe HTML (not injected post-load) so it runs during page load —
    // eliminates the load-event race and prevents a flash of light content
    // on theme toggle. srcDoc diff on theme change still forces reload.
    const extraHead = `${emailDarkMode ? getDarkReaderInlineScripts() : ''}${indicatorStyle ? `<style>${indicatorStyle}</style>` : ''}`;
    const html = buildEmailIframeHtml({
      bodyHtml: renderedBody,
      themeTag: effectiveEmailTheme,
      extraHead,
      extraBody: `${getQuoteFoldingScript()}${getSignatureFoldingScript(signatureDisplay)}`,
    });
    return { iframeContent: html, scanAlertLevel: alertLevel };
  }, [selectedEmail?.html, scopeKey, linkSafetyEnabled, effectiveEmailTheme, signatureDisplay]);

  // Persist link alert to store + settings (outside render, in useEffect)
  useEffect(() => {
    if (scanAlertLevel && selectedEmail && !selectedEmail._linkAlert) {
      useMailStore.setState(state => ({
        selectedEmail: { ...state.selectedEmail, _linkAlert: scanAlertLevel },
        // Match on the scoped key, not the uid: in unified inbox `emails`
        // spans accounts, and every row sharing the number would light up.
        emails: state.emails.map(e => scopeKey && emailScopeKey(e, state) === scopeKey ? { ...e, _linkAlert: scanAlertLevel } : e),
        sortedEmails: state.sortedEmails.map(e => scopeKey && emailScopeKey(e, state) === scopeKey ? { ...e, _linkAlert: scanAlertLevel } : e),
      }));
      useSettingsStore.getState().setLinkAlert(scopeKey, scanAlertLevel);
    }
  }, [scanAlertLevel, scopeKey]);

  // Auto-resize iframe and apply dark mode overrides
  useEffect(() => {
    if (!iframeRef.current || !selectedEmail?.html) return;

    const iframe = iframeRef.current;
    let resizeTimers = [];

    const resizeIframe = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        const height = measureEmailIframeHeight(doc);
        if (height) iframe.style.height = Math.max(height + 8, 300) + 'px';
      } catch (e) {
        console.error('Failed to resize iframe:', e);
      }
    };

    // Named handlers so we can remove them in cleanup
    const handleClick = (e) => {
      const link = e.target.closest('a');
      if (!link || !link.href) return;
      if (link.href.startsWith('cid:') || link.href.startsWith('mailto:') || link.href.startsWith('tel:') || link.href.startsWith('#')) return;
      e.preventDefault();
      e.stopPropagation();
      // Check link safety before opening
      if (linkSafetyEnabled && linkSafetyClickConfirm) {
        const alert = checkLinkAlert(link);
        if (alert) {
          setLinkSafetyAlert(alert);
          return;
        }
      }
      const url = link.href;
      import('@tauri-apps/plugin-shell').then(({ open }) => {
        open(url);
      }).catch(() => {
        window.open(url, '_blank');
      });
    };

    const handleContextMenu = (e) => {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;
      e.preventDefault();
      const existing = doc.getElementById('mv-ctx-menu');
      if (existing) existing.remove();
      // Always emit light colors; Dark Reader will invert them in dark mode
      // via its MutationObserver (it catches the dynamically-added menu).
      const { menuBg, menuBorder, menuShadow, itemColor, itemHoverBg } = getContextMenuColors();
      const menu = doc.createElement('div');
      menu.id = 'mv-ctx-menu';
      menu.style.cssText = `position:fixed;z-index:99999;background:${menuBg};border:1px solid ${menuBorder};border-radius:6px;padding:4px 0;min-width:180px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;box-shadow:${menuShadow};`;
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      const items = [
        { label: 'Copy', action: () => doc.execCommand('copy') },
        { label: 'Select All', action: () => doc.execCommand('selectAll') },
      ];
      items.forEach(({ label, action }) => {
        const item = doc.createElement('div');
        item.textContent = label;
        item.style.cssText = `padding:6px 14px;cursor:pointer;color:${itemColor};`;
        item.onmouseover = () => item.style.background = itemHoverBg;
        item.onmouseout = () => item.style.background = 'none';
        item.onclick = () => { action(); menu.remove(); };
        menu.appendChild(item);
      });
      doc.body.appendChild(menu);
      const close = () => { menu.remove(); doc.removeEventListener('click', close); };
      setTimeout(() => doc.addEventListener('click', close), 0);
    };

    let currentDoc = null;

    const onLoad = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) return;
        // Remove listeners from previous document if any
        if (currentDoc && currentDoc !== doc) {
          currentDoc.removeEventListener('click', handleClick);
          currentDoc.removeEventListener('contextmenu', handleContextMenu);
        }
        currentDoc = doc;
        doc.addEventListener('click', handleClick);
        doc.addEventListener('contextmenu', handleContextMenu);
        // Dark Reader is inlined into the iframe HTML (see useMemo above);
        // it runs during load, so no post-load injection is needed here.
      } catch (e) {
        console.error('Failed to intercept iframe links:', e);
      }
      resizeIframe();
      resizeTimers.push(setTimeout(resizeIframe, 200));
      resizeTimers.push(setTimeout(resizeIframe, 1000));
    };

    // Quote/signature toggles inside the iframe post their new height.
    const handleMessage = (e) => {
      if (e.data?.type === 'iframe-resize' && e.data.height && iframeRef.current) {
        iframeRef.current.style.height = Math.max(e.data.height + 8, 300) + 'px';
      }
    };
    window.addEventListener('message', handleMessage);

    iframe.addEventListener('load', onLoad);
    resizeTimers.push(setTimeout(resizeIframe, 100));

    return () => {
      iframe.removeEventListener('load', onLoad);
      window.removeEventListener('message', handleMessage);
      resizeTimers.forEach(t => clearTimeout(t));
      if (currentDoc) {
        try {
          currentDoc.removeEventListener('click', handleClick);
          currentDoc.removeEventListener('contextmenu', handleContextMenu);
        } catch { /* iframe may already be detached */ }
      }
    };
    // Theme is NOT a dep: DR is now inlined into the iframe HTML (via the
    // iframeContent useMemo), so theme toggles don't need to tear down and
    // re-attach the load listener — which would race with the iframe reload
    // that srcDoc changes trigger.
  }, [selectedEmail?.html]);

  // Thread view — show all emails in the thread
  if (selectedThread) {
    return <ThreadView thread={selectedThread} onComposeReply={onComposeReply} />;
  }

  if (!selectedEmail && !loadingEmail) {
    return (
      <div className="flex-1 flex items-center justify-center bg-mail-bg h-full min-h-0">
        <div className="text-center text-mail-text-muted">
          <FileText size={48} className="mx-auto mb-4 opacity-30" />
          <p>Select an email to read</p>
        </div>
      </div>
    );
  }

  if (loadingEmail) {
    return (
      <div
        data-testid="email-viewer-loading"
        className="flex-1 flex flex-col items-center justify-center gap-3 bg-mail-bg h-full min-h-0"
      >
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
          className="w-8 h-8 border-2 border-mail-accent border-t-transparent rounded-full"
        />
        <p className="text-sm text-mail-text-muted">Loading message…</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-mail-bg overflow-hidden min-h-0 min-w-0 h-full relative">
      {/* Drag region */}
      <div data-tauri-drag-region className="h-2 border-b border-mail-border" />

      {/* Subject */}
      <div key={scopeKey} className="viewer-swap px-3 py-2.5 border-b border-mail-border flex items-start gap-2">
        <h1 className="text-lg font-semibold text-mail-text flex-1 min-w-0 flex items-center gap-1.5">
          <SenderAlertIcon level={selectedEmail._senderAlert} email={selectedEmail} size={18} />
          <ReplyToAlertIcon mismatch={selectedEmail._replyToMismatch} size={18} />
          <LinkAlertIcon level={selectedEmail._linkAlert} size={18} alerts={getCachedAlerts(scopeKey)} />
          {selectedEmail.subject}
        </h1>
      </div>

      {/* Custody band — the reading pane opens under the claim about where this
          message lives. Same words the row glyph's tooltip uses; the tint is a
          solid custody surface, so the text contrast on it is a fixed number. */}
      <div
        data-testid="email-custody-band"
        data-tone={custody.tone}
        data-landed={custodyLanded || undefined}
        className={`custody-band flex items-center gap-2 px-3 py-1.5 border-b border-mail-border text-xs
                   ${custody.tone === 'only-copy'
                     ? 'bg-mail-only-copy-tint'
                     : custody.tone === 'local'
                       ? 'bg-mail-local-tint'
                       : 'bg-mail-server-tint'}`}
      >
        {custody.icon === 'cloud-off'
          ? <CloudOff size={14} className="flex-shrink-0 text-mail-only-copy" />
          : custody.icon === 'cloud'
          ? <Cloud size={14} className="flex-shrink-0 text-mail-server" />
          : <HardDrive size={14} className="flex-shrink-0 text-mail-local" />}
        <span className="font-medium text-mail-text">{custody.label}</span>
        <span className="text-mail-text-on-tint truncate">{custody.detail}</span>
      </div>

      {/* Header */}
      <EmailSenderInfo
        email={selectedEmail}
        variant="single"
        expanded={headerExpanded}
        onToggle={() => setHeaderExpanded(!headerExpanded)}
        showRaw={showRaw}
        onToggleRaw={async () => {
          if (showRaw) {
            setShowRaw(false);
            return;
          }
          if (!rawSource) {
            setLoadingRaw(true);
            try {
              const isTauri = !!window.__TAURI__;
              if (isTauri) {
                const { invoke } = window.__TAURI__.core;
                const b64 = await invoke('maildir_read_raw_source', {
                  accountId: activeAccountId,
                  mailbox: activeMailbox,
                  uid: selectedEmail.uid,
                });
                setRawSource(b64);
              }
            } catch (err) {
              console.error('[EmailViewer] Failed to load raw source:', err);
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

      {/* Action Bar — below sender info, above content */}
      <div className="px-3 pb-2 relative">
        <EmailActionBar
            email={selectedEmail}
            variant="single"
            onReply={(email) => onComposeReply?.('reply', email)}
            onReplyAll={(email) => onComposeReply?.('replyAll', email)}
            onForward={(email) => onComposeReply?.('forward', email)}
            onArchive={isArchived ? handleRemoveLocal : handleSave}
            onDelete={isLocalOnly ? handleRemoveLocal : handleDelete}
            onMove={() => setShowMoveDropdown(v => !v)}
            onToggleRead={handleToggleReadStatus}
            onOpenInWindow={() => {
              const invoke = window.__TAURI__?.core?.invoke;
              if (!invoke || !selectedEmail?.html) return;
              // Build a standalone document so the popup matches the in-app
              // view: charset declared, plus inline Dark Reader when dark.
              const bodyHtml = getEmailBodyContent(replaceCidUrls(selectedEmail.html, selectedEmail.attachments));
              const popupHtml = buildEmailIframeHtml({
                bodyHtml,
                themeTag: effectiveEmailTheme,
                extraHead: emailDarkMode ? getDarkReaderInlineScripts() : '',
              });
              invoke('open_email_window', { html: popupHtml, title: selectedEmail.subject || 'Email' });
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
                      uid: selectedEmail.uid,
                    });
                    setRawSource(b64);
                  }
                } catch (err) {
                  console.error('[EmailViewer] Failed to load raw source:', err);
                } finally {
                  setLoadingRaw(false);
                }
              }
              setShowRaw(true);
            }}
            onToggleEmailTheme={() => setEmailThemeOverride(emailDarkMode ? 'light' : 'dark')}
            emailThemeDark={emailDarkMode}
            isArchived={isArchived}
            isRead={isRead}
            isLocalOnly={isLocalOnly}
            isSentEmail={false}
            singleRecipient={(selectedEmail.to || []).length <= 1 && !(selectedEmail.cc?.length > 0)}
            disabled={{ delete: deleting, toggleRead: togglingRead, archive: saving }}
            moveDropdownOpen={showMoveDropdown}
            moveButtonRef={moveButtonRef}
          />
          {showMoveDropdown && selectedEmail && (
            <MoveToFolderDropdown
              uids={[selectedEmail.uid]}
              onClose={() => setShowMoveDropdown(false)}
              anchorRect={moveButtonRef.current?.getBoundingClientRect()}
            />
          )}
        </div>

      {/* Sender Insights */}
      <AnimatePresence>
        {showInsights && selectedEmail?.from?.address && (
          <SenderInsightsPanel senderEmail={selectedEmail.from.address} />
        )}
      </AnimatePresence>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
        <div className="p-4 flex-1 flex flex-col">
          {showRaw && rawSource ? (
            <pre className="text-xs font-mono text-mail-text bg-mail-surface rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-all">
              {atob(rawSource)}
            </pre>
          ) : selectedEmail.html ? (
            // Outer wrapper matches app theme so DR-inverted iframe content
            // blends seamlessly. In light mode, white wrapper + white iframe.
            <div
              className="rounded-lg overflow-hidden max-w-full h-full"
              style={{
                contain: 'inline-size',
                backgroundColor: emailDarkMode ? MAIL_DARK_BG : '#ffffff',
              }}
            >
              <iframe
                ref={iframeRef}
                srcDoc={iframeContent}
                className="w-full border-0 h-full"
                style={{ minHeight: '300px', display: 'block', maxWidth: '100%' }}
                sandbox="allow-same-origin allow-popups allow-scripts"
                title="Email content"
                onContextMenu={e => e.preventDefault()}
              />
            </div>
          ) : selectedEmail._bodyError ? (
            // The body never arrived. Saying so — with the reason and a retry —
            // is the whole point: the silent version of this state rendered the
            // subject line as the body and read as a successfully loaded email.
            <div
              data-testid="email-body-error"
              className="rounded-lg p-6 flex flex-col items-center text-center gap-3 border border-mail-border bg-mail-surface"
            >
              <AlertTriangle size={28} className="text-mail-warning" />
              <div>
                <p className="text-sm font-medium text-mail-text">Couldn’t load this message</p>
                <p className="text-xs text-mail-text-muted mt-1 max-w-md break-words">
                  {selectedEmail._bodyError}
                </p>
              </div>
              <button
                data-testid="email-body-retry"
                onClick={() => selectEmail(selectedEmail.uid, 'server')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-mail-text bg-mail-bg
                          border border-mail-border rounded-lg hover:bg-mail-surface-hover transition-colors"
              >
                <RefreshCw size={14} />
                Try again
              </button>
            </div>
          ) : (
            <div
              className="email-content whitespace-pre-wrap rounded-lg p-4"
              style={{
                backgroundColor: emailDarkMode ? MAIL_DARK_BG : '#ffffff',
                color: emailDarkMode ? MAIL_DARK_TEXT : '#333333',
              }}
            >
              {selectedEmail.text || 'No content'}
            </div>
          )}
        </div>

        {/* Attachments */}
        {(() => {
          const realAttachments = getRealAttachments(selectedEmail.attachments, selectedEmail.html);
          return realAttachments.length > 0 && (
            <div className="p-4 border-t border-mail-border">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-sm text-mail-text-muted">
                  <Paperclip size={14} />
                  <span>{realAttachments.length} Attachment{realAttachments.length !== 1 ? 's' : ''}</span>
                </div>
                {realAttachments.length > 1 && (
                  <DownloadAllButton attachments={realAttachments} emailUid={selectedEmail.uid} account={activeAccountId} folder={activeMailbox} />
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {realAttachments.map((attachment, index) => (
                  <AttachmentItem key={index} attachment={attachment} attachmentIndex={attachment._originalIndex} emailUid={selectedEmail.uid} account={activeAccountId} folder={activeMailbox} />
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Delete Confirmation */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/40 flex items-center justify-center z-50"
            onClick={() => setConfirmDelete(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-mail-surface border border-mail-border rounded-xl p-6 shadow-xl max-w-sm mx-4"
            >
              <h3 className="text-lg font-semibold text-mail-text mb-2">Delete email?</h3>
              <p className="text-sm text-mail-text-muted mb-4">
                {isArchived
                  ? 'This email is archived locally. Deleting from server will keep the archived copy.'
                  : 'This email will be permanently deleted from the server.'}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-4 py-2 text-sm text-mail-text bg-mail-bg border border-mail-border
                            rounded-lg hover:bg-mail-surface-hover transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDeleteEmail}
                  className="px-4 py-2 text-sm text-white bg-mail-danger-fill rounded-lg
                            hover:bg-mail-danger transition-colors"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Unarchive / Delete Local Confirmation */}
      <AnimatePresence>
        {confirmUnarchive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/40 flex items-center justify-center z-50"
            onClick={() => setConfirmUnarchive(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-mail-surface border border-mail-border rounded-xl p-6 shadow-xl max-w-sm mx-4"
            >
              <h3 className="text-lg font-semibold text-mail-text mb-2">
                {isLocalOnly ? 'Delete email?' : 'Unarchive email?'}
              </h3>
              <p className="text-sm text-mail-text-muted mb-4">
                {isLocalOnly
                  ? 'This email only exists in your local archive. Deleting it is permanent and cannot be undone.'
                  : 'The cached copy will be removed. The email will still be available on the server.'}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmUnarchive(false)}
                  className="px-4 py-2 text-sm text-mail-text bg-mail-bg border border-mail-border
                            rounded-lg hover:bg-mail-surface-hover transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmRemoveLocal}
                  className="px-4 py-2 text-sm text-white bg-mail-danger-fill rounded-lg
                            hover:bg-mail-danger transition-colors"
                >
                  {isLocalOnly ? 'Delete' : 'Unarchive'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <LinkSafetyModal
        alert={linkSafetyAlert}
        onCancel={() => setLinkSafetyAlert(null)}
        onOpenAnyway={() => {
          const url = linkSafetyAlert.actualUrl;
          setLinkSafetyAlert(null);
          import('@tauri-apps/plugin-shell').then(({ open }) => open(url)).catch(() => window.open(url, '_blank'));
        }}
      />
    </div>
  );
}

export const EmailViewer = memo(EmailViewerComponent);
