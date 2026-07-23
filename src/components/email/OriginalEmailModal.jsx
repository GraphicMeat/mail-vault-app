import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Paperclip, X, Download } from 'lucide-react';
import { formatDateTime } from '../../utils/dateFormat';

// Modal for viewing full original email
export function OriginalEmailModal({ email, onClose }) {
  if (!email) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          className="bg-mail-surface border border-mail-border rounded-xl shadow-xl
                    max-w-2xl w-full max-h-[80vh] overflow-hidden"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
            <h3 className="font-semibold text-mail-text">Original Email</h3>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-mail-border rounded-lg transition-colors"
            >
              <X size={18} className="text-mail-text-muted" />
            </button>
          </div>

          {/* Email Details */}
          <div className="p-4 border-b border-mail-border space-y-2 text-sm">
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16">From:</span>
              <span className="text-mail-text">
                {email.from?.name} &lt;{email.from?.address}&gt;
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16">To:</span>
              <span className="text-mail-text">
                {email.to?.map(t => `${t.name || ''} <${t.address}>`).join(', ')}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16">Subject:</span>
              <span className="text-mail-text font-medium">{email.subject}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16">Date:</span>
              <span className="text-mail-text">
                {formatDateTime(email.date)}
              </span>
            </div>
          </div>

          {/* Body */}
          <div className="p-4 overflow-y-auto max-h-[50vh]">
            <pre className="whitespace-pre-wrap text-sm text-mail-text font-sans">
              {email.text || email.textBody || '(No text content)'}
            </pre>
          </div>

          {/* Attachments */}
          {email.attachments?.length > 0 && (
            <div className="px-4 py-3 border-t border-mail-border">
              <h4 className="text-sm font-medium text-mail-text mb-2">Attachments</h4>
              <div className="flex flex-wrap gap-2">
                {email.attachments.map((att, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-1.5 bg-mail-bg border border-mail-border rounded-lg text-sm"
                  >
                    <Paperclip size={14} className="text-mail-text-muted" />
                    <span className="text-mail-text">{att.filename}</span>
                    <button className="p-1 hover:bg-mail-border rounded">
                      <Download size={14} className="text-mail-accent" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
