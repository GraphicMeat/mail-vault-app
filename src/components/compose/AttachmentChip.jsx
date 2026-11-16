import React, { useCallback, useState } from 'react';
import { Eye, FileText, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { Private } from '../privacy/Private';
import { t, useT } from '../../i18n/index.js';
import { usePrivateAttr } from '../../hooks/usePrivacy';
import { previewKind } from '../../services/attachmentUtils';
import { AttachmentPreviewDialog, readAttachment } from '../email/AttachmentPreviewDialog';

export const sizeLabel = (t, bytes) => {
  if (bytes < 1024) return t('settings.backup.account.b', { bytes });
  if (bytes < 1024 * 1024) return t('settings.backup.account.kb', { bytes: (bytes / 1024).toFixed(1) });
  return t('settings.backup.account.mb', { bytes: (bytes / (1024 * 1024)).toFixed(1) });
};

/** One attached file in compose: name, size, preview (image or PDF), remove. */
export function AttachmentChip({ attachment, onRemove }) {
  const t = useT();
  const pa = usePrivateAttr();
  const formatSize = bytes => sizeLabel(t, bytes);
  const [previewOpen, setPreviewOpen] = useState(false);
  const kind = previewKind(attachment);
  const { content, _source: source } = attachment;
  // Picked or dropped files carry their bytes; a forwarded one names the
  // original message instead, read from its .eml on demand. Stable per bytes:
  // the dialog re-reads (and a PDF frame reloads) whenever this changes.
  const loadContent = useCallback(
    () => (content != null ? Promise.resolve(content) : readAttachment(source)),
    [content, source],
  );
  const canPreview = kind && (content != null || source);

  return (
    <div
      data-testid="compose-attachment"
      data-filename={pa(attachment.filename, 'filename')}
      // A wrapped flex item is as wide as its content: without the cap a long
      // file name pushes the chip past the window's edge.
      className="flex items-center gap-2 px-3 py-2 bg-mail-surface-hover rounded-lg max-w-full min-w-0"
    >
      <FileText size={16} className="text-mail-accent-text shrink-0" />
      <span className="text-sm text-mail-text truncate flex-1 min-w-0"><Private kind="filename">{attachment.filename}</Private></span>
      <span className="text-xs text-mail-text-muted shrink-0">{formatSize(attachment.size)}</span>
      {canPreview && (
        <Button variant="ghost" icon size="xs" className="hover:bg-mail-border shrink-0"
          onClick={() => setPreviewOpen(true)}
          title={t('email.attachments.preview')}
          aria-label={t('email.attachments.preview')}
          data-testid="attachment-preview"
        >
          <Eye size={14} className="text-mail-text-muted" />
        </Button>
      )}
      <Button variant="ghost" icon size="xs" className="hover:bg-mail-border shrink-0"
        onClick={onRemove}
        title={t('compose.removeAttachment')}
        aria-label={t('compose.removeAttachment')}
        data-testid="compose-attachment-remove"
      >
        <X size={14} className="text-mail-text-muted" />
      </Button>
      {previewOpen && (
        <AttachmentPreviewDialog attachment={attachment} kind={kind} loadContent={loadContent}
          onClose={() => setPreviewOpen(false)} />
      )}
    </div>
  );
}
