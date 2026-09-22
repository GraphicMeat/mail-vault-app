import React, { useState, useEffect, useRef, useCallback, useId } from 'react';
import { useDialogA11y, hasOpenPopover } from '../hooks/useDialogA11y';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useAccountStore } from '../stores/accountStore';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { formatDateTime } from '../utils/dateFormat';
import { motion } from 'framer-motion';
import { X, Send, Paperclip, Loader, Minimize2, Maximize2, FileText, Trash2, ChevronDown, BookTemplate, ChevronRight, Clock } from 'lucide-react';
import { RichTextEditor, insertImages, textToHtml, htmlToText } from './RichTextEditor';
import { ContactsPickerButton, ContactsAutocomplete } from './ContactsPicker';
import { buildEmailIframeHtml, attachEmailIframeAutoSize } from '../utils/emailIframeTemplate';
import { buildReplyHeaders, computeReplyRecipients } from '../utils/emailParser';
import { replyTemplateHtml } from '../utils/replyTemplate';
import { suggestSendAsAddresses, composeIdentities, resolveInitialComposeIdentity } from '../utils/sendAsSuggestions';
import { resolveDraftsMailbox, saveLocalDraft, deleteLocalDraft, newDraftUid } from '../services/localDrafts';
import { t, useT, tErr, getLocale } from '../i18n/index.js';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import { toClientPoint, dropZoneAt, toAttachment } from '../utils/nativeDrop';
import { SchedulePicker } from './scheduled/SchedulePicker';
import { ScheduledSendNotice } from './scheduled/ScheduledFolderModal';
import { isPastLocalTime, formatWallClock } from '../utils/scheduledTime';
import { firstRecipient } from '../utils/mailto';
import { useScheduledStore } from '../stores/scheduledStore';
import { AiComposeActions } from './ai/AiComposeActions';
import { createComposeSend, scheduleCompose } from '../services/composeSend';
import { signatureCaretPos } from '../utils/signatureCaret';

// Recipient input row with inline autocomplete + contacts-popover button.
function RecipientField({ name, label, placeholder, value, onChange, setValue, testid, boostAccountId }) {
  const inputRef = useRef(null);
  return (
    <div className="flex items-center gap-2 relative">
      <label className="w-16 flex-shrink-0 text-sm text-mail-text-muted">{label}</label>
      <div className="flex-1 flex items-center gap-1">
        <input aria-label={label}
          ref={inputRef}
          type="text"
          name={name}
          data-testid={testid}
          data-autofocus={name === 'to' ? true : undefined}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-mail-text placeholder-mail-text-muted
                    outline-none text-sm py-1"
        />
        <ContactsPickerButton value={value} onChange={setValue} fieldName={name.toUpperCase()} boostAccountId={boostAccountId} />
      </div>
      <ContactsAutocomplete value={value} onChange={setValue} inputRef={inputRef} boostAccountId={boostAccountId} />
    </div>
  );
}

function AttachmentPreview({ attachment, onRemove }) {
  const t = useT();
  const formatSize = (bytes) => {
    if (bytes < 1024) return t('settings.backup.account.b', { bytes });
    if (bytes < 1024 * 1024) return t('settings.backup.account.kb', { bytes: (bytes / 1024).toFixed(1) });
    return t('settings.backup.account.mb', { bytes: (bytes / (1024 * 1024)).toFixed(1) });
  };
  
  return (
    <div
      data-testid="compose-attachment"
      data-filename={attachment.filename}
      className="flex items-center gap-2 px-3 py-2 bg-mail-surface-hover rounded-lg"
    >
      <FileText size={16} className="text-mail-accent-text" />
      <span className="text-sm text-mail-text truncate flex-1">{attachment.filename}</span>
      <span className="text-xs text-mail-text-muted">{formatSize(attachment.size)}</span>
      <Button variant="ghost" icon size="xs" className="hover:bg-mail-border"
        onClick={onRemove}
        title={t('compose.removeAttachment')}
      >
        <X size={14} className="text-mail-text-muted" />
      </Button>
    </div>
  );
}

// Fields of a received message go into the quote's HTML as text.
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function originalHtml(message, label) {
  const fromAddress = message.from?.address || '';
  const fromName = message.from?.name || '';
  const originalDate = message.date ? formatDateTime(message.date) : '';
  const originalTo = message.to?.map(recipient => recipient.address).join(', ') || '';
  const header = `<p><strong>${label}</strong><br>From: ${escapeHtml(fromName)} &lt;${escapeHtml(fromAddress)}&gt;<br>Date: ${escapeHtml(originalDate)}<br>Subject: ${escapeHtml(message.subject || '')}<br>To: ${escapeHtml(originalTo)}</p>`;
  return header + (message.html || textToHtml(message.text || ''));
}

// The message a reply answers: someone else's HTML, shown in the app's own
// window, where withGlobalTauri puts the IPC bridge. The sandbox has no
// allow-scripts, so nothing in the frame runs: no <script>, no onerror, no
// javascript: link. allow-same-origin only lets the auto-size read its height.
// The reading pane's frames allow scripts (Dark Reader, quote folding); this
// one must not copy them.
const QuotedOriginal = React.memo(function QuotedOriginal({ html }) {
  const t = useT();
  const frameRef = useRef(null);
  useEffect(() => attachEmailIframeAutoSize(frameRef.current), []);
  return (
    <iframe
      ref={frameRef}
      sandbox="allow-same-origin"
      srcDoc={buildEmailIframeHtml({ bodyHtml: html, extraHead: '<style>body { padding: 12px 16px; }</style>' })}
      title={t('compose.originalMessage')}
      className="block w-full border-0 rounded-md"
    />
  );
});

// The HTML5 drag handlers below are the browser-preview path. In the app,
// wry answers AppKit before WebKit sees a file drag, and the drop arrives as
// `tauri://drag-drop` with pasteboard paths — see src/utils/nativeDrop.js and
// the effect next to removeAttachment.
// Only a FILE drag arms the drop zones — dragging selected text inside the
// editor must not paint the modal as a drop target.
const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

export function ComposeModal({ mode = 'new', replyTo = null, initialData = null, templateBody = null, onClose, onMinimize, onSaveState, onDetach, detached = false, onContextVisibleChange, onDiscard, snapshotRef, onAddTemplate, onQueueSend, onSchedule, onUpgrade }) {
  const t = useT();
  const titleId = useId();
  // Compose owns Escape (minimize or discard); the shared hook owns focus.
  const dialogRef = useDialogA11y(true);
  const rawAccounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  // Which mailbox the user is reading, which is who a fresh compose is from.
  // In the unified inbox every account's mail is on screen at once, so the
  // account of the last message opened is the only honest answer there.
  const readingAccountId = useAccountStore(s =>
    s.activeMailbox === 'UNIFIED' ? s.lastSelectedAccountId : s.activeAccountId);
  const getSignature = useSettingsStore(s => s.getSignature);
  const getDisplayName = useSettingsStore(s => s.getDisplayName);
  // Subscribed (not read through the getter) so the From row re-renders when
  // the override changes while compose is open.
  const sendAsAddresses = useSettingsStore(s => s.sendAsAddresses);
  const globalSendDelay = useSettingsStore(s => s.sendDelay) ?? 0;
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const emailTemplates = useSettingsStore(s => s.emailTemplates);
  const spellcheckEnabled = useSettingsStore(s => s.spellcheckEnabled ?? true);
  const addEmailTemplate = useSettingsStore(s => s.addEmailTemplate);
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const composeContextVisible = useSettingsStore(s => s.composeContextVisible ?? true);
  const setComposeContextVisible = useSettingsStore(s => s.setComposeContextVisible);
  const accounts = getOrderedAccounts(rawAccounts);
  // Replies and forwards leave from the mailbox the message is in (falling back
  // to the one being read); a restored draft keeps its saved identity; a fresh
  // compose defaults to the account being read, not to whoever sent last.
  const initialIdentity = resolveInitialComposeIdentity({
    replyTo,
    initialData,
    lastIdentity: useSettingsStore.getState().lastComposeIdentity,
    accounts,
    activeAccountId,
    selectedAccountId: readingAccountId,
  });
  const [selectedAccountId, setSelectedAccountId] = useState(initialIdentity.accountId);
  const selectedAccount = accounts.find(a => a.id === selectedAccountId) || accounts[0];
  const composeSendAs = sendAsAddresses?.[selectedAccountId] || '';
  // Addresses each account has provably sent as, mined from its Sent cache.
  const [sentAsByAccount, setSentAsByAccount] = useState({});
  // '' = whatever the selected account sends as by default.
  const [pickedFrom, setPickedFrom] = useState(initialIdentity.address);
  // Not memo'd: `accounts` is a fresh array every render anyway.
  let identities = composeIdentities(accounts, sendAsAddresses, sentAsByAccount);
  // A restored/remembered From may not be minable yet (async) or any more —
  // the row must still show the address the message will actually leave from.
  if (pickedFrom && !identities.some(i => i.accountId === selectedAccountId && i.address.toLowerCase() === pickedFrom.toLowerCase())) {
    identities = [...identities, { key: `${selectedAccountId} ${pickedFrom}`, accountId: selectedAccountId, address: pickedFrom }];
  }
  const composeFrom = pickedFrom || composeSendAs || selectedAccount?.email || '';
  const actionReplyTo = replyTo || initialData?._replyTo || null;

  const [sending, setSending] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const [error, setError] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [quotedHtml, setQuotedHtml] = useState('');
  const [contextHtml, setContextHtml] = useState('');
  const [showContext, setShowContext] = useState(() => initialData?._showContext ?? ((mode === 'reply' || mode === 'replyAll') && composeContextVisible));
  const [contextWidth, setContextWidth] = useState(400);
  const [originalDetached, setOriginalDetached] = useState(false);
  const originalWindowRef = useRef(null);
  const originalCloseStopRef = useRef(null);
  const contextDragRef = useRef(null);
  const [contentWidth, setContentWidth] = useState(Infinity);
  const [composeSize, setComposeSize] = useState(() => initialData?._composeSize || null);
  // WebKit reports a null relatedTarget on dragleave, so the old
  // `contains(relatedTarget)` check never worked — count enter/leave instead.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [composeDelay, setComposeDelay] = useState(() => initialData?._composeDelay ?? null); // null = use global
  const [showSchedulePicker, setShowSchedulePicker] = useState(false);
  const [scheduleMaxWidth, setScheduleMaxWidth] = useState();
  // `tzPicked`: the zone was chosen by hand, so no suggestion replaces it.
  // Kept in the draft so a minimize or detach keeps it too.
  const [scheduleDraft, setScheduleDraft] = useState(() => initialData?._scheduleDraft || ({
    localTime: '',
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  const [tzSuggestion, setTzSuggestion] = useState(null);
  // Only the schedule panel is gated: Send and its delay menu stay free.
  // Subscribed, so a subscription that lapses with the panel open swaps the
  // picker for the locked panel instead of leaving a Schedule that fails.
  const schedulePremium = showSchedulePicker && hasPremiumAccess(billingProfile);
  const fileInputRef = useRef(null);
  const editorRef = useRef(null);
  const templatesRef = useRef(null);
  const scheduleRef = useRef(null);
  const contentRef = useRef(null);
  const shellRef = useRef(null);
  const onSaveStateRef = useRef(onSaveState);
  useEffect(() => { onSaveStateRef.current = onSaveState; }, [onSaveState]);
  useEffect(() => () => {
    originalCloseStopRef.current?.();
    void originalWindowRef.current?.destroy();
  }, []);

  const openOriginalWindow = async () => {
    if (originalWindowRef.current) {
      await originalWindowRef.current.setFocus();
      return;
    }
    const token = crypto.randomUUID();
    let unlisten;
    try {
      unlisten = await listen('original-message-ready', async event => {
        if (event.payload?.token !== token) return;
        await emitTo(event.payload.label, 'original-message-payload', { token, html: contextHtml });
        unlisten?.();
      });
      const label = await invoke('open_auxiliary_window', { kind: 'original', token });
      const window = await WebviewWindow.getByLabel(label);
      if (!window) throw new Error('Original message window did not open');
      originalWindowRef.current = window;
      setOriginalDetached(true);
      originalCloseStopRef.current = await window?.onCloseRequested(() => {
        originalCloseStopRef.current?.();
        originalCloseStopRef.current = null;
        originalWindowRef.current = null;
        setOriginalDetached(false);
      });
    } catch (cause) {
      unlisten?.();
      setError(cause?.message || String(cause));
    }
  };

  const setComposeShellRef = useCallback((node) => {
    dialogRef.current = node;
    shellRef.current = node;
  }, [dialogRef]);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) return undefined;
    const measure = () => {
      if (node.clientWidth) setContentWidth(node.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (detached || !shellRef.current || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      // The CSS resize handle reports a content box. Persisting that value as
      // the next border-box style width subtracts the border on every pass.
      // Use the rendered border box so observing then restoring is stable.
      const borderBox = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
      const width = borderBox?.inlineSize || shellRef.current?.offsetWidth;
      const height = borderBox?.blockSize || shellRef.current?.offsetHeight;
      if (!width || !height) return;
      setComposeSize(previous => (
        previous && Math.abs(previous.width - width) < 1 && Math.abs(previous.height - height) < 1
          ? previous
          : { width: Math.round(width), height: Math.round(height) }
      ));
    });
    observer.observe(shellRef.current);
    return () => observer.disconnect();
  }, [detached]);

  // ── Autosaved draft (see services/localDrafts.js) ──
  // The vault draft this window owns. The uid is allocated on the first save
  // and threaded through minimize/restore, so one compose window is always one
  // draft, however many times it is put away and taken out again.
  const draftUidRef = useRef(initialData?._draftUid || null);
  const draftMailboxRef = useRef(initialData?._draftMailbox || null);
  // Which account currently holds it: picking a different From moves the draft
  // to that account's Drafts folder instead of leaving a copy behind.
  const draftAccountRef = useRef(initialData?._draftAccountId || initialData?._accountId || null);
  const lastSavedRef = useRef(null);
  // Saves are serialised: maildir_store deletes-then-writes one uid, so two
  // overlapping saves of the same draft can interleave into a lost write.
  const saveChainRef = useRef(Promise.resolve());

  const [formData, setFormData] = useState({
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    body: '',      // HTML content from the editor
    inReplyTo: '',
    references: ''
  });
  
  // Baseline for the dirty check (hasUserContent). Recorded by the init effect
  // from the form it actually produces — a snapshot taken from the render that
  // scheduled the effect holds the EMPTY pre-init form, so a signature-only
  // draft or an untouched forward reads as "unsaved changes".
  const initialSnapshot = useRef(null);
  const replyTemplateApplied = useRef(false);
  const replyTemplateCurrentBody = useRef('');
  const initializedRef = useRef(false);
  const publishedSnapshotRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Initialize form based on mode and replyTo email
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const initForm = (next, { preserveSnapshot = false } = {}) => {
      if (!preserveSnapshot) {
        initialSnapshot.current = { to: next.to, subject: next.subject, body: next.body };
      }
      if (replyTemplateApplied.current) replyTemplateCurrentBody.current = next.body;
      setFormData(next);
    };
    let signatureHtml = '';

    // Add signature if enabled
    const signature = getSignature(selectedAccountId);
    const sigBody = signature.html || textToHtml(signature.text || '');
    if (signature.enabled && sigBody) {
      signatureHtml = '<p></p><p>--</p>' + sigBody;
    }

    if (!replyTo) {
      if (initialData) {
        // Restore from undo-send or minimize: body is already HTML
        const bodyHtml = initialData.body || '';
        const next = {
          ...formData,
          to: initialData.to || '',
          cc: initialData.cc || '',
          bcc: initialData.bcc || '',
          subject: initialData.subject || '',
          // A prefill is the user's message to write, so the signature goes
          // under it. A restore already carries its signature inside `body`.
          body: initialData._prefill ? bodyHtml + signatureHtml : (bodyHtml || signatureHtml),
          inReplyTo: initialData.inReplyTo || '',
          references: initialData.references || '',
        };
        // A mailto: prefill is a fresh compose, not a restored draft: it
        // records its own baseline, so closing it untouched asks nothing.
        if (initialData._prefill) {
          initForm(next);
          return;
        }
        setFormData(next);
        // A restored window continues the SAME draft, so it keeps the baseline
        // recorded when that draft was first opened — carried through the
        // unmount by handleMinimize. Recording it from the restored content
        // instead made every restored draft read as pristine, and the next
        // dismissal took the "empty compose" branch: closed, no discard
        // confirmation, content gone. Restores that carry no baseline
        // (undo-send, outbox) had real content by definition — null means
        // "compare against empty", which reads them as dirty.
        initialSnapshot.current = initialData._baseline || null;
        if (initialData.attachments?.length) {
          setAttachments(initialData.attachments);
        }
        // Restore quoted content from minimized state
        setQuotedHtml(initialData._quotedHtml || '');
        setContextHtml(initialData._contextHtml || initialData._quotedHtml || '');
        setShowContext(initialData._showContext ?? composeContextVisible);
      } else {
        initForm({ ...formData, body: signatureHtml });
      }
      return;
    }

    const originalSubject = replyTo.subject || '';
    const fullQuotedHtml = originalHtml(replyTo, t('compose.originalMessage'));
    const quotedHeaderHtml = fullQuotedHtml.slice(0, fullQuotedHtml.indexOf('</p>') + 4);
    const fullQuotedBodyHtml = fullQuotedHtml.slice(quotedHeaderHtml.length);
    const quotedBodyHtml = replyTo._selectedQuoteHtml || fullQuotedBodyHtml;
    const contextMessages = replyTo._threadContext?.length ? replyTo._threadContext : [replyTo];
    const fullContextHtml = contextMessages.map(message => originalHtml(message, t('compose.originalMessage'))).join('<hr>');

    // Replies keep the original behind the collapsible toggle. A forward puts
    // it inline in the body, so storing it here as well would render the
    // toggle AND append the original a second time at send.
    if (mode !== 'forward') {
      setQuotedHtml(quotedHeaderHtml + quotedBodyHtml);
    }
    // A forward already carries its original in the outgoing body, but people
    // still need the complete source/thread while editing. Keep that reading
    // panel independent so it never duplicates the forwarded wire content.
    setContextHtml(fullContextHtml);
    setShowContext(composeContextVisible);

    const replyBody = templateBody == null
      ? signatureHtml
      : replyTemplateApplied.current ? replyTemplateCurrentBody.current : replyTemplateHtml(templateBody) + signatureHtml;

    // Every identity of every account: replying to a message *I* sent (from
    // any account or alias) must target its recipients, not me — and
    // reply-all must never re-add one of my own aliases.
    // ponytail: identities mined async from Sent may not have landed yet;
    // logins + configured send-as (the common self-reply cases) always have.
    const ownAddresses = identities.map(i => i.address);

    if (mode === 'reply' || mode === 'replyAll') {
      const recipients = computeReplyRecipients(replyTo, mode, ownAddresses);
      initForm({
        to: recipients.to,
        cc: recipients.cc,
        bcc: '',
        subject: originalSubject.startsWith('Re:') ? originalSubject : t('compose.re', { originalSubject }),
        body: replyBody,
        ...buildReplyHeaders(replyTo)
      }, { preserveSnapshot: templateBody != null && replyTemplateApplied.current });
      if (templateBody != null && !replyTemplateApplied.current) {
        replyTemplateCurrentBody.current = replyBody;
        replyTemplateApplied.current = true;
      }
    } else if (mode === 'forward') {
      initForm({
        to: '',
        cc: '',
        bcc: '',
        subject: originalSubject.startsWith('Fwd:') ? originalSubject : t('compose.fwd', { originalSubject }),
        body: signatureHtml + quotedHeaderHtml + fullQuotedBodyHtml,
        inReplyTo: '',
        references: ''
      });

      if (replyTo.attachments?.length > 0) {
        setAttachments(replyTo.attachments.map(att => ({
          filename: att.filename,
          contentType: att.contentType,
          size: att.size,
          content: att.content,
          isFromOriginal: true
        })));
      }
    }
  // composeContextVisible is the default for a newly opened reply. Toggling
  // it while this draft is active must not rerun this initializer and erase
  // the text the person is currently writing.
  }, [mode, replyTo, initialData, templateBody, selectedAccountId]);

  // Mine each account's Sent cache so the From list offers every address the
  // mailbox can actually send from, not just its login.
  useEffect(() => {
    let cancelled = false;
    for (const acc of rawAccounts || []) {
      suggestSendAsAddresses(acc).then(list => {
        if (cancelled || !list.length) return;
        setSentAsByAccount(prev => ({ ...prev, [acc.id]: list }));
      });
    }
    return () => { cancelled = true; };
  }, [rawAccounts]);

  const handleChange = (e) => {
    if (detaching) return;
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    setError(null);
  };
  
  // Shared by the file picker, the modal-wide drop fallback, the dashed attach
  // strip, and non-image files dropped on the editor.
  const addFiles = (files) => {
    if (detaching) return;
    for (const file of files) {
      // Read file as base64
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        setAttachments(prev => [...prev, {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          content: base64,
          isFromOriginal: false
        }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleFileSelect = (e) => {
    if (detaching) return;
    addFiles(Array.from(e.target.files || []));
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDrop = (e) => {
    if (detaching) return;
    e.preventDefault();
    e.stopPropagation();
    addFiles(Array.from(e.dataTransfer?.files || []));
  };

  const removeAttachment = (index) => {
    if (detaching) return;
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // Native file drops. In the app a file drag never reaches WebKit (see
  // src/utils/nativeDrop.js): Tauri reports enter/leave for the zone visuals
  // and the drop as pasteboard paths plus the pointer position. The element
  // under that point picks the zone, as the HTML5 handlers do by target.
  useEffect(() => {
    if (!window.__TAURI__ || document.body.dataset.mailvaultDemo === 'true') return undefined;
    let disposed = false;
    const stops = [];
    const onDrop = async ({ paths = [], position } = {}) => {
      if (detaching) return;
      dragDepth.current = 0;
      setDragging(false);
      const point = toClientPoint(position, {
        dpr: window.devicePixelRatio, width: window.innerWidth, height: window.innerHeight,
      });
      const zone = dropZoneAt(point, (x, y) => document.elementFromPoint(x, y));
      if (!zone || !paths.length) return;
      try {
        const records = (await invoke('read_dropped_files', { paths })).map(toAttachment);
        const inline = zone === 'editor' ? records.filter(r => r.contentType.startsWith('image/')) : [];
        const attach = records.filter(r => !inline.includes(r));
        if (inline.length) {
          const editor = editorRef.current;
          const pos = editor?.view?.posAtCoords({ left: point.x, top: point.y })?.pos ?? null;
          insertImages(editor, inline.map(r => ({ src: `data:${r.contentType};base64,${r.content}`, name: r.filename })), pos);
        }
        if (attach.length) setAttachments(prev => [...prev, ...attach]);
      } catch (e) {
        setError(String(e?.message ?? e));
      }
    };
    const target = { target: getCurrentWebviewWindow().label };
    Promise.all([
      listen('tauri://drag-enter', () => { if (!detaching) setDragging(true); }, target),
      listen('tauri://drag-leave', () => { if (!detaching) setDragging(false); }, target),
      listen('tauri://drag-drop', (ev) => onDrop(ev.payload), target),
    ]).then((fns) => { if (disposed) fns.forEach(f => f()); else stops.push(...fns); }).catch(() => {});
    return () => { disposed = true; stops.forEach(f => f()); };
  }, [detaching]);
  
  // Close templates dropdown on click outside or Escape
  useEffect(() => {
    if (!showTemplates) return;
    const handleClick = (e) => {
      if (templatesRef.current && !templatesRef.current.contains(e.target)) {
        setShowTemplates(false);
        setSavingTemplate(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setShowTemplates(false);
        setSavingTemplate(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    // Capture phase so this runs before the modal-level Escape handler,
    // letting us stopPropagation and keep the compose modal open while
    // the templates dropdown is visible.
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [showTemplates]);

  // Close the schedule popover on click outside or Escape — same shape as
  // the templates dropdown above. The picker's calendar and zone list are
  // portaled to body, outside scheduleRef: while one is open it owns the
  // outside click and the Escape, and only that layer closes.
  useEffect(() => {
    if (!showSchedulePicker) return;
    const handleClick = (e) => {
      if (hasOpenPopover()) return;
      if (scheduleRef.current && !scheduleRef.current.contains(e.target)) setShowSchedulePicker(false);
    };
    const handleKey = (e) => {
      if (e.key === 'Escape' && !hasOpenPopover()) { e.stopPropagation(); setShowSchedulePicker(false); }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [showSchedulePicker]);

  // Preselect the recipient's zone when the schedule panel opens, and again
  // if the first To address changes while it is open. Never over a zone
  // picked by hand, and never on an edit of a scheduled email, whose own
  // zone is the answer. The panel does not wait for the daemon.
  const suggestFor = firstRecipient(formData.to);
  const suggestAddress = suggestFor?.address.toLowerCase() || '';
  const suggestName = suggestFor?.name || suggestFor?.address || '';
  const editingScheduled = Boolean(initialData?._editScheduledId);
  useEffect(() => {
    if (!schedulePremium || !suggestAddress || scheduleDraft.tzPicked || editingScheduled) return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      const suggestion = await useScheduledStore.getState().suggestTz(suggestAddress);
      if (!live) return;
      // Back to this machine's zone when there is nothing for this
      // recipient: a zone already there was suggested for someone else.
      const tz = suggestion?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
      setScheduleDraft(d => (d.tzPicked || d.tz === tz ? d : { ...d, tz }));
      setTzSuggestion(suggestion && { ...suggestion, name: suggestName, address: suggestAddress });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [schedulePremium, suggestAddress, suggestName, scheduleDraft.tzPicked, editingScheduled]);

  const insertTemplate = (template) => {
    if (detaching) return;
    const editor = editorRef.current;
    if (editor) {
      // Insert template content as HTML at cursor position
      const templateHtml = textToHtml(template.body);
      editor.chain().focus().insertContent(templateHtml).run();
    } else {
      // Fallback: append to body
      setFormData(prev => {
        const body = prev.body + textToHtml(template.body);
        if (replyTemplateApplied.current) replyTemplateCurrentBody.current = body;
        return { ...prev, body };
      });
    }
    setShowTemplates(false);
  };

  const handleSaveTemplate = async () => {
    if (detaching) return;
    const name = templateName.trim();
    if (!name) return;
    const body = htmlToText(formData.body);
    try {
      if (onAddTemplate) await onAddTemplate({ name, body });
      else addEmailTemplate(name, body);
    } catch (err) {
      setError(err?.message || String(err));
      return;
    }
    setTemplateName('');
    setSavingTemplate(false);
    setShowTemplates(false);
  };

  const handleSend = async (event) => {
    event.preventDefault();
    if (detaching) return;
    if (!formData.to.trim()) { setError(t("compose.pleaseEnterLeastOneRecipient")); return; }
    if (!selectedAccount) { setError(t("compose.noAccountSelected")); return; }

    setSending(true);
    setError(null);
    try {
      await saveChainRef.current.catch(() => {});
      const snapshot = latestSnapshotRef.current();
      if (onQueueSend) {
        await onQueueSend(snapshot, snapshot._composeDelay);
      } else {
        const settings = { displayName: getDisplayName(snapshot._accountId) || selectedAccount.name || selectedAccount.email };
        const composeState = { mode, replyTo: snapshot._replyTo || actionReplyTo, initialData: snapshot };
        useMailStore.getState().queueSend(
          composeState,
          createComposeSend({ snapshot, mode, replyTo: composeState.replyTo, account: selectedAccount, settings }),
          snapshot._composeDelay,
        );
        onClose();
      }
    } catch (err) {
      setError(err.message || t("scheduled.errors.scheduleFailed"));
    } finally {
      setSending(false);
    }
  };

  const handleSchedule = async () => {
    if (detaching) return;
    if (!formData.to.trim()) { setError(t("compose.pleaseEnterLeastOneRecipient")); return; }
    if (!selectedAccount) { setError(t("compose.noAccountSelected")); return; }
    if (!scheduleDraft.localTime || isPastLocalTime(scheduleDraft.localTime, scheduleDraft.tz)) return;

    setSending(true);
    setError(null);
    try {
      await saveChainRef.current.catch(() => {});
      const snapshot = latestSnapshotRef.current();
      if (onSchedule) {
        await onSchedule(snapshot);
      } else {
        const settings = { displayName: getDisplayName(snapshot._accountId) || selectedAccount.name || selectedAccount.email };
        await scheduleCompose({ snapshot, account: selectedAccount, settings });
        onClose();
      }
    } catch (err) {
      // tErr: saving an edit over a row that already fired comes back as the
      // daemon's E_SCHEDULED_NOT_EDITABLE code. The window stays open either
      // way, holding the message.
      setError(err?.message ? tErr(err) : t("scheduled.errors.scheduleFailed"));
    } finally {
      setSending(false);
    }
  };

  const hasUserContent = initialSnapshot.current
    ? (formData.to !== initialSnapshot.current.to ||
       formData.subject !== initialSnapshot.current.subject ||
       htmlToText(formData.body).trim() !== htmlToText(initialSnapshot.current.body).trim() ||
       attachments.some(a => !a.isFromOriginal))
    : (formData.to.trim() !== '' || formData.subject.trim() !== '' ||
       htmlToText(formData.body).trim() !== '' || attachments.length > 0);

  const composeSnapshot = useCallback(() => {
    // Allocate before either the session or vault debounce starts. A quit in
    // their gap must resume the same local draft identity, not create another.
    if (hasUserContent && !draftUidRef.current) draftUidRef.current = newDraftUid();
    return {
      to: formData.to,
      cc: formData.cc,
      bcc: formData.bcc,
      subject: formData.subject,
      body: formData.body,
      inReplyTo: formData.inReplyTo,
      references: formData.references,
      attachments: [...attachments],
      _quotedHtml: quotedHtml,
      _contextHtml: contextHtml,
      _showContext: showContext,
      _replyTo: replyTo || initialData?._replyTo || null,
      _accountId: selectedAccountId,
      _fromAddress: composeFrom,
      _draftAccountId: draftAccountRef.current || selectedAccountId,
      _baseline: initialSnapshot.current,
      _draftUid: draftUidRef.current,
      _draftMailbox: draftMailboxRef.current,
      _composeDelay: composeDelay,
      _composeSize: composeSize,
      _scheduleDraft: scheduleDraft,
      // Which scheduled email this window is an edit of (localDrafts.js's
      // scheduledEmlToInitialData). Carried through every snapshot like
      // `_scheduleDraft`, so a minimize, undo or detach still replaces that
      // row instead of scheduling a second copy.
      ...(initialData?._editScheduledId && {
        _editScheduledId: initialData._editScheduledId,
        _editScheduledRow: initialData._editScheduledRow,
      }),
    };
  }, [formData, attachments, quotedHtml, contextHtml, showContext, replyTo, initialData, selectedAccountId, pickedFrom, hasUserContent, composeDelay, composeSize, scheduleDraft]);

  const latestSnapshotRef = useRef(composeSnapshot);
  latestSnapshotRef.current = composeSnapshot;
  if (snapshotRef) snapshotRef.current = async () => {
    await saveChainRef.current.catch(() => {});
    return latestSnapshotRef.current();
  };
  const publishSnapshot = useCallback(() => {
    if (!aliveRef.current) return;
    publishedSnapshotRef.current = true;
    onSaveStateRef.current?.(latestSnapshotRef.current());
  }, []);

  const hasSessionState = publishedSnapshotRef.current || Boolean(initialData) || Boolean(
    formData.to || formData.cc || formData.bcc || formData.subject || formData.body || attachments.length ||
    selectedAccountId !== initialIdentity.accountId || pickedFrom !== initialIdentity.address
  );
  const sessionSignature = JSON.stringify([
    formData.to, formData.cc, formData.bcc, formData.subject, formData.body,
    attachments, quotedHtml, contextHtml, showContext, selectedAccountId, pickedFrom, composeDelay, composeSize, scheduleDraft,
  ]);

  // Keep the UI session current independently of the vault draft write. App
  // stores this snapshot without passing it back as `initialData`, so it cannot
  // re-run this component's initialization effect while the user is typing.
  useEffect(() => {
    if (!hasSessionState || sending) return undefined;
    const timer = setTimeout(publishSnapshot, 300);
    return () => clearTimeout(timer);
  }, [hasSessionState, sending, sessionSignature, publishSnapshot]);

  // ── Autosave into the vault's Drafts folder, 0.3s after typing stops ──
  //
  // The window is no longer the only copy of what the user wrote. Local only:
  // no SMTP, no IMAP APPEND, so this costs nothing and works offline. The draft
  // is removed again when the message is sent or discarded.
  useEffect(() => {
    if (!hasUserContent || sending || !selectedAccount) return;
    const timer = setTimeout(() => {
      const files = attachments.map(att => ({
        filename: att.filename,
        content: att.content,
        encoding: 'base64',
        contentType: att.contentType,
      }));
      const signature = JSON.stringify([
        selectedAccountId, composeFrom, formData.to, formData.cc, formData.bcc,
        formData.subject, formData.body, quotedHtml.length,
        attachments.map(a => `${a.filename}:${a.size}`),
      ]);
      if (signature === lastSavedRef.current) return;
      lastSavedRef.current = signature;
      // Allocated here, not inside the async chain below: Send reads these to
      // clean the draft up, and a short message can be sent before the first
      // save has finished.
      if (!draftUidRef.current) draftUidRef.current = newDraftUid();
      const movedAccount = draftAccountRef.current && draftAccountRef.current !== selectedAccountId
        ? { accountId: draftAccountRef.current, mailbox: draftMailboxRef.current, uid: draftUidRef.current }
        : null;
      if (movedAccount) draftMailboxRef.current = null;
      draftAccountRef.current = selectedAccountId;

      // Inline pictures keep their data: URIs here — a draft is read back by
      // this app, and cid: parts would only pay off on the wire.
      const html = quotedHtml
        ? formData.body + '<hr><blockquote>' + quotedHtml + '</blockquote>'
        : formData.body;
      const text = htmlToText(formData.body);
      const payload = {
        to: formData.to,
        cc: formData.cc || undefined,
        bcc: formData.bcc || undefined,
        subject: formData.subject,
        text: quotedHtml
          ? text + '\n\n-------- Original Message --------\n' + htmlToText(quotedHtml)
          : text,
        html,
        inReplyTo: formData.inReplyTo || undefined,
        references: formData.references || undefined,
        attachments: files.length ? files : undefined,
      };
      // ponytail: the whole message is re-encoded on every pause, attachments
      // included. Fine at mail sizes; if a 20 MB attachment ever makes this
      // stutter, save the body and the files separately.
      saveChainRef.current = saveChainRef.current.then(async () => {
        try {
          if (movedAccount?.mailbox) await deleteLocalDraft(movedAccount);
          if (!draftMailboxRef.current) {
            draftMailboxRef.current = await resolveDraftsMailbox(selectedAccountId);
          }
          await saveLocalDraft({
            account: selectedAccount,
            accountId: selectedAccountId,
            mailbox: draftMailboxRef.current,
            uid: draftUidRef.current,
            fromAddress: composeFrom,
            displayName: getDisplayName(selectedAccountId) || selectedAccount.name || selectedAccount.email,
            payload,
            snippet: text,
            hasAttachments: attachments.length > 0,
          });
          // Mailbox resolution happens asynchronously. Publish the latest
          // state now, not the body captured when this save began.
          publishSnapshot();
        } catch (err) {
          // Typing must never be interrupted by a failed save. Clearing the
          // signature makes the next pause try again instead of assuming the
          // draft on disk is current.
          lastSavedRef.current = null;
          console.warn('[compose:autosave_fail]', err);
        }
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [formData, attachments, quotedHtml, hasUserContent, sending, selectedAccountId, composeFrom, publishSnapshot]);

  /** Drop the vault draft this window owns — the message is being thrown away. */
  const discardDraft = useCallback(() => {
    const accountId = draftAccountRef.current || selectedAccountId;
    // Behind the same chain the saves run on, and reading the refs only once
    // it gets there: a discard that overtakes a save in flight would either
    // delete a file that is about to be rewritten, or run before the save has
    // even resolved which folder the draft went to.
    saveChainRef.current = saveChainRef.current.then(() => {
      const uid = draftUidRef.current;
      const mailbox = draftMailboxRef.current;
      draftUidRef.current = null;
      if (!uid || !mailbox) return undefined;
      return deleteLocalDraft({ accountId, mailbox, uid });
    });
    return saveChainRef.current;
  }, [selectedAccountId]);

  /** Close for good: the vault copy goes with the window. */
  const closeDiscarding = useCallback(async () => {
    await discardDraft();
    (onDiscard || onClose)();
  }, [discardDraft, onClose, onDiscard]);

  const [showDiscardDialog, setShowDiscardDialog] = useState(false);

  const confirmClose = () => {
    if (detaching) return;
    if (hasUserContent) {
      setShowDiscardDialog(true);
      return;
    }
    closeDiscarding();
  };

  // Modal-level Escape: mirror the backdrop click — minimize to a draft
  // bubble if there's user content, close otherwise. If the discard dialog
  // is open, Escape dismisses that first. Templates-dropdown Escape uses
  // capture-phase + stopPropagation, so it preempts this handler.
  useEffect(() => {
    const handleKey = (e) => {
      if (detaching) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key !== 'Escape') return;
      // This modal owns Escape while it is mounted. App's global shortcut
      // (window, bubble phase — runs after this document listener) would
      // otherwise also resolve 'close-compose' and unmount the window: harmless
      // after a minimize, fatal with the discard dialog open — the dialog
      // closes and the draft is thrown away in the same keypress.
      e.stopPropagation();
      if (showDiscardDialog) {
        e.preventDefault();
        setShowDiscardDialog(false);
        return;
      }
      e.preventDefault();
      handleBackdropClick();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [detaching, showDiscardDialog, hasUserContent, onClose, onMinimize]);

  // Did the gesture that produced this click START on the backdrop?
  //
  // `click` is dispatched on the nearest common ancestor of the mousedown and
  // mouseup targets, so sweeping a text selection from the editor out past the
  // window edge fires `click` ON THE BACKDROP — the modal's own stopPropagation
  // is never in that event's path. Selecting text was therefore minimizing the
  // compose. A dismissal has to be pressed and released outside.
  const pressedOnBackdrop = useRef(false);

  // Backdrop click: minimize if has content, close if empty
  const handleBackdropClick = () => {
    if (detaching) return;
    if (hasUserContent && onMinimize) {
      handleMinimize();
    } else {
      closeDiscarding();
    }
  };

  const getTitle = () => {
    switch (mode) {
      case 'reply': return t('chat.bubble.reply');
      case 'replyAll': return t('compose.replyAll');
      case 'forward': return t('settings.shortcuts.forward');
      default: return t('compose.newMessage');
    }
  };

  // Save editor state before minimizing so it persists across unmount/remount
  const handleMinimize = async () => {
    if (detaching) return;
    const snapshot = snapshotRef?.current ? await snapshotRef.current() : latestSnapshotRef.current();
    if (onSaveState) {
      onSaveState(snapshot);
    }
    if (onMinimize) onMinimize(snapshot);
  };

  const handleDetach = async () => {
    if (!onDetach || sending || detaching) return;
    setDetaching(true);
    setSending(true);
    let transferred = false;
    try {
      // Do not hand a draft to another webview while a previous disk write can
      // still finish behind it. The snapshot is read after that chain settles
      // so its mailbox identity is the resolved one.
      // This uid is minted by the main webview before a blank draft crosses
      // into a native child. Each webview otherwise owns its own counter and
      // two blank windows opened in the same second can collide on first save.
      if (!draftUidRef.current) draftUidRef.current = newDraftUid();
      await saveChainRef.current.catch(() => {});
      await onDetach(latestSnapshotRef.current());
      transferred = true;
    } catch (err) {
      setError(err?.message || 'Could not open compose window');
    } finally {
      // The exiting source can remain mounted while AnimatePresence waits for
      // its animation. Keep it inert after a successful handoff so only the
      // native child can own the draft and its autosave chain.
      if (!transferred) {
        setSending(false);
        setDetaching(false);
      }
    }
  };

  const contextCollapsed = Boolean(contextHtml && showContext && contentWidth < 564);
  const effectiveContextWidth = Math.min(contextWidth, Math.max(240, contentWidth - 290));
  const composeWindowStyle = {
    ...(!detached && composeSize ? { width: composeSize.width, height: composeSize.height } : {}),
    ...(detaching ? { pointerEvents: 'none' } : {}),
  };
  const resizeComposeWindow = (event) => {
    const { key, shiftKey } = event;
    const widthDelta = key === 'ArrowLeft' ? -24 : key === 'ArrowRight' ? 24 : 0;
    const heightDelta = shiftKey && key === 'ArrowUp' ? -24 : shiftKey && key === 'ArrowDown' ? 24 : 0;
    if (!widthDelta && !heightDelta) return;
    event.preventDefault();
    setComposeSize(previous => {
      const current = previous || {
        width: shellRef.current?.clientWidth || 640,
        height: shellRef.current?.clientHeight || 520,
      };
      return {
        width: Math.max(320, Math.min(window.innerWidth - 32, current.width + widthDelta)),
        height: Math.max(320, Math.min(window.innerHeight - 32, current.height + heightDelta)),
      };
    });
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={detached ? 'h-screen w-screen bg-mail-bg' : 'fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4'}
      onMouseDown={(e) => { if (!detaching) pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (detaching) return;
        if (e.target !== e.currentTarget || !pressedOnBackdrop.current) return;
        handleBackdropClick();
      }}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        data-testid="compose-modal"
        ref={setComposeShellRef}
        inert={detaching || sending ? '' : undefined}
        style={composeWindowStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-dragging={dragging ? 'true' : 'false'}
        aria-busy={detaching || undefined}
        className={`compose-window bg-mail-surface border rounded-2xl
                   ${detached ? 'compose-window-detached h-screen w-screen border-0 rounded-none' : 'w-full max-w-4xl max-h-[90vh] h-[min(80vh,700px)] min-h-[320px] relative'} flex flex-col overflow-hidden
                   ${dragging ? 'border-mail-accent border-2' : 'border-mail-border'}`}
        onClick={(e) => e.stopPropagation()}
        onDragEnter={(e) => { if (detaching || !hasFiles(e)) return; dragDepth.current += 1; setDragging(true); }}
        onDragOver={(e) => { if (detaching || !hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDragLeave={() => { if (detaching) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false); }}
        // Capture phase: the editor's handleDrop stops propagation in the bubble
        // phase, so a bubble-phase reset would never run for editor drops.
        // The reset itself waits for the next task. A browser-dispatched event
        // gets a microtask checkpoint after every listener, so a synchronous
        // setState here would be committed — and the attach strip unmounted —
        // before the strip's own onDrop is dispatched; React then drops an
        // event whose target is no longer mounted, and the file never arrives.
        onDropCapture={() => { if (!detaching) { dragDepth.current = 0; setTimeout(() => setDragging(false), 0); } }}
        onDrop={detaching ? undefined : handleDrop}
      >
        <div ref={contentRef} data-testid="compose-content" className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        <div data-testid="compose-main" className="flex flex-1 min-h-0 min-w-[268px] flex-col overflow-hidden">
        {/* Header stays with the composer so the reading context is a true
            sibling of the complete working surface, not only its editor. */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border shrink-0">
          <h2 id={titleId} className="font-semibold text-mail-text">{getTitle()}</h2>
          <div className="flex items-center gap-1">
            {onMinimize && (
              <Button variant="ghost" icon size="sm" className="hover:bg-mail-border"
                onClick={handleMinimize}
                title={t('common.minimize')}
              >
                <Minimize2 size={16} className="text-mail-text-muted" />
              </Button>
            )}
            {onDetach && !detached && (
              <Button variant="ghost" icon size="sm" className="hover:bg-mail-border"
                onClick={handleDetach} title={t('chat.bubble.openNewWindow')} data-testid="compose-detach">
                <Maximize2 size={16} className="text-mail-text-muted" />
              </Button>
            )}
            {contextHtml && <Button variant="ghost" icon size="sm" onClick={openOriginalWindow}
              title={originalDetached ? t('compose.focusOriginalWindow') : t('compose.detachOriginal')}
              aria-label={originalDetached ? t('compose.focusOriginalWindow') : t('compose.detachOriginal')}
              data-testid="compose-original-detach"><Maximize2 size={16} className="text-mail-text-muted" /></Button>}
            <Button variant="ghost" icon size="sm" className="hover:bg-mail-border"
              onClick={confirmClose}
              title={t('common.close')}
            >
              <X size={16} className="text-mail-text-muted" />
            </Button>
          </div>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSend}
          onKeyDown={(e) => {
            if (detaching) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            // Enter in text inputs must NOT submit the form — autocomplete
            // selection with Enter would otherwise send an empty/incomplete
            // email. Shift+Enter is the explicit send shortcut.
            if (e.key === 'Enter' && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) {
              if (e.shiftKey) {
                e.preventDefault();
                handleSend(e);
              } else {
                e.preventDefault();
              }
            }
          }}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <div className="compose-scroll">
          {initialData?._editScheduledRow && (
            <p data-testid="compose-editing-scheduled"
              className="px-5 py-2 flex items-center gap-1.5 text-xs text-mail-text-muted bg-mail-accent/5 border-b border-mail-border">
              <Clock size={12} className="shrink-0" aria-hidden="true" />
              {t('scheduled.compose.editing', {
                time: formatWallClock(initialData._editScheduledRow.localTime, getLocale()),
                tz: initialData._editScheduledRow.tz,
              })}
            </p>
          )}
          <div className="compose-addresses px-5 py-3 space-y-1 border-b border-mail-border">
            {/* From — shown whenever there is a choice to make, which on a
                single account means it has an override or a mined alias. */}
            {identities.length > 0 && (
              <div className="flex items-center gap-2">
                <label className="w-16 flex-shrink-0 text-sm text-mail-text-muted">{t('compose.from')}</label>
                <div className="relative flex-1 min-w-0">
                  <select aria-label={t('compose.from')}
                    data-testid="compose-from"
                    value={`${selectedAccountId} ${composeFrom}`}
                    onChange={(e) => {
                      if (detaching) return;
                      const [accountId, address] = e.target.value.split(' ');
                      setSelectedAccountId(accountId);
                      setPickedFrom(address);
                    }}
                    className="w-full bg-transparent text-mail-text text-sm py-1 pr-6
                              outline-none appearance-none cursor-pointer"
                  >
                    {accounts.map(acc => {
                      const ids = identities.filter(i => i.accountId === acc.id);
                      // A name that IS the address adds nothing and, with an
                      // override set, would show both addresses at once.
                      const named = acc.name && acc.name !== acc.email;
                      if (ids.length === 1) {
                        const label = named ? `${acc.name} <${ids[0].address}>` : ids[0].address;
                        return <option key={acc.id} value={ids[0].key}>{label}</option>;
                      }
                      // The native optgroup indents the addresses under the account.
                      return (
                        <optgroup key={acc.id} label={named ? acc.name : acc.email}>
                          {ids.map(i => (
                            <option key={i.key} value={i.key}>{i.address}</option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                  <ChevronDown size={14} className="absolute right-0 top-1/2 -translate-y-1/2
                                                     text-mail-text-muted pointer-events-none" />
                </div>
              </div>
            )}

            {/* To */}
            <RecipientField
              name="to"
              label="To:"
              placeholder={t('compose.recipientExampleCom')}
              value={formData.to}
              onChange={handleChange}
              setValue={(v) => setFormData(prev => ({ ...prev, to: v }))}
              testid="compose-to"
              boostAccountId={selectedAccountId}
            />

            {/* CC */}
            <RecipientField
              name="cc"
              label="Cc:"
              placeholder={t('compose.ccExampleCom')}
              value={formData.cc}
              onChange={handleChange}
              setValue={(v) => setFormData(prev => ({ ...prev, cc: v }))}
              testid="compose-cc"
              boostAccountId={selectedAccountId}
            />

            {/* BCC */}
            <RecipientField
              name="bcc"
              label="Bcc:"
              placeholder={t('compose.bccExampleCom')}
              value={formData.bcc}
              onChange={handleChange}
              setValue={(v) => setFormData(prev => ({ ...prev, bcc: v }))}
              testid="compose-bcc"
              boostAccountId={selectedAccountId}
            />
            
            {/* Subject */}
            <div className="flex items-center gap-2">
              <label className="w-16 flex-shrink-0 text-sm text-mail-text-muted">{t('compose.subject2')}</label>
              <input aria-label={t('compose.subject2')}
                type="text"
                name="subject"
                data-testid="compose-subject"
                value={formData.subject}
                onChange={handleChange}
                onKeyDown={(e) => {
                  if (e.key === 'Tab' && !e.shiftKey) {
                    const editor = editorRef.current;
                    if (editor?.chain) {
                      e.preventDefault();
                      editor.chain().focus(signatureCaretPos(editor.state.doc) ?? 'start').run();
                    }
                  }
                }}
                placeholder={t('compose.subject')}
                spellCheck={spellcheckEnabled}
                className="flex-1 bg-transparent text-mail-text placeholder-mail-text-muted
                          outline-none text-sm py-1"
              />
            </div>
          </div>

          {/* AI Compose actions (Phase 6). Draft reply/action items/summarize
              need thread text, which only exists when replying/forwarding —
              a fresh compose only gets shorten/tone. */}
          <div className="px-5 py-1.5 border-b border-mail-border">
            <AiComposeActions
              actions={actionReplyTo ? ['draftReply', 'shorten', 'tone', 'actionItems', 'summarize'] : ['shorten', 'tone']}
              getThreadText={() => htmlToText(contextHtml || quotedHtml || '')}
              getDraftText={() => htmlToText(formData.body)}
              onResult={(_actionId, text) => {
                // Through the editor's own chain, not the `content` prop —
                // RichTextEditor's external-sync effect applies that with
                // `addToHistory: false` (it exists for spellcheck/minimize
                // restores), which would make Ctrl+Z unable to bring back
                // whatever this action just replaced. Falls back to the prop
                // path only if the editor has not mounted yet, where there
                // is nothing to undo either way.
                const editor = editorRef.current;
                const html = textToHtml(text);
                if (editor?.chain) editor.chain().focus().setContent(html).run();
                else setFormData(prev => ({ ...prev, body: html }));
                setError(null);
              }}
            />
          </div>

          {/* Attachments */}
          {attachments.length > 0 && (
            <div data-testid="compose-attachments" className="px-5 py-3 border-b border-mail-border shrink-0 max-h-32 overflow-y-auto">
              <div className="flex items-center gap-2 mb-2 text-sm text-mail-text-muted">
                <Paperclip size={14} />
                <span>{attachments.length} Attachment(s)</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {attachments.map((att, index) => (
                  <AttachmentPreview
                    key={index}
                    attachment={att}
                    onRemove={() => removeAttachment(index)}
                  />
                ))}
              </div>
            </div>
          )}
          
          <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
          {/* Body — Rich Text Editor */}
          <div
            className={`compose-editor relative flex-1 overflow-hidden flex flex-col ${dragging ? 'ring-2 ring-inset ring-mail-accent' : ''}`}
            data-testid="compose-body"
          >
            {dragging && (
              // pointer-events-none so the drop lands on the editor underneath —
              // ProseMirror's posAtCoords needs the real target.
              <div data-testid="compose-inline-dropzone-hint"
                   className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-2">
                <span className="rounded-full bg-mail-accent-fill px-3 py-1 text-xs font-medium text-white shadow">
                  {t('compose.dropImagePlaceMessage')}
                </span>
              </div>
            )}
            <RichTextEditor
              content={formData.body}
              editorRef={editorRef}
              onFiles={addFiles}
              onUpdate={(html) => {
                if (detaching) return;
                if (replyTemplateApplied.current) replyTemplateCurrentBody.current = html;
                setFormData(prev => ({ ...prev, body: html }));
                setError(null);
              }}
              placeholder={t('compose.writeMessage')}
            />
          </div>

          {/* Still mounted when its own onDrop is dispatched: the modal's
              onDropCapture resets `dragging` on the next task, never inside
              the drop's own dispatch. */}
          {dragging && (
            <div
              data-testid="compose-attach-dropzone"
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); addFiles(Array.from(e.dataTransfer?.files || [])); }}
              className="mx-4 my-2 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed
                         border-mail-accent/60 bg-mail-accent/5 py-3 text-sm text-mail-text-muted"
            >
              <Paperclip size={16} />
              <span>{t('compose.dropHereAttachFile')}</span>
            </div>
          )}

          </div>

          {/* Error */}
          {error && (
            <div data-testid="compose-error" role="alert"
                 className="px-4 py-2 bg-mail-danger/10 border-t border-mail-danger/20
                           text-mail-danger text-sm">
              {error}
            </div>
          )}
          </div>
          
          {/* Footer */}
          <div className="compose-footer flex items-center justify-between gap-3 px-5 py-3 border-t border-mail-border shrink-0">
            <div className="flex items-center gap-2">
              <input
                type="file"
                data-testid="compose-attach-input"
                ref={fileInputRef}
                onChange={handleFileSelect}
                multiple
                className="hidden"
              />
              <Button variant="ghost" icon size="md" className="hover:bg-mail-border"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title={t('compose.attachFiles')}
              >
                <Paperclip size={18} className="text-mail-text-muted" />
              </Button>
              <div className="relative" ref={templatesRef}>
                <Button variant="ghost" icon size="md" className="hover:bg-mail-border"
                  type="button"
                  data-testid="compose-templates-btn"
                  onClick={() => { setShowTemplates(v => !v); setSavingTemplate(false); }}
                  title={t('compose.templates')}
                >
                  <BookTemplate size={18} className="text-mail-text-muted" />
                </Button>
                {showTemplates && (
                  <div className="absolute bottom-full left-0 mb-1 w-64 bg-mail-surface border border-mail-border
                                  rounded-lg z-50 overflow-hidden">
                    {emailTemplates.length > 0 && (
                      <div className="max-h-48 overflow-y-auto">
                        {emailTemplates.map(t => (
                          <button
                            key={t.id}
                            type="button"
                            data-testid="compose-template-item"
                            onClick={() => insertTemplate(t)}
                            className="w-full text-left px-3 py-2 text-sm text-mail-text
                                      hover:bg-mail-surface-hover transition-colors truncate"
                          >
                            {t.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {emailTemplates.length === 0 && (
                      <div data-testid="compose-templates-empty" className="px-3 py-2 text-xs text-mail-text-muted">
                        {t('compose.noTemplatesYet')}
                      </div>
                    )}
                    <div className="border-t border-mail-border">
                      {savingTemplate ? (
                        <div className="flex items-center gap-1 p-2">
                          <input
                            aria-label={t('compose.templateName')}
                            type="text"
                            data-testid="compose-template-name"
                            value={templateName}
                            onChange={(e) => setTemplateName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveTemplate(); } }}
                            placeholder={t('compose.templateName')}
                            autoFocus
                            className="flex-1 bg-transparent text-sm text-mail-text placeholder-mail-text-muted
                                      outline-none border border-mail-border rounded px-2 py-1"
                          />
                          <button
                            type="button"
                            data-testid="compose-template-save"
                            onClick={handleSaveTemplate}
                            disabled={!templateName.trim()}
                            className="px-2 py-1 text-xs bg-mail-accent-fill text-white rounded
                                      hover:bg-mail-accent-hover disabled:opacity-50 transition-colors"
                          >
                            {t('common.save')}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          data-testid="compose-template-save-as"
                          onClick={() => setSavingTemplate(true)}
                          className="w-full text-left px-3 py-2 text-sm text-mail-accent-text
                                    hover:bg-mail-surface-hover transition-colors"
                        >
                          {t('compose.saveTemplate')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={confirmClose}
                className="px-4 py-2 text-mail-text-muted hover:text-mail-text
                          transition-colors text-sm"
              >
                {t('common.discard')}
              </button>
              <select
                aria-label={t('compose.sendDelay')}
                data-testid="compose-delay"
                value={composeDelay ?? globalSendDelay}
                onChange={(e) => setComposeDelay(Number(e.target.value))}
                className="px-2 py-2 bg-mail-bg border border-mail-border rounded-lg
                          text-xs text-mail-text-muted cursor-pointer"
                title={t('compose.sendDelay')}
              >
                <option value={0}>{t('compose.sendNow')}</option>
                <option value={15}>{t('compose.delay15s')}</option>
                <option value={30}>{t('compose.delay30s')}</option>
                <option value={60}>{t('compose.delay1m')}</option>
                <option value={120}>{t('compose.delay2m')}</option>
                <option value={180}>{t('compose.delay3m')}</option>
                <option value={300}>{t('compose.delay5m')}</option>
              </select>
              <button
                type="submit"
                data-testid="compose-send"
                disabled={sending}
                title={t('compose.sendShiftEnter')}
                className="flex items-center gap-2 px-4 py-2 bg-mail-accent-fill
                          hover:bg-mail-accent-hover disabled:opacity-50
                          text-white font-medium rounded-lg transition-all text-sm"
              >
                {sending ? (
                  <>
                    <Loader size={16} className="animate-spin" />
                    {t('compose.sending')}
                  </>
                ) : (
                  <>
                    <Send size={16} />
                    {t('compose.send')}
                  </>
                )}
              </button>
              <div className="relative" ref={scheduleRef}>
                <button
                  type="button"
                  data-testid="compose-schedule-toggle"
                  disabled={sending}
                  title={t('scheduled.compose.menuLabel')}
                  onClick={() => {
                    // The panel hangs left from this button inside compose-main,
                    // which clips: with a reply's context pane open that can be
                    // ~320px, less than the panel wants. Never wider than the room.
                    const main = scheduleRef.current?.closest('[data-testid="compose-main"]');
                    const room = main ? scheduleRef.current.getBoundingClientRect().right - main.getBoundingClientRect().left - 8 : 0;
                    setScheduleMaxWidth(room > 0 ? room : undefined);
                    setShowSchedulePicker(v => !v);
                  }}
                  className="flex items-center justify-center px-2 py-2 bg-mail-accent-fill
                            hover:bg-mail-accent-hover disabled:opacity-50
                            text-white rounded-lg transition-all"
                >
                  <ChevronRight size={16} className={showSchedulePicker ? '-rotate-90 transition-transform' : 'rotate-90 transition-transform'} />
                </button>
                {showSchedulePicker && (
                  <div style={{ maxWidth: scheduleMaxWidth }}
                    className="absolute bottom-full right-0 mb-1 w-[26rem] bg-mail-surface border border-mail-border
                                  rounded-lg z-50 p-3 space-y-2">
                    <div className="text-sm font-medium text-mail-text">{t('scheduled.compose.pickerTitle')}</div>
                    {schedulePremium ? <>
                    <SchedulePicker
                      localTime={scheduleDraft.localTime}
                      tz={scheduleDraft.tz}
                      onChange={(next) => setScheduleDraft(d => ({ ...next, tzPicked: d.tzPicked || next.tz !== d.tz }))}
                      testIdPrefix="compose-schedule"
                      tzNote={tzSuggestion?.tz !== scheduleDraft.tz || tzSuggestion.address !== suggestAddress ? null
                        : tzSuggestion.source === 'email'
                        ? t('scheduled.picker.suggestedFromEmail', { name: tzSuggestion.name, offset: tzSuggestion.offset })
                        : t('scheduled.picker.suggestedLastUsed', { name: tzSuggestion.name })}
                    />
                    <ScheduledSendNotice />
                    <div className="flex justify-end gap-2 pt-1">
                      <button type="button" data-testid="compose-schedule-cancel"
                        onClick={() => setShowSchedulePicker(false)}
                        className="px-3 py-1.5 text-sm text-mail-text-muted hover:text-mail-text transition-colors">
                        {t('common.cancel')}
                      </button>
                      <button type="button" data-testid="compose-schedule-submit"
                        disabled={sending || !scheduleDraft.localTime || isPastLocalTime(scheduleDraft.localTime, scheduleDraft.tz)}
                        onClick={handleSchedule}
                        className="px-3 py-1.5 text-sm bg-mail-accent-fill hover:bg-mail-accent-hover
                                  disabled:opacity-50 text-white font-medium rounded-lg transition-all">
                        {t('scheduled.compose.submit')}
                      </button>
                    </div>
                    </> : (
                      <div data-testid="compose-schedule-locked" className="space-y-2">
                        <p className="text-xs text-mail-text">{t('scheduled.premium.upsell')}</p>
                        <p className="text-xs text-mail-text-muted">{t('scheduled.premium.freeDelay')}</p>
                        <div className="flex justify-end pt-1">
                          <button type="button" data-testid="compose-schedule-upgrade"
                            onClick={() => {
                              setShowSchedulePicker(false);
                              // A compose window of its own has no Settings:
                              // ComposeWindow routes this to the main window.
                              if (onUpgrade) onUpgrade();
                              else useMailStore.getState().requestSettingsTab('billing');
                            }}
                            className="px-3 py-1.5 text-sm bg-mail-accent-fill hover:bg-mail-accent-hover
                                      text-white font-medium rounded-lg transition-all">
                            {t('common.upgrade')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          </form>
          </div>

          {contextHtml && !originalDetached && <>
            <button
              type="button"
              data-testid="compose-resize"
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label={t('compose.resizeOriginalPanel')}
              aria-valuemin={240}
              aria-valuemax={Math.max(240, Math.min(760, contentWidth - 290))}
              aria-valuenow={Math.round(effectiveContextWidth)}
              onPointerDown={event => {
                contextDragRef.current = { id: event.pointerId, x: event.clientX, width: effectiveContextWidth };
                event.currentTarget.setPointerCapture?.(event.pointerId);
              }}
              onPointerMove={event => {
                const drag = contextDragRef.current;
                if (!drag || drag.id !== event.pointerId) return;
                setContextWidth(Math.max(240, Math.min(760, Math.min(contentWidth - 290, drag.width + drag.x - event.clientX))));
              }}
              onPointerUp={() => { contextDragRef.current = null; }}
              onPointerCancel={() => { contextDragRef.current = null; }}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                event.preventDefault();
                setContextWidth(width => Math.max(240, Math.min(760, contentWidth - 290, width + (event.key === 'ArrowLeft' ? -20 : 20))));
              }}
              className={`w-1.5 shrink-0 cursor-col-resize touch-none bg-mail-border hover:bg-mail-accent focus:outline-none focus:bg-mail-accent ${showContext ? '' : 'hidden'}`}
            />
            <aside
              data-testid="compose-context"
              style={showContext && !contextCollapsed ? { width: effectiveContextWidth } : undefined}
              className={`shrink-0 flex flex-col min-h-0 overflow-hidden ${showContext && !contextCollapsed ? 'border-l border-mail-border compose-context-aside' : 'w-12'}`}
            >
              <button
                type="button"
                data-testid="compose-context-toggle"
                aria-pressed={showContext}
                aria-expanded={showContext && !contextCollapsed}
                aria-label={t('compose.showHideOriginalMessage', { action: showContext && !contextCollapsed ? t('settings.backup.verify.hide') : t('compose.show') })}
                onClick={async () => {
                  const next = !showContext;
                  setShowContext(next);
                  try {
                    if (onContextVisibleChange) await onContextVisibleChange(next);
                    else setComposeContextVisible?.(next);
                  } catch (err) {
                    setShowContext(!next);
                    setError(err?.message || String(err));
                  }
                }}
                className="w-full shrink-0 flex items-center gap-2 px-4 py-2 text-xs text-mail-text-muted hover:bg-mail-surface-hover transition-colors"
              >
                <ChevronRight size={14} className={`transition-transform ${showContext ? 'rotate-90' : ''}`} />
                {showContext && !contextCollapsed && <span>{t('compose.showHideOriginalMessage', { action: t('settings.backup.verify.hide') })}</span>}
              </button>
              {showContext && !contextCollapsed && (
                <div data-testid="compose-context-panel" className="flex-1 min-h-0 overflow-y-auto px-4 pb-3">
                  <div data-testid="compose-quoted" className="pt-2"><QuotedOriginal html={contextHtml} /></div>
                </div>
              )}
            </aside>
          </>}
          </div>
          {!detached && (
            <button
              type="button"
              data-testid="compose-window-resize"
              role="separator"
              tabIndex={0}
              aria-label={t('compose.resizeWindow')}
              onKeyDown={resizeComposeWindow}
              className="compose-window-resize"
            ><span aria-hidden="true">↘</span></button>
          )}
      </motion.div>

      {/* Discard confirmation. Above the compose window it belongs to. */}
      <Dialog
        open={showDiscardDialog}
        onClose={() => setShowDiscardDialog(false)}
        role="alertdialog"
        size="sm"
        panelBg="bg-mail-surface"
        data-testid="compose-discard-dialog"
        title={t('compose.discardMessage')}
        description={t('compose.discardDescription')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="ghost" onClick={() => setShowDiscardDialog(false)} data-autofocus>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => { setShowDiscardDialog(false); closeDiscarding(); }}>
              {t('common.discard')}
            </Button>
          </div>
        }
      />
    </motion.div>
  );
}
