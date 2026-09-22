import React, { useState, useEffect, useRef, useCallback, useId } from 'react';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useAccountStore } from '../stores/accountStore';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { formatDateTime } from '../utils/dateFormat';
import { motion } from 'framer-motion';
import { X, Send, Paperclip, Loader, Minimize2, FileText, Trash2, ChevronDown, BookTemplate, ChevronRight } from 'lucide-react';
import * as api from '../services/api';
import { ensureFreshToken } from '../services/authUtils';
import * as db from '../services/db';
import { RichTextEditor, insertImages, textToHtml, htmlToText, inlineComposeSpacing } from './RichTextEditor';
import { ContactsPickerButton, ContactsAutocomplete } from './ContactsPicker';
import { findSentMailboxPath } from '../utils/sentFolder';
import { buildEmailIframeHtml, attachEmailIframeAutoSize } from '../utils/emailIframeTemplate';
import { extractInlineImages } from '../utils/inlineImages';
import { buildReplyHeaders, parseReferenceList, computeReplyRecipients, splitRecipients } from '../utils/emailParser';
import { replyTemplateHtml } from '../utils/replyTemplate';
import { suggestSendAsAddresses, composeIdentities, resolveInitialComposeIdentity } from '../utils/sendAsSuggestions';
import { resolveDraftsMailbox, saveLocalDraft, deleteLocalDraft, newDraftUid } from '../services/localDrafts';
import { markAnswered, markForwarded } from '../services/workflows/messageMutations';
import { t, useT  } from '../i18n/index.js';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { send } from '../services/transport';
import { toClientPoint, dropZoneAt, toAttachment } from '../utils/nativeDrop';
import { useScheduledStore } from '../stores/scheduledStore';
import { SchedulePicker } from './scheduled/SchedulePicker';
import { ScheduledSendNotice } from './scheduled/ScheduledFolderModal';
import { isPastLocalTime, zonedTimeToEpoch } from '../utils/scheduledTime';
import { AiComposeActions } from './ai/AiComposeActions';
import { signatureCaretPos } from '../utils/signatureCaret';

// Find the Sent mailbox path for a specific account.
// Tiers: account.sentFolderOverride → disk/store mailbox tree via SPECIAL-USE
// or localized name → tier 3 server-side ensure/CREATE (Thunderbird-style).
// On tier 3 success, the resolved path is persisted to the account so future
// sends skip the probe. Returns { path, account } where account reflects
// any persisted override.
async function resolveSentMailboxForAccount(account) {
  const accountId = account.id;
  const { activeAccountId, mailboxes } = useMailStore.getState();
  let list = activeAccountId === accountId && mailboxes?.length ? mailboxes : null;
  if (!list) {
    list = await db.getCachedMailboxes(accountId).catch(() => null);
  }
  const localHit = findSentMailboxPath(list, account.sentFolderOverride || null);
  if (localHit) return { path: localHit, account };

  // Tier 3: probe/create on server
  try {
    const path = await api.ensureSentMailbox(account);
    if (path) {
      const updated = { ...account, sentFolderOverride: path };
      await db.saveAccount(updated).catch(err => {
        console.warn('[ComposeModal] failed to persist sentFolderOverride:', err);
      });
      useMailStore.setState(s => ({
        accounts: (s.accounts || []).map(a => a.id === accountId ? { ...a, sentFolderOverride: path } : a),
      }));
      // Refresh mailbox tree so sidebar/Zustand reflect any newly-created Sent folder.
      try {
        const freshBoxes = await api.fetchMailboxes(updated);
        if (Array.isArray(freshBoxes) && freshBoxes.length) {
          await db.saveMailboxes?.(accountId, freshBoxes).catch(() => {});
          useMailStore.setState(s => ({
            mailboxes: s.activeAccountId === accountId ? freshBoxes : s.mailboxes,
          }));
        }
      } catch (err) {
        console.warn('[ComposeModal] post-ensure mailbox refresh failed:', err);
      }
      return { path, account: updated };
    }
  } catch (err) {
    console.warn('[ComposeModal] ensureSentMailbox failed:', err);
  }
  return { path: null, account };
}

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

export function ComposeModal({ mode = 'new', replyTo = null, initialData = null, templateBody = null, onClose, onMinimize, onSaveState }) {
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
  const [error, setError] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [quotedHtml, setQuotedHtml] = useState('');
  const [contextHtml, setContextHtml] = useState('');
  const [showContext, setShowContext] = useState(() => initialData?._showContext ?? ((mode === 'reply' || mode === 'replyAll') && composeContextVisible));
  // WebKit reports a null relatedTarget on dragleave, so the old
  // `contains(relatedTarget)` check never worked — count enter/leave instead.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [composeDelay, setComposeDelay] = useState(null); // null = use global
  const [showSchedulePicker, setShowSchedulePicker] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState(() => ({
    localTime: '',
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  const fileInputRef = useRef(null);
  const editorRef = useRef(null);
  const templatesRef = useRef(null);
  const scheduleRef = useRef(null);
  const onSaveStateRef = useRef(onSaveState);
  useEffect(() => { onSaveStateRef.current = onSaveState; }, [onSaveState]);

  // ── Autosaved draft (see services/localDrafts.js) ──
  // The vault draft this window owns. The uid is allocated on the first save
  // and threaded through minimize/restore, so one compose window is always one
  // draft, however many times it is put away and taken out again.
  const draftUidRef = useRef(initialData?._draftUid || null);
  const draftMailboxRef = useRef(initialData?._draftMailbox || null);
  // Which account currently holds it: picking a different From moves the draft
  // to that account's Drafts folder instead of leaving a copy behind.
  const draftAccountRef = useRef(initialData?._accountId || null);
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
      setContextHtml(fullContextHtml);
      setShowContext(composeContextVisible);
    }

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
  }, [mode, replyTo, initialData, templateBody, selectedAccountId, composeContextVisible]);

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
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    setError(null);
  };
  
  // Shared by the file picker, the modal-wide drop fallback, the dashed attach
  // strip, and non-image files dropped on the editor.
  const addFiles = (files) => {
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
    addFiles(Array.from(e.target.files || []));
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    addFiles(Array.from(e.dataTransfer?.files || []));
  };

  const removeAttachment = (index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // Native file drops. In the app a file drag never reaches WebKit (see
  // src/utils/nativeDrop.js): Tauri reports enter/leave for the zone visuals
  // and the drop as pasteboard paths plus the pointer position. The element
  // under that point picks the zone, as the HTML5 handlers do by target.
  useEffect(() => {
    if (!window.__TAURI__) return undefined;
    let disposed = false;
    const stops = [];
    const onDrop = async ({ paths = [], position } = {}) => {
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
    Promise.all([
      listen('tauri://drag-enter', () => setDragging(true)),
      listen('tauri://drag-leave', () => setDragging(false)),
      listen('tauri://drag-drop', (ev) => onDrop(ev.payload)),
    ]).then((fns) => { if (disposed) fns.forEach(f => f()); else stops.push(...fns); }).catch(() => {});
    return () => { disposed = true; stops.forEach(f => f()); };
  }, []);
  
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
  // the templates dropdown above.
  useEffect(() => {
    if (!showSchedulePicker) return;
    const handleClick = (e) => {
      if (scheduleRef.current && !scheduleRef.current.contains(e.target)) setShowSchedulePicker(false);
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setShowSchedulePicker(false); }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [showSchedulePicker]);

  const insertTemplate = (template) => {
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

  const handleSaveTemplate = () => {
    const name = templateName.trim();
    if (!name) return;
    addEmailTemplate(name, htmlToText(formData.body));
    setTemplateName('');
    setSavingTemplate(false);
    setShowTemplates(false);
  };

  // Build the outgoing message the same way a normal send and a scheduled
  // send both need it — identity, inline-image handling, quoted-content
  // composition and Sent-folder resolution must never drift between the two
  // paths (several of the lines below carry their own scar tissue about
  // exactly that). `sendFn` below and `handleSchedule` are its only callers.
  const buildOutgoingPayload = async (freshAccount) => {
    // Get display name from settings or account
    const displayName = getDisplayName(selectedAccountId) || freshAccount.name || freshAccount.email;
    // Send-as override: the outgoing identity only. Credentials stay bound
    // to freshAccount.email, so this never touches auth. Applied to BOTH
    // the build_mime and the send call — if they drift, the staged .eml
    // and the message that actually leaves carry different From headers.
    const fromAddress = composeFrom || freshAccount.email;
    const sendAsEmail = fromAddress !== freshAccount.email ? fromAddress : '';

    // Inline pictures leave as cid: parts — Gmail/Outlook.com strip data: URIs.
    // Only the outgoing copy is rewritten; composeState.initialData.body keeps
    // the data URIs so an undone/minimized draft still renders the picture.
    const inline = extractInlineImages(formData.body);

    // Prepare attachments for nodemailer
    const emailAttachments = [
      ...attachments.map(att => ({
        filename: att.filename,
        content: att.content,
        encoding: 'base64',
        contentType: att.contentType
      })),
      ...inline.attachments.map(a => ({
        filename: a.filename,
        content: a.content,
        encoding: 'base64',
        contentType: a.contentType,
        cid: a.cid,
      })),
    ];

    // Combine compose body with quoted content for the sent email.
    // Only what was typed here gets the editor's spacing inlined — the
    // quoted part is someone else's markup and keeps its own.
    const composed = inlineComposeSpacing(inline.html);
    const fullHtml = quotedHtml
      ? composed + '<hr><blockquote>' + quotedHtml + '</blockquote>'
      : composed;
    // The text part is rendered from the same HTML the recipient reads.
    const fullText = quotedHtml
      ? htmlToText(formData.body) + '\n\n-------- Original Message --------\n' + htmlToText(quotedHtml)
      : htmlToText(formData.body);

    // Resolve the account's Sent folder once — used for both local
    // Maildir archival (where we write the raw .eml so the email is
    // visible/retrievable even if the server never sees it) and for the
    // subsequent server-side IMAP APPEND.
    const isGraph = freshAccount.oauth2Transport === 'graph';
    const resolved = await resolveSentMailboxForAccount(freshAccount);
    const sentFolderPath = resolved.path;
    const accountForSend = resolved.account;
    const sentMailbox = isGraph ? null : sentFolderPath;

    const outgoingPayload = {
      to: formData.to,
      cc: formData.cc || undefined,
      bcc: formData.bcc || undefined,
      subject: formData.subject,
      text: fullText,
      html: fullHtml,
      inReplyTo: formData.inReplyTo || undefined,
      references: formData.references || undefined,
      attachments: emailAttachments.length > 0 ? emailAttachments : undefined,
    };

    return { displayName, fromAddress, sendAsEmail, accountForSend, sentMailbox, sentFolderPath, outgoingPayload };
  };

  const handleSend = async (e) => {
    e.preventDefault();

    if (!formData.to.trim()) {
      setError(t('compose.pleaseEnterLeastOneRecipient'));
      return;
    }

    if (!selectedAccount) {
      setError(t('compose.noAccountSelected'));
      return;
    }

    setSending(true);
    setError(null);

    try {
      // Capture compose state for undo
      const composeState = {
        mode,
        replyTo: actionReplyTo,
        initialData: composeSnapshot(),
      };

      // The ONE staged identity of this outbox item: the vault uid the copy is
      // written under, and the bytes (with their Message-ID) that go on the
      // wire. Allocated on the first attempt and reused by every retry —
      // `retryOutbox` re-runs this exact closure, Rust mints a fresh Message-ID
      // on every `smtp_build_mime`, and the uid is a fresh clock read, so
      // rebuilding per attempt left the previous attempt's .eml and index entry
      // orphaned in the vault and put two copies of one message on the wire
      // that no recipient can pair up.
      let staged = null;

      // The actual send function
      const sendFn = async () => {
        // Refresh OAuth2 token if needed before sending
        const freshAccount = await ensureFreshToken(selectedAccount);
        if (!freshAccount) throw new Error('Could not refresh account credentials');

        const { displayName, fromAddress, sendAsEmail, accountForSend, sentMailbox, sentFolderPath, outgoingPayload } =
          await buildOutgoingPayload(freshAccount);

        // Quote/angle-aware: '"Doe, John" <j@d.com>' is ONE recipient.
        const parseAddresses = (raw) => splitRecipients(raw).map(s => ({ address: s, name: '' }));

        const pseudoUid = staged ? staged.uid : Math.floor(Date.now() / 1000);
        // Local archive target: must be a non-empty string — Maildir dirs use
        // it as the mailbox folder name. Default to literal 'Sent' so the
        // .eml lands under <data>/Maildir/<account>/Sent/cur/.
        const localMailbox = sentFolderPath || 'Sent';
        const invoke = window.__TAURI__?.core?.invoke;

        // ── STAGE 1: archive raw MIME locally as DRAFT ──
        // Build the RFC2822 bytes via Rust so we can store them BEFORE SMTP.
        // Failure here is fatal — the whole point is to have a safety copy.
        let builtMime = staged?.mime;
        if (!builtMime) {
          try {
            builtMime = await api.buildOutgoingMime(
              { ...accountForSend, name: displayName, fromEmail: sendAsEmail || undefined },
              outgoingPayload
            );
          } catch (err) {
            console.error('[compose:build_mime_fail]', err);
            throw new Error('Failed to build outgoing MIME: ' + (err?.message || err));
          }
          console.log('[compose:build_mime_ok]', {
            account: freshAccount.email,
            bytes: builtMime?.rawSize,
            messageId: builtMime?.messageId,
          });
        }
        staged = { uid: pseudoUid, mime: builtMime };

        if (invoke && builtMime?.rawBase64) {
          try {
            await send('maildir_store', {
              accountId: freshAccount.id,
              mailbox: localMailbox,
              uid: pseudoUid,
              rawSourceBase64: builtMime.rawBase64,
              flags: ['draft', 'seen'],
            });
            console.log('[compose:stage_local]', {
              account: freshAccount.email,
              mailbox: localMailbox,
              uid: pseudoUid,
              bytes: builtMime.rawSize,
              messageId: builtMime.messageId,
            });
          } catch (err) {
            console.error('[compose:stage_local_fail]', err);
            throw new Error('Could not archive outgoing email locally: ' + (err?.message || err));
          }
        }

        const indexBase = {
          uid: pseudoUid,
          from: { address: fromAddress, name: displayName },
          to: parseAddresses(formData.to),
          subject: formData.subject,
          date: new Date().toISOString(),
          // Regular attachments only — an inline picture must not give the
          // Sent row a paperclip.
          has_attachments: attachments.length > 0,
          message_id: builtMime?.messageId || null,
          in_reply_to: formData.inReplyTo || null,
          // Array shape, like every other local-index producer.
          references: parseReferenceList(formData.references).length
            ? parseReferenceList(formData.references)
            : null,
          snippet: htmlToText(formData.body).slice(0, 200),
        };
        if (invoke) {
          try {
            await api.appendLocalIndex(freshAccount.id, localMailbox, [{
              ...indexBase,
              flags: ['draft', 'seen'],
              source: 'local_draft',
            }]);
            console.log('[compose:index_draft_ok]', { uid: pseudoUid, mailbox: localMailbox });
          } catch (err) {
            console.warn('[compose:index_draft_fail]', err);
          }
        }

        // ── STAGE 2: subscribe to Rust's server-APPEND completion, then
        // refresh the Sent headers so the real server UID replaces the
        // optimistic one (and Message-ID dedupe hides the synthetic copy).
        //
        // BEFORE the send, not after it. Rust spawns the Sent APPEND the
        // instant SMTP returns, and this subscription costs two IPC round
        // trips (the dynamic import, then `listen`) — so against a fast server
        // the event was emitted before anything was listening for it, and the
        // whole tail silently never ran: the local staged copy stayed in the
        // Maildir, the optimistic row was never replaced, and the Sent view was
        // never re-read from the server. A server on loopback is not exotic
        // (Proton Mail Bridge, and the e2e mock); the race was simply invisible
        // while nothing in the suite could complete a send.
        let unlistenAppend = null;
        // Registered before the send but ALLOWED TO ACT only after the local
        // side of the send is finished. The event can land while STAGE 4 is
        // still re-archiving the .eml and the Sent row has not been inserted
        // yet — a cleanup that ran then would delete a copy that is written
        // again a moment later, and leave the optimistic row it was supposed to
        // take out. Both halves of the race, one gate.
        let markLocalStageDone;
        const localStageDone = new Promise((resolve) => { markLocalStageDone = resolve; });
        try {
          const { listen } = await import('@tauri-apps/api/event');
          let handled = false;
          const unlisten = await listen('send-server-append-complete', async (event) => {
            const p = event.payload || {};
            // Rust emits `account.email` as accountId (ImapConfig has no `id` field).
            if (p.accountId !== freshAccount.email && p.accountId !== freshAccount.id) {
              console.log('[compose:server_append_event_skip]', {
                eventAccountId: p.accountId,
                expectEmail: freshAccount.email,
                expectId: freshAccount.id,
              });
              return;
            }
            if (handled) return;
            handled = true;
            await localStageDone;
            console.log('[compose:server_append_event]', p);
            if (p.ok && p.verify) {
              console.log('[compose:server_append_verify]', {
                existsBefore: p.verify.existsBefore,
                existsAfter: p.verify.existsAfter,
                delta: p.verify.delta,
                foundUid: p.verify.foundUid,
                serverMessageIdHeader: p.messageIdHeader,
              });
              if (p.verify.delta <= 0) {
                console.error('[compose:server_append_no_delta] server reported no EXISTS change — APPEND was silently rejected or routed elsewhere');
              }
              if (!p.verify.foundUid && p.messageIdHeader) {
                console.warn('[compose:server_append_search_miss] UID SEARCH could not find Message-ID — server may not index it or stored in different folder');
              }
            }
            unlisten();

            // Server-side copy exists — remove the pre-SMTP local Maildir
            // staged entry so the UI doesn't show both (local pseudoUid and
            // server UID). Per Q2=c policy: local copy is a safety net while
            // the server round-trip is pending; once server confirms, the
            // server copy is canonical.
            if (p.ok && invoke) {
              try {
                await send('maildir_delete', {
                  accountId: freshAccount.id,
                  mailbox: localMailbox,
                  uid: pseudoUid,
                });
                await send('local_index_remove', {
                  accountId: freshAccount.id,
                  mailbox: localMailbox,
                  uid: pseudoUid,
                });
                console.log('[compose:local_cleanup_ok]', {
                  account: freshAccount.email,
                  mailbox: localMailbox,
                  uid: pseudoUid,
                });
              } catch (err) {
                console.warn('[compose:local_cleanup_fail]', err);
              }
              // Also drop the in-memory optimistic entry so the list view
              // rebuilds clean after loadSentHeaders re-populates from server.
              useMailStore.setState(s => ({
                sentEmails: (s.sentEmails || []).filter(
                  e => !(e.uid === pseudoUid && e._accountId === freshAccount.id)
                ),
                emails: (s.emails || []).filter(
                  e => !(e.uid === pseudoUid && e._accountId === freshAccount.id)
                ),
                localEmails: (s.localEmails || []).filter(
                  e => !(e.uid === pseudoUid && e._accountId === freshAccount.id)
                ),
              }));
            }

            const st = useMailStore.getState();
            console.log('[compose:refresh_start]', {
              account: freshAccount.email,
              mailbox: sentFolderPath,
              server_ok: p.ok,
            });
            try {
              await st.loadSentHeaders?.(freshAccount.id);
            } catch (err) {
              console.warn('[compose:refresh_loadSent_fail]', err);
            }
            if (
              sentFolderPath &&
              st.activeAccountId === freshAccount.id &&
              st.activeMailbox === sentFolderPath
            ) {
              try {
                await st.activateAccount?.(freshAccount.id, sentFolderPath, { _backgroundRefresh: true });
              } catch (err) {
                console.warn('[compose:refresh_activate_fail]', err);
              }
            }
            const finalSent = useMailStore.getState().sentEmails || [];
            const messageIdMatch = builtMime?.messageId
              ? finalSent.some(e => !e._optimistic && e.messageId === builtMime.messageId)
              : false;
            console.log('[compose:refresh_done]', {
              account: freshAccount.email,
              mailbox: sentFolderPath,
              sent_count: finalSent.length,
              messageId_matched_server: messageIdMatch,
            });
          });
          // Armed once the send is over — a 30s timer started HERE would expire
          // mid-send on a large attachment (the SMTP timeout scales to 600s).
          unlistenAppend = unlisten;
        } catch (err) {
          console.warn('[compose:event_listen_fail]', err);
          // Fallback to the original 8s reconcile.
          setTimeout(() => {
            const st = useMailStore.getState();
            st.loadSentHeaders?.(freshAccount.id);
          }, 8000);
        }

        // ── STAGE 3: SMTP send ──
        let sendResult;
        try {
          sendResult = await api.sendEmail(
            { ...accountForSend, name: displayName, fromEmail: sendAsEmail || undefined },
            outgoingPayload,
            sentMailbox
          );
          console.log('[compose:smtp_ok]', {
            account: freshAccount.email,
            smtpMessageId: sendResult?.messageId,
          });
          // Tell the server the original was answered / forwarded, the way
          // every other client on the account does. Fire-and-forget: the send
          // has already happened and a flag must never fail it.
          if (mode === 'reply' || mode === 'replyAll') markAnswered(actionReplyTo).catch(e => console.warn('[compose] \\Answered not set:', e));
          else if (mode === 'forward') markForwarded(actionReplyTo).catch(e => console.warn('[compose] $Forwarded not set:', e));

          // New composes default to the identity that actually sent last.
          useSettingsStore.getState().setLastComposeIdentity(freshAccount.id, fromAddress);
          // It left the building: the Drafts copy is not a draft any more.
          // Only after SMTP succeeded — a failed send keeps its draft, which is
          // what the outbox bubble restores from.
          // The refs outlive the unmounted window. Read AFTER the last
          // autosave settles, or a message sent seconds after it was typed
          // deletes a draft the save is still writing.
          await saveChainRef.current.catch(() => {});
          if (draftUidRef.current && draftMailboxRef.current) {
            await deleteLocalDraft({
              accountId: draftAccountRef.current || freshAccount.id,
              mailbox: draftMailboxRef.current,
              uid: draftUidRef.current,
            });
            draftUidRef.current = null;
          }
          // Safety: unsubscribe 30s after the send, even if the event never fires.
          setTimeout(() => { try { unlistenAppend?.(); } catch {} }, 30000);
        } catch (err) {
          console.error('[compose:smtp_fail]', err);
          // Nothing was sent, so no APPEND event is coming.
          try { unlistenAppend?.(); } catch {}
          markLocalStageDone();
          // Local draft survives — user can retry via outbox bubble.
          throw err;
        }

        // ── STAGE 4: re-archive locally as SENT ──
        // Overwrite the .eml file: flags transition D→A. maildir_store
        // removes the old file for this UID and writes the new one.
        if (invoke && builtMime?.rawBase64) {
          try {
            await send('maildir_store', {
              accountId: freshAccount.id,
              mailbox: localMailbox,
              uid: pseudoUid,
              rawSourceBase64: builtMime.rawBase64,
              flags: ['archived', 'seen'],
            });
            await api.appendLocalIndex(freshAccount.id, localMailbox, [{
              ...indexBase,
              flags: ['archived', 'seen'],
              source: 'local_sent',
            }]);
            console.log('[compose:mark_sent_local]', {
              account: freshAccount.email,
              mailbox: localMailbox,
              uid: pseudoUid,
            });
          } catch (err) {
            console.warn('[compose:mark_sent_local_fail]', err);
          }
        }

        // The Sent row, now that the message has actually left.
        //
        // It goes in HERE, after SMTP, not before it. Staged ahead of the send
        // it claimed a message was in your Sent folder while it was still on
        // the wire — and a send that failed left that claim standing for the
        // session: `_mergeOptimisticSent` keeps an optimistic entry the server
        // never returns, and no outbox path (retry, cancel, dismiss) removes
        // it. The safety net is the vault copy above, written BEFORE SMTP and
        // untouched by this; a failed send keeps that, its Drafts autosave and
        // the outbox bubble, and claims nothing.
        //
        // Built FROM `indexBase`, not beside it. Written out by hand it lost
        // the two fields threading runs on (`in_reply_to`, `references`), and
        // the row was then an orphan "Re: …": a second row in the list, and
        // nothing the open thread would take.
        const optimistic = {
          ...indexBase,
          cc: parseAddresses(formData.cc),
          bcc: parseAddresses(formData.bcc),
          internal_date: indexBase.date,
          internalDate: indexBase.date,
          messageId: indexBase.message_id,
          // Same headers, under the names buildThreads and the reader read.
          inReplyTo: indexBase.in_reply_to,
          hasAttachments: indexBase.has_attachments,
          read: true,
          flags: ['\\Seen'],
          _accountId: freshAccount.id,
          _optimistic: true,
          _localStaged: true,
        };
        useMailStore.setState(s => {
          const dedupById = (list) => (optimistic.messageId
            ? (list || []).filter(e => e.messageId !== optimistic.messageId)
            : (list || []));
          const updates = { sentEmails: [optimistic, ...dedupById(s.sentEmails)] };
          if (
            sentFolderPath &&
            s.activeAccountId === freshAccount.id &&
            s.activeMailbox === sentFolderPath
          ) {
            updates.emails = [optimistic, ...dedupById(s.emails)];
            updates.totalEmails = (s.totalEmails || 0) + 1;
          }
          return updates;
        });
        useMailStore.getState().updateSortedEmails?.();
        console.log('[compose:sent_row_insert]', {
          account: freshAccount.email,
          uid: pseudoUid,
          messageId: builtMime?.messageId,
        });
        // The local side is complete — the APPEND handler may run now.
        markLocalStageDone();

      };

      // Queue send (may delay if undo send is enabled)
      useMailStore.getState().queueSend(composeState, sendFn, composeDelay);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to send email');
    } finally {
      setSending(false);
    }
  };

  // Schedule instead of sending now: same payload-building path as a normal
  // send (buildOutgoingPayload above), minus the local Sent-folder staging
  // and optimistic-row machinery — scheduling never touches Sent, the daemon
  // does that when it actually fires. `scheduled.create` freezes the MIME
  // itself, so there is no undo-send delay to queue through.
  const handleSchedule = async () => {
    if (!formData.to.trim()) { setError(t('compose.pleaseEnterLeastOneRecipient')); return; }
    if (!selectedAccount) { setError(t('compose.noAccountSelected')); return; }
    // Refused HERE ONLY — never in what the daemon fires, where "already
    // past" is the normal catch-up case and must send.
    if (!scheduleDraft.localTime || isPastLocalTime(scheduleDraft.localTime, scheduleDraft.tz)) return;

    setSending(true);
    setError(null);
    try {
      const freshAccount = await ensureFreshToken(selectedAccount);
      if (!freshAccount) throw new Error('Could not refresh account credentials');

      const { displayName, sendAsEmail, accountForSend, sentMailbox, outgoingPayload } =
        await buildOutgoingPayload(freshAccount);

      await useScheduledStore.getState().create({
        accountId: freshAccount.id,
        account: { ...accountForSend, name: displayName, fromEmail: sendAsEmail || undefined },
        email: outgoingPayload,
        localTime: scheduleDraft.localTime,
        tz: scheduleDraft.tz,
        fireAt: zonedTimeToEpoch(scheduleDraft.localTime, scheduleDraft.tz),
        sentMailbox,
      });

      // No longer a live draft — same cleanup as a real send's success path,
      // so the outbox/Drafts bubble does not also claim this message.
      await saveChainRef.current.catch(() => {});
      if (draftUidRef.current && draftMailboxRef.current) {
        await deleteLocalDraft({
          accountId: draftAccountRef.current || freshAccount.id,
          mailbox: draftMailboxRef.current,
          uid: draftUidRef.current,
        });
        draftUidRef.current = null;
      }

      setShowSchedulePicker(false);
      onClose();
    } catch (err) {
      setError(err.message || t('scheduled.errors.scheduleFailed'));
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
      _fromAddress: pickedFrom,
      _baseline: initialSnapshot.current,
      _draftUid: draftUidRef.current,
      _draftMailbox: draftMailboxRef.current,
    };
  }, [formData, attachments, quotedHtml, contextHtml, showContext, replyTo, initialData, selectedAccountId, pickedFrom, hasUserContent]);

  const latestSnapshotRef = useRef(composeSnapshot);
  latestSnapshotRef.current = composeSnapshot;
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
    attachments, quotedHtml, contextHtml, showContext, selectedAccountId, pickedFrom,
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
  }, [selectedAccountId]);

  /** Close for good: the vault copy goes with the window. */
  const closeDiscarding = useCallback(() => {
    discardDraft();
    onClose();
  }, [discardDraft, onClose]);

  const [showDiscardDialog, setShowDiscardDialog] = useState(false);

  const confirmClose = () => {
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
  }, [showDiscardDialog, hasUserContent, onClose, onMinimize]);

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
  const handleMinimize = () => {
    if (onSaveState) {
      publishSnapshot();
    }
    if (onMinimize) onMinimize();
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target !== e.currentTarget || !pressedOnBackdrop.current) return;
        handleBackdropClick();
      }}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        data-testid="compose-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-dragging={dragging ? 'true' : 'false'}
        className={`compose-window bg-mail-surface border rounded-2xl
                   w-full max-w-4xl max-h-[90vh] h-[min(80vh,700px)] min-h-[320px] flex flex-col overflow-hidden
                   ${dragging ? 'border-mail-accent border-2' : 'border-mail-border'}`}
        onClick={(e) => e.stopPropagation()}
        onDragEnter={(e) => { if (!hasFiles(e)) return; dragDepth.current += 1; setDragging(true); }}
        onDragOver={(e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false); }}
        // Capture phase: the editor's handleDrop stops propagation in the bubble
        // phase, so a bubble-phase reset would never run for editor drops.
        // The reset itself waits for the next task. A browser-dispatched event
        // gets a microtask checkpoint after every listener, so a synchronous
        // setState here would be committed — and the attach strip unmounted —
        // before the strip's own onDrop is dispatched; React then drops an
        // event whose target is no longer mounted, and the file never arrives.
        onDropCapture={() => { dragDepth.current = 0; setTimeout(() => setDragging(false), 0); }}
        onDrop={handleDrop}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
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

          {/* The full source remains reading context. The selected excerpt is
              only the outgoing quote and never changes this panel. */}
          {contextHtml && (
            <div className={`border-t border-mail-border lg:border-t-0 ${showContext ? 'lg:border-l lg:w-80 lg:shrink-0 lg:overflow-y-auto' : ''}`}>
              <button
                type="button"
                data-testid="compose-context-toggle"
                aria-pressed={showContext}
                aria-expanded={showContext}
                onClick={() => {
                  const next = !showContext;
                  setShowContext(next);
                  setComposeContextVisible?.(next);
                }}
                className="w-full flex items-center gap-2 px-4 py-2 text-xs text-mail-text-muted
                          hover:bg-mail-surface-hover transition-colors"
              >
                <ChevronRight
                  size={14}
                  className={`transition-transform ${showContext ? 'rotate-90' : ''}`}
                />
                <span>{t('compose.showHideOriginalMessage', { action: showContext ? t('settings.backup.verify.hide') : t('compose.show') })}</span>
              </button>
              {showContext && (
                <div data-testid="compose-context-panel" className="px-4 pb-3 max-h-[35vh] overflow-y-auto lg:max-h-none">
                  <div data-testid="compose-quoted" className="pt-2">
                    <QuotedOriginal html={contextHtml} />
                  </div>
                </div>
              )}
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
                  onClick={() => setShowSchedulePicker(v => !v)}
                  className="flex items-center justify-center px-2 py-2 bg-mail-accent-fill
                            hover:bg-mail-accent-hover disabled:opacity-50
                            text-white rounded-lg transition-all"
                >
                  <ChevronRight size={16} className={showSchedulePicker ? '-rotate-90 transition-transform' : 'rotate-90 transition-transform'} />
                </button>
                {showSchedulePicker && (
                  <div className="absolute bottom-full right-0 mb-1 w-80 bg-mail-surface border border-mail-border
                                  rounded-lg z-50 p-3 space-y-2">
                    <div className="text-sm font-medium text-mail-text">{t('scheduled.compose.pickerTitle')}</div>
                    <SchedulePicker
                      localTime={scheduleDraft.localTime}
                      tz={scheduleDraft.tz}
                      onChange={setScheduleDraft}
                      testIdPrefix="compose-schedule"
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
                  </div>
                )}
              </div>
            </div>
          </div>
        </form>
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
