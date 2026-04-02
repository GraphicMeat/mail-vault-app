import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send, Paperclip, Loader, Minimize2, FileText, Trash2, ChevronDown, BookTemplate, ChevronRight } from 'lucide-react';
import * as api from '../services/api';
import { ensureFreshToken } from '../services/authUtils';
import { RichTextEditor, textToHtml, htmlToText } from './RichTextEditor';

function AttachmentPreview({ attachment, onRemove }) {
  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };
  
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-mail-surface-hover rounded-lg">
      <FileText size={16} className="text-mail-accent" />
      <span className="text-sm text-mail-text truncate flex-1">{attachment.filename}</span>
      <span className="text-xs text-mail-text-muted">{formatSize(attachment.size)}</span>
      <button
        onClick={onRemove}
        className="p-1 hover:bg-mail-border rounded transition-colors"
      >
        <X size={14} className="text-mail-text-muted" />
      </button>
    </div>
  );
}

export function ComposeModal({ mode = 'new', replyTo = null, initialData = null, onClose, onMinimize, onSaveState }) {
  const rawAccounts = useMailStore(s => s.accounts);
  const activeAccountId = useMailStore(s => s.activeAccountId);
  const getSignature = useSettingsStore(s => s.getSignature);
  const getDisplayName = useSettingsStore(s => s.getDisplayName);
  const emailTemplates = useSettingsStore(s => s.emailTemplates);
  const addEmailTemplate = useSettingsStore(s => s.addEmailTemplate);
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const accounts = getOrderedAccounts(rawAccounts);
  // In unified inbox, prefer the email's source account for replies
  const initialAccountId = replyTo?._accountId || activeAccountId;
  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId);
  const selectedAccount = accounts.find(a => a.id === selectedAccountId) || accounts[0];

  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [quotedExpanded, setQuotedExpanded] = useState(false);
  const [quotedHtml, setQuotedHtml] = useState('');
  const fileInputRef = useRef(null);
  const editorRef = useRef(null);
  const templatesRef = useRef(null);
  const plainTextRef = useRef('');

  const [formData, setFormData] = useState({
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    body: '',      // HTML content from the editor
    inReplyTo: '',
    references: ''
  });
  
  // Initialize form based on mode and replyTo email
  useEffect(() => {
    let signatureHtml = '';

    // Add signature if enabled
    const signature = getSignature(selectedAccountId);
    if (signature.enabled && signature.text) {
      signatureHtml = '<p></p><p>--</p>' + textToHtml(signature.text);
    }

    if (!replyTo) {
      if (initialData) {
        // Restore from undo-send or minimize: body is already HTML
        const bodyHtml = initialData.body || '';
        setFormData(prev => ({
          ...prev,
          to: initialData.to || '',
          cc: initialData.cc || '',
          bcc: initialData.bcc || '',
          subject: initialData.subject || '',
          body: bodyHtml || signatureHtml,
          inReplyTo: initialData.inReplyTo || '',
          references: initialData.references || '',
        }));
        if (initialData.attachments?.length) {
          setAttachments(initialData.attachments);
        }
        // Restore quoted content from minimized state
        if (initialData._quotedHtml) {
          setQuotedHtml(initialData._quotedHtml);
        }
      } else {
        setFormData(prev => ({ ...prev, body: signatureHtml }));
      }
      return;
    }

    const fromAddress = replyTo.from?.address || '';
    const fromName = replyTo.from?.name || '';
    const originalSubject = replyTo.subject || '';
    const originalDate = replyTo.date ? new Date(replyTo.date).toLocaleString() : '';
    const originalTo = replyTo.to?.map(t => t.address).join(', ') || '';

    // Build quoted content as HTML — stored separately for collapsible display
    const quotedHeaderHtml = `<p><strong>Original Message</strong><br>From: ${fromName} &lt;${fromAddress}&gt;<br>Date: ${originalDate}<br>Subject: ${originalSubject}<br>To: ${originalTo}</p>`;
    const quotedBodyHtml = replyTo.html
      ? replyTo.html
      : textToHtml(replyTo.text || '');

    setQuotedHtml(quotedHeaderHtml + quotedBodyHtml);

    const replyBody = signatureHtml;

    if (mode === 'reply') {
      setFormData({
        to: replyTo.replyTo?.[0]?.address || fromAddress,
        cc: '',
        bcc: '',
        subject: originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`,
        body: replyBody,
        inReplyTo: replyTo.messageId || '',
        references: replyTo.messageId || ''
      });
    } else if (mode === 'replyAll') {
      const allRecipients = [
        replyTo.replyTo?.[0]?.address || fromAddress,
        ...(replyTo.to?.map(t => t.address) || []),
      ].filter(addr => addr !== selectedAccount?.email);

      const ccRecipients = (replyTo.cc?.map(c => c.address) || [])
        .filter(addr => addr !== selectedAccount?.email);

      setFormData({
        to: allRecipients.join(', '),
        cc: ccRecipients.join(', '),
        bcc: '',
        subject: originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`,
        body: replyBody,
        inReplyTo: replyTo.messageId || '',
        references: replyTo.messageId || ''
      });
    } else if (mode === 'forward') {
      setFormData({
        to: '',
        cc: '',
        bcc: '',
        subject: originalSubject.startsWith('Fwd:') ? originalSubject : `Fwd: ${originalSubject}`,
        body: signatureHtml + quotedHeaderHtml + quotedBodyHtml,
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
  }, [mode, replyTo, initialData, selectedAccountId]);
  
  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    setError(null);
  };
  
  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files || []);
    
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
    
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };
  
  const removeAttachment = (index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };
  
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
        setShowTemplates(false);
        setSavingTemplate(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showTemplates]);

  const insertTemplate = (template) => {
    const editor = editorRef.current;
    if (editor) {
      // Insert template content as HTML at cursor position
      const templateHtml = textToHtml(template.body);
      editor.chain().focus().insertContent(templateHtml).run();
    } else {
      // Fallback: append to body
      setFormData(prev => ({ ...prev, body: prev.body + textToHtml(template.body) }));
    }
    setShowTemplates(false);
  };

  const handleSaveTemplate = () => {
    const name = templateName.trim();
    if (!name) return;
    addEmailTemplate(name, plainTextRef.current || htmlToText(formData.body));
    setTemplateName('');
    setSavingTemplate(false);
    setShowTemplates(false);
  };

  const handleSend = async (e) => {
    e.preventDefault();

    if (!formData.to.trim()) {
      setError('Please enter at least one recipient');
      return;
    }

    if (!selectedAccount) {
      setError('No account selected');
      return;
    }

    setSending(true);
    setError(null);

    try {
      // Capture compose state for undo
      const composeState = {
        mode,
        replyTo,
        initialData: {
          to: formData.to,
          cc: formData.cc,
          bcc: formData.bcc,
          subject: formData.subject,
          body: formData.body,
          inReplyTo: formData.inReplyTo,
          references: formData.references,
          attachments: [...attachments],
        },
      };

      // The actual send function
      const sendFn = async () => {
        // Refresh OAuth2 token if needed before sending
        const freshAccount = await ensureFreshToken(selectedAccount);

        // Get display name from settings or account
        const displayName = getDisplayName(selectedAccountId) || freshAccount.name || freshAccount.email;

        // Prepare attachments for nodemailer
        const emailAttachments = attachments.map(att => ({
          filename: att.filename,
          content: att.content,
          encoding: 'base64',
          contentType: att.contentType
        }));

        // Combine compose body with quoted content for the sent email
        const fullHtml = quotedHtml
          ? formData.body + '<hr><blockquote>' + quotedHtml + '</blockquote>'
          : formData.body;
        const fullText = quotedHtml
          ? (plainTextRef.current || htmlToText(formData.body)) + '\n\n-------- Original Message --------\n' + htmlToText(quotedHtml)
          : (plainTextRef.current || htmlToText(formData.body));

        await api.sendEmail(
          { ...freshAccount, name: displayName },
          {
            to: formData.to,
            cc: formData.cc || undefined,
            bcc: formData.bcc || undefined,
            subject: formData.subject,
            text: fullText,
            html: fullHtml,
            inReplyTo: formData.inReplyTo || undefined,
            references: formData.references || undefined,
            attachments: emailAttachments.length > 0 ? emailAttachments : undefined
          }
        );
      };

      // Queue send (may delay if undo send is enabled)
      useMailStore.getState().queueSend(composeState, sendFn);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to send email');
    } finally {
      setSending(false);
    }
  };
  
  // Track the initial form state to detect user edits
  const initialSnapshot = useRef(null);
  useEffect(() => {
    // Capture the form right after initialization (next tick)
    const timer = setTimeout(() => {
      initialSnapshot.current = {
        to: formData.to,
        subject: formData.subject,
        body: formData.body,
      };
    }, 0);
    return () => clearTimeout(timer);
  }, [mode, replyTo, initialData, selectedAccountId]);

  const hasUserContent = initialSnapshot.current
    ? (formData.to !== initialSnapshot.current.to ||
       formData.subject !== initialSnapshot.current.subject ||
       htmlToText(formData.body).trim() !== htmlToText(initialSnapshot.current.body).trim() ||
       attachments.some(a => !a.isFromOriginal))
    : false;

  const [showDiscardDialog, setShowDiscardDialog] = useState(false);

  const confirmClose = () => {
    if (hasUserContent) {
      setShowDiscardDialog(true);
      return;
    }
    onClose();
  };

  // Backdrop click: minimize if has content, close if empty
  const handleBackdropClick = () => {
    if (hasUserContent && onMinimize) {
      handleMinimize();
    } else {
      onClose();
    }
  };

  const getTitle = () => {
    switch (mode) {
      case 'reply': return 'Reply';
      case 'replyAll': return 'Reply All';
      case 'forward': return 'Forward';
      default: return 'New Message';
    }
  };

  // Save editor state before minimizing so it persists across unmount/remount
  const handleMinimize = () => {
    if (onSaveState) {
      onSaveState({
        to: formData.to,
        cc: formData.cc,
        bcc: formData.bcc,
        subject: formData.subject,
        body: formData.body,
        inReplyTo: formData.inReplyTo,
        references: formData.references,
        attachments: [...attachments],
        _quotedHtml: quotedHtml,
      });
    }
    if (onMinimize) onMinimize();
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={handleBackdropClick}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        data-testid="compose-modal"
        className="bg-mail-surface border border-mail-border rounded-xl shadow-2xl
                   w-full max-w-4xl max-h-[90vh] h-[min(80vh,700px)] min-h-[320px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
          <h2 className="font-semibold text-mail-text">{getTitle()}</h2>
          <div className="flex items-center gap-1">
            {onMinimize && (
              <button
                onClick={handleMinimize}
                title="Minimize"
                className="p-1.5 hover:bg-mail-border rounded transition-colors"
              >
                <Minimize2 size={16} className="text-mail-text-muted" />
              </button>
            )}
            <button
              onClick={confirmClose}
              className="p-1.5 hover:bg-mail-border rounded transition-colors"
            >
              <X size={16} className="text-mail-text-muted" />
            </button>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSend} className="flex-1 flex flex-col overflow-hidden">
          <div className="px-4 py-2 space-y-2 border-b border-mail-border">
            {/* From */}
            {accounts.length > 1 && (
              <div className="flex items-center gap-2">
                <label className="w-12 text-sm text-mail-text-muted">From:</label>
                <div className="relative flex-1">
                  <select
                    value={selectedAccountId}
                    onChange={(e) => setSelectedAccountId(e.target.value)}
                    className="w-full bg-transparent text-mail-text text-sm py-1 pr-6
                              outline-none appearance-none cursor-pointer"
                  >
                    {accounts.map(acc => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name ? `${acc.name} <${acc.email}>` : acc.email}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} className="absolute right-0 top-1/2 -translate-y-1/2
                                                     text-mail-text-muted pointer-events-none" />
                </div>
              </div>
            )}

            {/* To */}
            <div className="flex items-center gap-2">
              <label className="w-12 text-sm text-mail-text-muted">To:</label>
              <input
                type="text"
                name="to"
                data-testid="compose-to"
                value={formData.to}
                onChange={handleChange}
                placeholder="recipient@example.com"
                className="flex-1 bg-transparent text-mail-text placeholder-mail-text-muted
                          outline-none text-sm py-1"
              />
            </div>
            
            {/* CC */}
            <div className="flex items-center gap-2">
              <label className="w-12 text-sm text-mail-text-muted">Cc:</label>
              <input
                type="text"
                name="cc"
                value={formData.cc}
                onChange={handleChange}
                placeholder="cc@example.com"
                className="flex-1 bg-transparent text-mail-text placeholder-mail-text-muted
                          outline-none text-sm py-1"
              />
            </div>
            
            {/* BCC */}
            <div className="flex items-center gap-2">
              <label className="w-12 text-sm text-mail-text-muted">Bcc:</label>
              <input
                type="text"
                name="bcc"
                value={formData.bcc}
                onChange={handleChange}
                placeholder="bcc@example.com"
                className="flex-1 bg-transparent text-mail-text placeholder-mail-text-muted
                          outline-none text-sm py-1"
              />
            </div>
            
            {/* Subject */}
            <div className="flex items-center gap-2">
              <label className="w-12 text-sm text-mail-text-muted">Subject:</label>
              <input
                type="text"
                name="subject"
                data-testid="compose-subject"
                value={formData.subject}
                onChange={handleChange}
                placeholder="Subject"
                className="flex-1 bg-transparent text-mail-text placeholder-mail-text-muted
                          outline-none text-sm py-1"
              />
            </div>
          </div>
          
          {/* Attachments */}
          {attachments.length > 0 && (
            <div className="px-4 py-2 border-b border-mail-border">
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
          
          {/* Body — Rich Text Editor */}
          <div className="flex-1 overflow-hidden flex flex-col" data-testid="compose-body">
            <RichTextEditor
              content={formData.body}
              editorRef={editorRef}
              onUpdate={(html, text) => {
                setFormData(prev => ({ ...prev, body: html }));
                plainTextRef.current = text;
                setError(null);
              }}
              placeholder="Write your message..."
            />
          </div>
          
          {/* Collapsible quoted original message */}
          {quotedHtml && (
            <div className="border-t border-mail-border">
              <button
                type="button"
                onClick={() => setQuotedExpanded(prev => !prev)}
                className="w-full flex items-center gap-2 px-4 py-2 text-xs text-mail-text-muted
                          hover:bg-mail-surface-hover transition-colors"
              >
                <ChevronRight
                  size={14}
                  className={`transition-transform ${quotedExpanded ? 'rotate-90' : ''}`}
                />
                <span>{quotedExpanded ? 'Hide' : 'Show'} original message</span>
              </button>
              {quotedExpanded && (
                <div className="px-4 pb-3 max-h-[300px] overflow-y-auto">
                  <div
                    className="text-xs text-mail-text-muted border-l-2 border-mail-border pl-3
                              [&_p]:my-1 [&_a]:text-mail-accent [&_img]:max-w-full"
                    dangerouslySetInnerHTML={{ __html: quotedHtml }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="px-4 py-2 bg-mail-danger/10 border-t border-mail-danger/20 
                           text-mail-danger text-sm">
              {error}
            </div>
          )}
          
          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-mail-border">
            <div className="flex items-center gap-2">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileSelect}
                multiple
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="p-2 hover:bg-mail-border rounded-lg transition-colors"
                title="Attach files"
              >
                <Paperclip size={18} className="text-mail-text-muted" />
              </button>
              <div className="relative" ref={templatesRef}>
                <button
                  type="button"
                  data-testid="compose-templates-btn"
                  onClick={() => { setShowTemplates(v => !v); setSavingTemplate(false); }}
                  className="p-2 hover:bg-mail-border rounded-lg transition-colors"
                  title="Templates"
                >
                  <BookTemplate size={18} className="text-mail-text-muted" />
                </button>
                {showTemplates && (
                  <div className="absolute bottom-full left-0 mb-1 w-64 bg-mail-surface border border-mail-border
                                  rounded-lg shadow-xl z-50 overflow-hidden">
                    {emailTemplates.length > 0 && (
                      <div className="max-h-48 overflow-y-auto">
                        {emailTemplates.map(t => (
                          <button
                            key={t.id}
                            type="button"
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
                      <div className="px-3 py-2 text-xs text-mail-text-muted">
                        No templates yet
                      </div>
                    )}
                    <div className="border-t border-mail-border">
                      {savingTemplate ? (
                        <div className="flex items-center gap-1 p-2">
                          <input
                            type="text"
                            value={templateName}
                            onChange={(e) => setTemplateName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveTemplate(); } }}
                            placeholder="Template name..."
                            autoFocus
                            className="flex-1 bg-transparent text-sm text-mail-text placeholder-mail-text-muted
                                      outline-none border border-mail-border rounded px-2 py-1"
                          />
                          <button
                            type="button"
                            onClick={handleSaveTemplate}
                            disabled={!templateName.trim()}
                            className="px-2 py-1 text-xs bg-mail-accent text-white rounded
                                      hover:bg-mail-accent-hover disabled:opacity-50 transition-colors"
                          >
                            Save
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setSavingTemplate(true)}
                          className="w-full text-left px-3 py-2 text-sm text-mail-accent
                                    hover:bg-mail-surface-hover transition-colors"
                        >
                          Save as Template
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
                Discard
              </button>
              <button
                type="submit"
                data-testid="compose-send"
                disabled={sending}
                className="flex items-center gap-2 px-4 py-2 bg-mail-accent
                          hover:bg-mail-accent-hover disabled:opacity-50
                          text-white font-medium rounded-lg transition-all text-sm"
              >
                {sending ? (
                  <>
                    <Loader size={16} className="animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send size={16} />
                    Send
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </motion.div>

      {/* Styled discard confirmation dialog */}
      <AnimatePresence>
        {showDiscardDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]"
            onClick={() => setShowDiscardDialog(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-mail-surface border border-mail-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-base font-semibold text-mail-text mb-2">Discard message?</h3>
              <p className="text-sm text-mail-text-muted mb-5">
                You have unsaved changes. This message will be permanently discarded.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowDiscardDialog(false)}
                  className="px-4 py-2 text-sm text-mail-text hover:bg-mail-surface-hover
                            rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { setShowDiscardDialog(false); onClose(); }}
                  className="px-4 py-2 text-sm bg-red-500/90 hover:bg-red-500 text-white
                            rounded-lg transition-colors font-medium"
                >
                  Discard
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
