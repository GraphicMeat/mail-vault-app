import React from 'react';
import { Paperclip, X, Download } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { formatDateTime } from '../../utils/dateFormat';

// Modal for viewing full original email
export function OriginalEmailModal({ email, onClose }) {
  return (
    <Dialog
      open={Boolean(email)}
      onClose={onClose}
      size="xl"
      padded={false}
      aria-label="Original email"
      panelClassName="max-h-[80vh] overflow-hidden"
    >
      <>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
            <h3 className="font-semibold text-mail-text">Original Email</h3>
            <Button variant="ghost" icon size="sm" onClick={onClose} aria-label="Close">
              <X size={18} />
            </Button>
          </div>

          {/* Email Details */}
          <div className="p-4 border-b border-mail-border space-y-2 text-sm">
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16">From:</span>
              <span className="text-mail-text">
                {email?.from?.name} &lt;{email?.from?.address}&gt;
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16">To:</span>
              <span className="text-mail-text">
                {email?.to?.map(t => `${t.name || ''} <${t.address}>`).join(', ')}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16">Subject:</span>
              <span className="text-mail-text font-medium">{email?.subject}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16">Date:</span>
              <span className="text-mail-text">
                {formatDateTime(email?.date)}
              </span>
            </div>
          </div>

          {/* Body */}
          <div className="p-4 overflow-y-auto max-h-[50vh]">
            <pre className="whitespace-pre-wrap text-sm text-mail-text font-sans">
              {email?.text || email?.textBody || '(No text content)'}
            </pre>
          </div>

          {/* Attachments */}
          {email?.attachments?.length > 0 && (
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
                    <Button variant="ghost" icon size="xs" aria-label={`Download ${att.filename}`}>
                      <Download size={14} className="text-mail-accent-text" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
      </>
    </Dialog>
  );
}
