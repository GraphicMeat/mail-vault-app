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
import * as db from '../services/db';
import { describeMessageState, useBackedUp } from './email/MessageStateIcon';
import { custodyRowFor } from '../stores/slices/custody';
import { useCustodyLanding } from '../hooks/useCustodyLanding';
import { useSearchHighlight } from '../hooks/useSearchHighlight';
import { MoveToFolderDropdown } from './MoveToFolderDropdown';
import { SenderInsightsPanel } from './SenderInsightsPanel';
import { ThreadView } from './email/ThreadView';
import { EmailSenderInfo } from './email/EmailSenderInfo';
import { EmailActionBar } from './email/EmailActionBar';
import { useExportStore } from '../stores/exportStore';
import { AttachmentItem, DownloadAllButton } from './email/AttachmentBar';
import { CloseViewerButton } from './email/CloseViewerButton';
import { scanEmailLinks, checkLinkAlert } from '../utils/linkSafety';
import { LinkSafetyModal } from './LinkSafetyModal';
import { LinkAlertIcon } from './LinkAlertIcon';
import { SenderAlertIcon } from './SenderAlertIcon';
import { ReplyToAlertIcon } from './ReplyToAlertIcon';
import { TrackerAlertIcon } from './TrackerAlertIcon';
import { scanTrackers, getCachedTrackers, summarizeTrackers } from '../utils/trackerDetect';
import { recordTrackerSummary } from '../services/trackerVerdicts';
import { getCachedAlerts } from '../utils/linkSafety';
import { emailScopeKey, selectionKey, spansMailboxes, rowKey, resolveEmailLocation } from '../stores/slices/unifiedHelpers';
import { viewportShift } from '../hooks/useViewportShift';
import { useSettingsStore, isTrackerBlockingActive } from '../stores/settingsStore';
import { useThemeStore } from '../stores/themeStore';
import { buildEmailIframeHtml, getEmailBodyContent, getContextMenuColors, attachEmailIframeAutoSize, emailScriptNonce } from '../utils/emailIframeTemplate';
import { getDarkReaderInlineScripts } from '../utils/darkReaderInject';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../utils/iframeQuoteFolding';
import { getEmailColors } from '../utils/mailChrome';
import { openMailtoCompose } from '../utils/mailto';
import { replySelection } from '../utils/replySelection';
import { registerActiveReply } from '../utils/composeOpener';
import { AddressText } from './email/AddressText';
import { ReadDelayProgress } from './ReadDelayProgress';
import { LocalMailLabels } from './LocalMailLabels';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { describePurge } from '../utils/custodyCopy';
import { applyFlagToKeys } from '../services/workflows/messageMutations';

// Re-export AttachmentItem for any external consumers
export { AttachmentItem } from './email/AttachmentBar';
import { t, tErr, useT  } from '../i18n/index.js';

// ── Single Email Viewer ─────────────────────────────────────────────────────

function EmailViewerComponent({ onComposeReply, onClose }) {
  const t = useT();
  const navigationShortcuts = useSettingsStore(s => s.keyboardShortcuts);
  const shortcutsEnabled = useSettingsStore(s => s.keyboardShortcutsEnabled);
  const selectedEmail = useSelectionStore(s => s.selectedEmail);
  const selectedEmailSource = useSelectionStore(s => s.selectedEmailSource);
  const selectedThread = useSelectionStore(s => s.selectedThread);
  const loadingEmail = useSelectionStore(s => s.loadingEmail);
  const savedEmailIds = useMessageListStore(s => s.savedEmailIds);
  const archivedEmailIds = useMessageListStore(s => s.archivedEmailIds);
  const saveEmailsLocally = useSelectionStore(s => s.saveEmailsLocally);
  const removeLocalEmail = useSelectionStore(s => s.removeLocalEmail);
  const exportEmail = useSelectionStore(s => s.exportEmail);
  const selectEmail = useSelectionStore(s => s.selectEmail);
  const deleteEmailFromServer = useSelectionStore(s => s.deleteEmailFromServer);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const activeMailbox = useAccountStore(s => s.activeMailbox);
  // Only the archived wording depends on this now ("server copy not verified
  // yet" vs "also still on the server"). Gold is decided by custodySource,
  // which never asks a uid set — see stores/slices/custody.js.
  const serverKnown = useMailStore(s => s.serverUids.complete);
  const backedUpKeys = useMailStore(s => s.backedUpKeys);

  const linkSafetyEnabled = useSettingsStore(s => s.linkSafetyEnabled);
  // Effective state, not the raw flag: a stale `true` left behind by a lapsed
  // subscription must not render as protection. See isTrackerBlockingActive.
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  const linkSafetyClickConfirm = useSettingsStore(s => s.linkSafetyClickConfirm);
  const emailViewerTheme = useSettingsStore(s => s.emailViewerTheme);
  const signatureDisplay = useSettingsStore(s => s.signatureDisplay);
  const appTheme = useThemeStore(s => s.theme);
  const palette = useThemeStore(s => s.palette);
  // Default email theme: user preference ('light'|'dark') or follow app theme.
  const theme = emailViewerTheme === 'system' ? appTheme : emailViewerTheme;
  const [linkSafetyAlert, setLinkSafetyAlert] = useState(null);
  const [headerExpanded, setHeaderExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingRead, setTogglingRead] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingPurge, setPendingPurge] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const [rawSource, setRawSource] = useState(null);
  const [rawError, setRawError] = useState(null);
  const [loadingRaw, setLoadingRaw] = useState(false);
  const rawRequest = useRef(0);
  const [showMoveDropdown, setShowMoveDropdown] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  // Per-email theme override. null = follow app theme; 'light'|'dark' = forced.
  const [emailThemeOverride, setEmailThemeOverride] = useState(null);
  const moveButtonRef = useRef(null);
  const confirmationReturnRef = useRef(null);
  const iframeRef = useRef(null);
  const plainBodyRef = useRef(null);
  const selectedReplyHtml = () => {
    const frame = iframeRef.current;
    return frame?.contentDocument
      ? replySelection(frame.contentDocument.body, frame.contentWindow?.getSelection?.())
      : replySelection(plainBodyRef.current);
  };
  useEffect(() => {
    if (selectedThread || !selectedEmail) return undefined;
    const reply = (mode) => {
      if (mode !== 'reply' && mode !== 'replyAll') return false;
      onComposeReply?.(mode, { ...selectedEmail, _selectedQuoteHtml: selectedReplyHtml() });
      return true;
    };
    registerActiveReply(reply);
    return () => registerActiveReply(null);
  }, [selectedThread, selectedEmail, onComposeReply]);

  const effectiveEmailTheme = emailThemeOverride ?? theme;
  const emailDarkMode = effectiveEmailTheme === 'dark';
  const emailColors = getEmailColors(effectiveEmailTheme, palette);

  const isCached = selectedEmail && savedEmailIds.has(selectedEmail.uid);
  const isArchived = selectedEmail && (typeof selectedEmail.isArchived === 'boolean' ? selectedEmail.isArchived : archivedEmailIds.has(selectedEmail.uid));
  const isLocalOnly = selectedEmailSource === 'local-only';
  const isRead = selectedEmail?.flags?.includes('\\Seen');
  // One custody statement per message — and it is the ROW's, not a second
  // opinion computed here.
  //
  // Two previous attempts each picked a different field on a different object
  // and each shipped the same contradiction: a green "Saved in your vault —
  // also still on the server" band over a gold "your only copy" row.
  // `selectedEmailSource` failed because selectEmail.js also writes
  // 'header-only' into it (a loading state in a provenance field);
  // `selectedEmail.source` failed because this component never holds the row —
  // its copy comes from the in-memory cache, the vault `.eml` or a server
  // fetch, and every vault read stamps `source: 'local'` on the way out, so
  // 'local-only' was unreachable here by construction.
  //
  // The third field would have failed too. Read the row the list derived.
  const insightsCustody = selectedEmail?._insightsReadOnly ? {
    isArchived: !!selectedEmail.isArchived,
    _origin: selectedEmail._origin,
    serverDeleted: selectedEmail.serverDeleted,
    serverAbsent: selectedEmail.serverAbsent,
  } : null;
  const custodyRow = useMailStore(s => insightsCustody ? null : custodyRowFor(selectedEmail, s));
  const custodySubject = insightsCustody || custodyRow || {
    isArchived: isArchived || !!selectedEmail?.isArchived,
    _origin: selectedEmail?._origin,
    serverDeleted: selectedEmail?.serverDeleted,
    serverAbsent: selectedEmail?.serverAbsent,
  };
  // The band used to omit `backedUp` entirely, so it defaulted false and could
  // never mention the drive — while ConnectedStateIcon in the sender line right
  // below it read the store and did. Same message, two statements, 40px apart.
  // Read the row, through the same key builder the rows use.
  const backedUp = useBackedUp(insightsCustody ? selectedEmail : custodyRow || selectedEmail);
  const custody = describeMessageState(custodySubject, { serverKnown: insightsCustody ? false : serverKnown, backedUp });
  // Reset view states when switching emails
  useEffect(() => {
    ++rawRequest.current;
    setShowRaw(false);
    setRawSource(null);
    setRawError(null);
    setLoadingRaw(false);
    setShowInsights(false);
    setEmailThemeOverride(null);
    return () => { ++rawRequest.current; };
  }, [selectedEmail?.uid, selectedEmail?._accountId, selectedEmail?._mailbox, selectedEmail?.messageId]);

  // The header's "View Source" and the action bar's open the same panel, and
  // both used to read the vault file for this uid unverified — see
  // db.getVerifiedRawSource for why that hands over another message.
  const toggleRawSource = async () => {
    if (showRaw) { setShowRaw(false); return; }
    const request = ++rawRequest.current;
    if (!rawSource && !rawError) {
      setLoadingRaw(true);
      try {
        const { b64, error } = await db.getVerifiedRawSource(
          selectedEmail._accountId || activeAccountId,
          selectedEmail._mailbox || activeMailbox,
          selectedEmail.uid, selectedEmail);
        if (request !== rawRequest.current) return;
        setRawSource(b64);
        setRawError(error);
      } catch (err) {
        if (request !== rawRequest.current) return;
        console.error('[EmailViewer] Failed to load raw source:', err);
        setRawError('Could not read this message from the vault.');
      } finally {
        if (request === rawRequest.current) setLoadingRaw(false);
      }
    }
    if (request === rawRequest.current) setShowRaw(true);
  };

  const handleSave = async (target = selectedEmail) => {
    if (!target) return;
    setSaving(true);
    try {
      await saveEmailsLocally([target]);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveLocal = (target = selectedEmail) => {
    if (!target) return;
    const location = resolveEmailLocation(target, useMailStore.getState());
    if (!location) return;
    setPendingDelete({
      executor: () => removeLocalEmail(target.uid, location),
      copy: {
        title: target.source === 'local-only' || target._origin === 'local-only' ? t('viewer.deleteEmail') : t('viewer.unarchiveEmail'),
        description: target.source === 'local-only' || target._origin === 'local-only' ? t('viewer.emailOnlyExistsLocalArchive') : t('viewer.cachedCopyRemovedEmailStill'),
        confirmLabel: target.source === 'local-only' || target._origin === 'local-only' ? t('common.delete') : t('rowMenu.unarchive'),
      },
    });
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
        title: t('viewer.exportEmail'),
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

  const handleToggleReadStatus = async (email = selectedEmail, desired) => {
    if (!email || togglingRead) return;
    setTogglingRead(true);
    try {
      const read = typeof desired === 'boolean' ? desired : !email.flags?.includes('\\Seen');
      await applyFlagToKeys([selectionKey(email, useMailStore.getState())], '\\Seen', read);
    } finally {
      setTogglingRead(false);
    }
  };

  // The open message's own selection key: a merged Sent copy, or a message
  // opened from a branch listing, is not the view's folder's — and a bare uid
  // there names another folder's message just as readily.
  const handleToggleFlag = (target = selectedEmail, desired) => {
    if (!target) return;
    const flagged = typeof desired === 'boolean' ? desired : !target.flags?.includes('\\Flagged');
    return applyFlagToKeys([selectionKey(target, useMailStore.getState())], '\\Flagged', flagged);
  };

  const handleDelete = (target = selectedEmail) => {
    if (!target || deleting) return;
    const location = resolveEmailLocation(target, useMailStore.getState());
    if (!location) return;
    setPendingDelete({
      confirmOptional: true,
      executor: () => confirmDeleteEmail(target, location),
      copy: {
        title: t('viewer.deleteEmail'),
        description: target.isArchived || archivedEmailIds.has(target.uid) ? t('viewer.emailArchivedLocallyDeletingServer') : t('viewer.emailPermanentlyDeletedServer'),
        confirmLabel: t('common.delete'),
      },
    });
  };

  const handleDeleteEverywhere = target => {
    if (!target) return;
    const state = useMailStore.getState();
    const location = resolveEmailLocation(target, state);
    if (!location) return;
    const localOnly = target.source === 'local-only' || target._origin === 'local-only';
    const archived = !!target.isArchived || archivedEmailIds.has(target.uid) || localOnly;
    const backup = !!backedUpKeys?.has(`${location.accountId}:${location.mailbox}:${target.uid}`);
    const copy = describePurge({ server: !localOnly, vault: archived, backup }, 1);
    if (!copy) return;
    setPendingPurge({
      copy: { title: copy.title, description: copy.description, confirmLabel: copy.label },
      executor: async () => {
        const current = useMailStore.getState();
        const previous = [...current.selectedEmailIds];
        const key = selectionKey(target, current);
        current.setSelection([key]);
        try { await current.purgeSelectedEverywhere(); }
        finally {
          const selected = useMailStore.getState().selectedEmailIds;
          if (selected.size === 0) useMailStore.getState().setSelection(previous.filter(item => item !== key));
        }
      },
    });
  };

  const confirmDeleteEmail = async (target = selectedEmail, location = resolveEmailLocation(target, useMailStore.getState())) => {
    setDeleting(true);
    try {
      // A bare uid names a message only inside one folder of one account: in
      // a list that spans mailboxes it matches whichever row carries that
      // number first, which is another account's mail. Same rule as
      // ThreadView.requestDelete and the row menu.
      await deleteEmailFromServer(target.uid, { accountId: location?.accountId, mailboxOverride: location?.mailbox });
    } catch (err) {
      // Only the paths with nothing journalled still throw: a Graph delete and
      // a local-only row, which the workflow restores (deleteEmailFromServer's
      // restoreRow). An IMAP delete the server refuses no longer reaches here
      // at all — it stays queued and the row stays gone. Unreported, a restore
      // reads as "I deleted it and it came back on its own".
      console.error('[EmailViewer] delete failed:', err);
      useMailStore.setState({ error: t('list.deleteFailed', { err: err?.message || err }) });
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
  const selectedLocation = selectedEmail ? resolveEmailLocation(selectedEmail, useMailStore.getState()) : null;
  const isSentEmail = !!selectedEmail && (selectedLocation?.mailbox?.toLowerCase() === 'sent' || selectedEmail.flags?.includes('\\Sent'));
  // The same handoff the row plays, at reading-pane scale: archive the message
  // you are reading and the band above it hands over while you watch, instead
  // of having quietly always said what it now says.
  const custodyLanded = useCustodyLanding(scopeKey, custody.tone);

  const { iframeContent, scanAlertLevel, trackerSummary } = useMemo(() => {
    if (!selectedEmail?.html) return { iframeContent: '', scanAlertLevel: null, trackerSummary: null };
    const bodyHtml = getEmailBodyContent(replaceCidUrls(selectedEmail.html, selectedEmail.attachments));
    // Scan body HTML (stable per uid → cacheable); theme/DR is layered on
    // top via buildEmailIframeHtml so toggling theme doesn't invalidate the
    // scan cache or strip Dark Reader scripts from a cached modifiedHtml.
    // Tracker detection runs for everyone — the glyph tells a free user their
    // mail phoned home. Only the SWAP to the cleaned body is premium.
    const trackerScan = scanTrackers(bodyHtml, scopeKey);
    let renderedBody = trackerBlocking ? trackerScan.cleanedBodyHtml : bodyHtml;
    let indicatorStyle = '';
    let alertLevel = null;
    if (linkSafetyEnabled) {
      const scan = scanEmailLinks(renderedBody, scopeKey);
      renderedBody = scan.modifiedBodyHtml;
      indicatorStyle = scan.indicatorStyle;
      alertLevel = scan.maxAlertLevel;
    }
    // Light baseline always. When dark, Dark Reader is INLINED into the
    // iframe HTML (not injected post-load) so it runs during page load —
    // eliminates the load-event race and prevents a flash of light content
    // on theme toggle. srcDoc diff on theme change still forces reload.
    // One nonce for this render: the frame's CSP grants only scripts that carry
    // it (our DR + fold scripts), so the mail's own script never runs.
    const nonce = emailScriptNonce();
    const extraHead = `${emailDarkMode ? getDarkReaderInlineScripts({ palette, nonce }) : ''}${indicatorStyle ? `<style>${indicatorStyle}</style>` : ''}`;
    const html = buildEmailIframeHtml({
      bodyHtml: renderedBody,
      themeTag: effectiveEmailTheme,
      extraHead,
      extraBody: `${getQuoteFoldingScript(nonce)}${getSignatureFoldingScript(signatureDisplay, nonce)}`,
      nonce,
    });
    return { iframeContent: html, scanAlertLevel: alertLevel, trackerSummary: summarizeTrackers(trackerScan.trackers) };
  }, [selectedEmail?.html, scopeKey, linkSafetyEnabled, trackerBlocking, effectiveEmailTheme, palette, signatureDisplay]);

  // Terms from the open search, painted into the body the results list opened.
  useSearchHighlight(iframeRef, iframeContent);

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

  // Same round trip for the tracker verdict: onto the open message, onto every
  // row that IS this message (scoped key, not the uid — in unified inbox every
  // account's uid 41 would light up), and into settings so the glyph survives
  // a restart without re-fetching the body.
  useEffect(() => {
    if (!trackerSummary || !selectedEmail) return;
    const current = selectedEmail._trackerInfo;
    if (current && current.count === trackerSummary.count) return;
    recordTrackerSummary(scopeKey, trackerSummary);
  }, [trackerSummary, scopeKey]);

  // Auto-resize iframe and apply dark mode overrides
  useEffect(() => {
    if (!iframeRef.current || !selectedEmail?.html) return;

    const iframe = iframeRef.current;
    const detachAutoSize = attachEmailIframeAutoSize(iframe, { minHeight: 300 });

    // Named handlers so we can remove them in cleanup
    const handleClick = (e) => {
      const link = e.target.closest('a');
      if (!link || !link.href) return;
      // An address in the body composes here instead of waking the OS mail
      // client, which is not the vault this message lives in.
      if (link.href.startsWith('mailto:')) {
        e.preventDefault();
        e.stopPropagation();
        openMailtoCompose(link.href, selectedEmail?._accountId);
        return;
      }
      if (link.href.startsWith('cid:') || link.href.startsWith('tel:') || link.href.startsWith('#')) return;
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
        { label: t('viewer.copy'), action: () => doc.execCommand('copy') },
        { label: t('settings.migration.selectAll'), action: () => doc.execCommand('selectAll') },
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
      // The frame is as tall as the message and the pane scrolls it, so the
      // frame's own viewport is not what the reader sees: clamp to the part
      // of the frame that is inside the window.
      const frame = iframe.getBoundingClientRect();
      const visTop = Math.max(0, -frame.top);
      const visLeft = Math.max(0, -frame.left);
      const { x, y } = viewportShift(menu.getBoundingClientRect(),
        { width: menu.offsetWidth, height: menu.offsetHeight },
        {
          top: visTop, left: visLeft,
          width: Math.min(frame.width, window.innerWidth - frame.left) - visLeft,
          height: Math.min(frame.height, window.innerHeight - frame.top) - visTop,
        });
      menu.style.left = (e.clientX + x) + 'px';
      menu.style.top = (e.clientY + y) + 'px';
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
    };

    iframe.addEventListener('load', onLoad);

    return () => {
      iframe.removeEventListener('load', onLoad);
      detachAutoSize();
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
        <div className="reader-welcome max-w-sm px-8 text-center">
          <FileText size={36} strokeWidth={1.25} className="mx-auto mb-5 text-mail-text-muted" />
          <h2 className="text-lg font-medium text-mail-text">{t('viewer.selectEmailRead')}</h2>
          <p className="mt-2 text-sm leading-relaxed text-mail-text-muted">{t('workspace.readerHint')}</p>
          {shortcutsEnabled && navigationShortcuts?.prevEmail && navigationShortcuts?.nextEmail && (
            <div className="mt-6 inline-flex items-center gap-2 text-xs text-mail-text-muted">
              <kbd className="reader-key">{navigationShortcuts.prevEmail}</kbd>
              <kbd className="reader-key">{navigationShortcuts.nextEmail}</kbd>
              <span>{t('workspace.browseMessages')}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (loadingEmail) {
    return (
      <div
        data-testid="email-viewer-loading"
        role="status"
        className="flex-1 flex flex-col items-center justify-center gap-3 bg-mail-bg h-full min-h-0"
      >
        <svg
          className="email-viewer-spinner w-8 h-8"
          viewBox="0 0 32 32"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="16" cy="16" r="13" stroke="var(--mail-border)" strokeWidth="2" />
          <circle
            cx="16"
            cy="16"
            r="13"
            stroke="var(--mail-accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="54 82"
          />
        </svg>
        <p className="text-sm text-mail-text-muted">{t('viewer.loadingMessage')}</p>
      </div>
    );
  }

  return (
    <div className="email-reader flex-1 flex flex-col bg-mail-bg overflow-hidden min-h-0 min-w-0 h-full relative">
      <ReadDelayProgress />
      {/* Drag region */}
      <div data-tauri-drag-region className="h-2 border-b border-mail-border" />

      {/* Subject */}
      <div key={scopeKey} className="viewer-swap px-5 py-4 border-b border-mail-border flex items-start gap-3">
        <h1 className="text-xl leading-snug font-semibold text-mail-text flex-1 min-w-0 flex items-center gap-2">
          <SenderAlertIcon level={selectedEmail._senderAlert} email={selectedEmail} size={18} />
          <ReplyToAlertIcon mismatch={selectedEmail._replyToMismatch} size={18} />
          <LinkAlertIcon level={selectedEmail._linkAlert} size={18} alerts={getCachedAlerts(scopeKey)} />
          <TrackerAlertIcon
            info={selectedEmail._trackerInfo || trackerSummary}
            trackers={getCachedTrackers(scopeKey)}
            blocked={trackerBlocking}
            size={18}
          />
          <span className="min-w-0 break-words">{selectedEmail.subject}</span>
        </h1>
        <CloseViewerButton onClose={onClose} />
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
        {custody.tone !== 'local' && <span className="text-mail-text-on-tint truncate">{custody.detail}</span>}
      </div>

      {/* Header */}
      <EmailSenderInfo
        email={selectedEmail}
        variant="single"
        expanded={headerExpanded}
        onToggle={() => setHeaderExpanded(!headerExpanded)}
        onReply={() => onComposeReply?.('reply', { ...selectedEmail, _selectedQuoteHtml: selectedReplyHtml() })}
        showRaw={showRaw}
        onToggleRaw={toggleRawSource}
        loadingRaw={loadingRaw}
        showInsights={showInsights}
        onToggleInsights={() => setShowInsights(!showInsights)}
        archivedEmailIds={archivedEmailIds}
      />
      <div className="px-3 pt-1"><LocalMailLabels email={selectedEmail} /></div>

      {/* Action Bar — below sender info, above content */}
      <div className="px-3 pb-2 relative">
        <EmailActionBar
            email={selectedEmail}
            variant="single"
            onReply={(email) => onComposeReply?.('reply', { ...email, _selectedQuoteHtml: selectedReplyHtml() })}
            onReplyAll={(email) => onComposeReply?.('replyAll', { ...email, _selectedQuoteHtml: selectedReplyHtml() })}
            onForward={(email) => onComposeReply?.('forward', email)}
            onArchive={(email, entry) => entry?.action === 'unarchive' || (typeof email.isArchived === 'boolean' ? email.isArchived : archivedEmailIds.has(email.uid))
              ? handleRemoveLocal(email) : handleSave(email)}
            onDelete={(email, entry) => email.source === 'local-only' || email._origin === 'local-only'
              ? handleRemoveLocal(email) : handleDelete(email)}
            onMove={() => setShowMoveDropdown(v => !v)}
            onToggleRead={handleToggleReadStatus}
            onToggleFlag={handleToggleFlag}
            onDeleteEverywhere={handleDeleteEverywhere}
            onOpenInWindow={() => {
              const invoke = window.__TAURI__?.core?.invoke;
              if (!invoke || !selectedEmail?.html) return;
              // Build a standalone document so the popup matches the in-app
              // view: charset declared, plus inline Dark Reader when dark.
              const bodyHtml = getEmailBodyContent(replaceCidUrls(selectedEmail.html, selectedEmail.attachments));
              // The popup is a second renderer of the same mail — a beacon
              // stripped in the pane but left in the window still fires.
              const popupBody = trackerBlocking ? scanTrackers(bodyHtml, scopeKey).cleanedBodyHtml : bodyHtml;
              // The popup loads from file:// and inherits no CSP, so its meta
              // (script-src 'nonce-…') is the ONLY policy — Dark Reader has to
              // carry the same nonce to run there.
              const popupNonce = emailScriptNonce();
              const popupHtml = buildEmailIframeHtml({
                bodyHtml: popupBody,
                themeTag: effectiveEmailTheme,
                extraHead: emailDarkMode ? getDarkReaderInlineScripts({ palette, nonce: popupNonce }) : '',
                nonce: popupNonce,
              });
              invoke('open_email_window', { html: popupHtml, title: selectedEmail.subject || 'Email' });
            }}
            onViewSource={toggleRawSource}
            onExport={(email) => useExportStore.getState().openExport({ messages: [email] })}
            onToggleEmailTheme={() => setEmailThemeOverride(emailDarkMode ? 'light' : 'dark')}
            emailThemeDark={emailDarkMode}
            isArchived={isArchived}
            isRead={isRead}
            isLocalOnly={isLocalOnly}
            isSentEmail={isSentEmail}
            singleRecipient={(selectedEmail.to || []).length <= 1 && !(selectedEmail.cc?.length > 0)}
            disabled={{ delete: deleting, toggleRead: togglingRead, archive: saving }}
            moveDropdownOpen={showMoveDropdown}
            moveButtonRef={moveButtonRef}
            onActionStart={(_event, trigger, entry) => {
              if (['delete', 'deleteServer', 'deleteEverywhere', 'unarchive', 'archive'].includes(entry?.action)) {
                confirmationReturnRef.current = trigger;
              }
            }}
          />
          {showMoveDropdown && selectedEmail && (
            <MoveToFolderDropdown
              // The open message's own key: a merged Sent copy, or a message
              // opened from a branch listing, is not the view's folder's.
              uids={[selectionKey(selectedEmail, useMailStore.getState())]}
              accountId={selectedLocation?.accountId}
              currentMailbox={selectedLocation?.mailbox}
              onClose={() => setShowMoveDropdown(false)}
              anchorRect={moveButtonRef.current?.getBoundingClientRect()}
              returnFocusRef={moveButtonRef}
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
        <div className="p-3 flex-1 flex flex-col">
          {showRaw && (rawSource || rawError) ? (
            <pre className="text-xs font-mono text-mail-text bg-mail-surface rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-all" data-testid={rawError ? 'email-raw-error' : undefined}>
              {rawError || atob(rawSource)}
            </pre>
          ) : selectedEmail.html ? (
            // Outer wrapper matches app theme so DR-inverted iframe content
            // blends seamlessly. In light mode, white wrapper + white iframe.
            <div
              className="rounded-lg overflow-hidden max-w-full h-full"
              style={{
                contain: 'inline-size',
                backgroundColor: emailColors.background,
              }}
            >
              <iframe
                ref={iframeRef}
                srcDoc={iframeContent}
                className="w-full border-0 h-full"
                style={{ minHeight: '300px', display: 'block', maxWidth: '100%' }}
                sandbox="allow-same-origin allow-popups allow-scripts"
                title={t('viewer.emailContent')}
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
              {selectedEmail._bodyGone
                ? <CloudOff size={28} className="text-mail-text-muted" />
                : <AlertTriangle size={28} className="text-mail-warning" />}
              <div>
                <p className="text-sm font-medium text-mail-text">
                  {t(selectedEmail._bodyGone ? 'viewer.messageRemovedElsewhere' : 'viewer.couldnTLoadMessage')}
                </p>
                <p className="text-xs text-mail-text-muted mt-1 max-w-md break-words">
                  {selectedEmail._bodyGone && `${t('viewer.messageRemovedElsewhereHint')} `}
                  {tErr(selectedEmail._bodyError)}
                </p>
              </div>
              {/* No retry on a proven removal: the server already answered, and
                  the only thing a second ask can do is fail the same way. */}
              {!selectedEmail._bodyGone && (
                <button
                  data-testid="email-body-retry"
                  // A bare uid names no message in a spanning view.
                  onClick={() => selectEmail(rowKey(selectedEmail, spansMailboxes(useMailStore.getState())), 'server')}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-mail-text bg-mail-bg
                            border border-mail-border rounded-lg hover:bg-mail-surface-hover transition-colors"
                >
                  <RefreshCw size={14} />
                  {t('viewer.tryAgain')}
                </button>
              )}
            </div>
          ) : (
            <div
              ref={plainBodyRef}
              className="email-content email-plain-body whitespace-pre-wrap rounded-lg"
              style={{
                backgroundColor: emailColors.background,
                color: emailColors.text,
              }}
            >
              <AddressText text={selectedEmail.text || 'No content'} accountId={selectedEmail?._accountId} />
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
                  <span>{t('common.attachmentCountCap', { count: realAttachments.length })}</span>
                </div>
                {realAttachments.length > 1 && (
                  <DownloadAllButton attachments={realAttachments} emailUid={selectedEmail.uid} accountId={selectedEmail._accountId || activeAccountId} mailbox={selectedEmail._mailbox} subject={selectedEmail.subject} />
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {realAttachments.map((attachment, index) => (
                  <AttachmentItem key={index} listIndex={index} attachment={attachment} attachmentIndex={attachment._originalIndex} emailUid={selectedEmail.uid} accountId={selectedEmail._accountId || activeAccountId} mailbox={selectedEmail._mailbox} />
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      <DeleteConfirmModal pending={pendingDelete} onClose={() => {
        setPendingDelete(null);
        requestAnimationFrame(() => confirmationReturnRef.current?.focus?.());
      }} />
      <DeleteConfirmModal pending={pendingPurge} onClose={() => {
        setPendingPurge(null);
        requestAnimationFrame(() => confirmationReturnRef.current?.focus?.());
      }} />

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
