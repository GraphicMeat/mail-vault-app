import React, { useState, useEffect, useRef } from 'react';
import { Download, Save, ExternalLink } from 'lucide-react';
import { displayText } from '../../utils/bidiText';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { getCleanBase64 } from '../../services/attachmentUtils';
import { useT } from '../../i18n/index.js';
import { usePrivateAttr } from '../../hooks/usePrivacy';
import { send } from '../../services/transport';

export function base64ToBytes(base64) {
  const binary = atob(getCleanBase64(base64));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function mimeOf(attachment) {
  return (attachment.contentType || 'application/octet-stream').split(';')[0].trim();
}

/** Read one attachment's bytes (base64) from the message's cached .eml. */
export async function readAttachment({ accountId, mailbox, uid, attachmentIndex }) {
  const args = { accountId, mailbox, uid, attachmentIndex };
  // The .eml lands a beat after the light fetch answers; give it two more tries.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await send('maildir_read_attachment', args);
    } catch (err) {
      if (attempt < 2 && String(err).includes('not found')) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Attachment content not available');
}

/**
 * The in-app preview: an image as a data: URI, a PDF in a frame from a blob:
 * URL (WKWebView and WebView2 render PDFs natively; WebKitGTK does not and
 * shows its own "download" prompt inside the frame). `loadContent` is the
 * row's reader so the bytes are fetched once and shared.
 */
export function AttachmentPreviewDialog({ attachment, kind, loadContent, downloadedPath, onDownload, onSaveAs, onOpen, onClose }) {
  const t = useT();
  const pa = usePrivateAttr();
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(null);
  // The row repaints on every download/flash state change and its parent hands
  // down a fresh attachment object per render. Neither may re-run the effect
  // below: a new blob: URL reloads the frame under the reader's eyes.
  const attachmentRef = useRef(attachment);
  attachmentRef.current = attachment;

  useEffect(() => {
    let blobUrl = null;
    let cancelled = false;
    loadContent().then((b64) => {
      if (cancelled) return;
      if (kind === 'pdf') {
        blobUrl = URL.createObjectURL(new Blob([base64ToBytes(b64)], { type: 'application/pdf' }));
        setSrc(blobUrl);
      } else {
        setSrc(`data:${mimeOf(attachmentRef.current)};base64,${getCleanBase64(b64)}`);
      }
    }).catch((err) => {
      console.error('[Attachment] Preview failed:', err);
      if (!cancelled) setError(t('email.attachments.failedPreview'));
    });
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [kind, loadContent, t]);

  const isTauri = !!window.__TAURI__;
  // Compose previews a file about to be sent: nothing to download or open.
  const footer = onDownload && (
    <div className="flex items-center justify-end gap-2">
      {downloadedPath && isTauri ? (
        <Button variant="secondary" onClick={onOpen} data-testid="attachment-preview-open">
          <ExternalLink size={14} />
          {t('common.open')}
        </Button>
      ) : (
        <Button variant="secondary" onClick={onDownload} data-testid="attachment-preview-download">
          <Download size={14} />
          {t('email.attachments.download')}
        </Button>
      )}
      {isTauri && (
        <Button variant="primary" onClick={onSaveAs}>
          <Save size={14} />
          {t('email.attachments.save')}
        </Button>
      )}
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={displayText(pa(attachment.filename, 'filename'), t('email.attachments.unnamed'))}
      size="xl"
      portal
      footer={footer}
      data-testid="attachment-preview-dialog"
    >
      <div className="flex items-center justify-center min-h-[240px] max-h-[70vh] bg-mail-surface rounded-lg overflow-hidden">
        {error ? (
          <p className="text-sm text-mail-danger p-6">{error}</p>
        ) : !src ? (
          <div className="w-6 h-6 border-2 border-mail-accent border-t-transparent rounded-full animate-spin" />
        ) : kind === 'pdf' ? (
          <iframe
            src={src}
            title={pa(attachment.filename, 'filename') || 'PDF'}
            className="w-full h-[70vh] border-0"
            data-testid="attachment-preview-pdf"
          />
        ) : (
          <img
            src={src}
            alt={pa(attachment.filename, 'filename') || ''}
            className="max-w-full max-h-[70vh] object-contain"
            data-testid="attachment-preview-image"
          />
        )}
      </div>
    </Dialog>
  );
}
