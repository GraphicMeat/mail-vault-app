import React from 'react';
import { X } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { AttachmentItem } from './AttachmentBar';
import { formatDateTime } from '../../utils/dateFormat';
import { useT } from '../../i18n/index.js';

// Modal for viewing full original email
export function OriginalEmailModal({ email, onClose }) {
  const t = useT();
  return (
    <Dialog
      open={Boolean(email)}
      onClose={onClose}
      size="xl"
      padded={false}
      aria-label={t('email.original.originalEmail')}
      panelClassName="max-h-[85vh] flex flex-col overflow-hidden"
    >
      <>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
            <h3 className="font-semibold text-mail-text">{t('email.original.originalEmail2')}</h3>
            <Button variant="ghost" icon size="sm" onClick={onClose} aria-label={t('common.close')}>
              <X size={18} />
            </Button>
          </div>

          {/* Email Details */}
          <div className="p-4 border-b border-mail-border space-y-2 text-sm shrink-0 overflow-y-auto max-h-[35vh]">
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16 shrink-0">{t('email.original.from')}</span>
              <span className="text-mail-text min-w-0 break-words">
                {email?.from?.name} &lt;{email?.from?.address}&gt;
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16 shrink-0">{t('email.original.to')}</span>
              <span className="text-mail-text min-w-0 break-words">
                {email?.to?.map(t => `${t.name || ''} <${t.address}>`).join(', ')}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16 shrink-0">{t('email.original.subject')}</span>
              <span className="text-mail-text font-medium">{email?.subject}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16 shrink-0">{t('email.original.date')}</span>
              <span className="text-mail-text min-w-0 break-words">
                {formatDateTime(email?.date)}
              </span>
            </div>
          </div>

          {/* Body */}
          <div className="p-5 overflow-y-auto min-h-0 flex-1">
            <pre className="whitespace-pre-wrap break-words text-sm text-mail-text font-sans">
              {email?.text || email?.textBody || '(No text content)'}
            </pre>
          </div>

          {/* Attachments */}
          {email?.attachments?.length > 0 && (
            <div className="px-4 py-3 border-t border-mail-border">
              <h4 className="text-sm font-medium text-mail-text mb-2">{t('email.original.attachments')}</h4>
              <div className="flex flex-wrap gap-2">
                {email.attachments.map((att, i) => (
                  <AttachmentItem key={i} compact attachment={att} attachmentIndex={att._originalIndex ?? i}
                    emailUid={email.uid} accountId={email._accountId} mailbox={email._mailbox} />
                ))}
              </div>
            </div>
          )}
      </>
    </Dialog>
  );
}
