import React, { useState, useEffect, useRef } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { motion } from 'framer-motion';
import { X, Send, Paperclip, Loader, Minimize2, Maximize2, FileText, Trash2 } from 'lucide-react';
import * as api from '../services/api';

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

export function ComposeModal({ mode = 'new', replyTo = null, onClose }) {
  const { accounts, activeAccountId } = useMailStore();
  const { getSignature, getDisplayName } = useSettingsStore();
  const activeAccount = accounts.find(a => a.id === activeAccountId);
  
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [minimized, setMinimized] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);
  
  const [formData, setFormData] = useState({
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    body: '',
    inReplyTo: '',
    references: ''
  });
  
  // Initialize form based on mode and replyTo email
  useEffect(() => {
    let initialBody = '';
    
    // Add signature if enabled
    const signature = getSignature(activeAccountId);
    if (signature.enabled && signature.text) {
      initialBody = `\n\n--\n${signature.text}`;
    }
    
    if (!replyTo) {
      setFormData(prev => ({ ...prev, body: initialBody }));
      return;
    }
    
    const fromAddress = replyTo.from?.address || '';
    const fromName = replyTo.from?.name || '';
    const originalSubject = replyTo.subject || '';
    const originalDate = replyTo.date ? new Date(replyTo.date).toLocaleString() : '';
    const originalTo = replyTo.to?.map(t => t.address).join(', ') || '';
    
    // Build quoted content
    const quotedHeader = `\n\n-------- Original Message --------\nFrom: ${fromName} <${fromAddress}>\nDate: ${originalDate}\nSubject: ${originalSubject}\nTo: ${originalTo}\n\n`;
    const quotedBody = replyTo.text || '';
    
    if (mode === 'reply') {
      setFormData({
        to: replyTo.replyTo?.[0]?.address || fromAddress,
        cc: '',
        bcc: '',
        subject: originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`,
        body: initialBody + quotedHeader + quotedBody,
        inReplyTo: replyTo.messageId || '',
        references: replyTo.messageId || ''
      });
    } else if (mode === 'replyAll') {
      // Reply to sender + all recipients except self
      const allRecipients = [
        replyTo.replyTo?.[0]?.address || fromAddress,
        ...(replyTo.to?.map(t => t.address) || []),
      ].filter(addr => addr !== activeAccount?.email);
      
      const ccRecipients = (replyTo.cc?.map(c => c.address) || [])
        .filter(addr => addr !== activeAccount?.email);
      
      setFormData({
        to: allRecipients.join(', '),
        cc: ccRecipients.join(', '),
        bcc: '',
        subject: originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`,
        body: initialBody + quotedHeader + quotedBody,
        inReplyTo: replyTo.messageId || '',
        references: replyTo.messageId || ''
      });
    } else if (mode === 'forward') {
      setFormData({
        to: '',
        cc: '',
        bcc: '',
        subject: originalSubject.startsWith('Fwd:') ? originalSubject : `Fwd: ${originalSubject}`,
        body: initialBody + quotedHeader + quotedBody,
        inReplyTo: '',
        references: ''
      });
      
      // Include original attachments for forwarding
      if (replyTo.attachments?.length > 0) {
        setAttachments(replyTo.attachments.map(att => ({
          filename: att.filename,
          contentType: att.contentType,
          size: att.size,
          content: att.content, // base64 content
          isFromOriginal: true
        })));
      }
    }
  }, [mode, replyTo, activeAccount, activeAccountId]);
  
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
  
  const handleSend = async (e) => {
    e.preventDefault();
    
    if (!formData.to.trim()) {
      setError('Please enter at least one recipient');
      return;
    }
    
    if (!activeAccount) {
      setError('No active account');
      return;
    }
    
    setSending(true);
    setError(null);
    
    try {
      // Get display name from settings or account
      const displayName = getDisplayName(activeAccountId) || activeAccount.name || activeAccount.email;
      
      // Prepare attachments for nodemailer
      const emailAttachments = attachments.map(att => ({
        filename: att.filename,
        content: att.content,
        encoding: 'base64',
        contentType: att.contentType
      }));
      
      await api.sendEmail(
        { ...activeAccount, name: displayName },
        {
          to: formData.to,
          cc: formData.cc || undefined,
          bcc: formData.bcc || undefined,
          subject: formData.subject,
          text: formData.body,
          html: formData.body.replace(/\n/g, '<br>'),
          inReplyTo: formData.inReplyTo || undefined,
          references: formData.references || undefined,
          attachments: emailAttachments.length > 0 ? emailAttachments : undefined
        }
      );
      
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to send email');
    } finally {
      setSending(false);
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
  
  if (minimized) {
    return (
      <motion.div
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="fixed bottom-0 right-4 bg-mail-surface border border-mail-border 
                   rounded-t-lg shadow-lg z-50 w-72"
      >
        <div 
          className="flex items-center justify-between px-4 py-3 cursor-pointer
                     hover:bg-mail-surface-hover transition-colors"
          onClick={() => setMinimized(false)}
        >
          <span className="font-medium text-mail-text truncate">
            {formData.subject || getTitle()}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); setMinimized(false); }}
              className="p-1 hover:bg-mail-border rounded"
            >
              <Maximize2 size={14} className="text-mail-text-muted" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="p-1 hover:bg-mail-border rounded"
            >
              <X size={14} className="text-mail-text-muted" />
            </button>
          </div>
        </div>
      </motion.div>
    );
  }
  
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="bg-mail-surface border border-mail-border rounded-xl shadow-2xl 
                   w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
          <h2 className="font-semibold text-mail-text">{getTitle()}</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMinimized(true)}
              className="p-1.5 hover:bg-mail-border rounded transition-colors"
            >
              <Minimize2 size={16} className="text-mail-text-muted" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-mail-border rounded transition-colors"
            >
              <X size={16} className="text-mail-text-muted" />
            </button>
          </div>
        </div>
        
        {/* Form */}
        <form onSubmit={handleSend} className="flex-1 flex flex-col overflow-hidden">
          <div className="px-4 py-2 space-y-2 border-b border-mail-border">
            {/* To */}
            <div className="flex items-center gap-2">
              <label className="w-12 text-sm text-mail-text-muted">To:</label>
              <input
                type="text"
                name="to"
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
          
          {/* Body */}
          <div className="flex-1 overflow-hidden">
            <textarea
              name="body"
              value={formData.body}
              onChange={handleChange}
              placeholder="Write your message..."
              className="w-full h-full p-4 bg-transparent text-mail-text 
                        placeholder-mail-text-muted outline-none resize-none
                        text-sm leading-relaxed min-h-[300px]"
            />
          </div>
          
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
            </div>
            
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-mail-text-muted hover:text-mail-text
                          transition-colors text-sm"
              >
                Discard
              </button>
              <button
                type="submit"
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
    </motion.div>
  );
}
