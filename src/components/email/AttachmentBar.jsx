import React, { useState, useEffect, useRef } from 'react';
import { displayText } from '../../utils/bidiText';
import { AnimatePresence } from 'framer-motion';
import { Popover, MenuItem } from '../ui/Popover';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { previewKind } from '../../services/attachmentUtils';
import {
  Download,
  Save,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  AppWindow,
  Check,
} from 'lucide-react';
import { useT } from '../../i18n/index.js';

function getCleanBase64(content) {
  let base64Content = content;
  if (typeof base64Content === 'string' && base64Content.startsWith('data:')) {
    const matches = base64Content.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) base64Content = matches[2];
  }
  if (typeof base64Content === 'string') {
    base64Content = base64Content.replace(/[\s\n\r]/g, '');
  }
  return base64Content;
}

function base64ToBytes(base64) {
  const binary = atob(getCleanBase64(base64));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function mimeOf(attachment) {
  return (attachment.contentType || 'application/octet-stream').split(';')[0].trim();
}

function browserDownload(attachment) {
  const blob = new Blob([base64ToBytes(attachment.content)], { type: mimeOf(attachment) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = attachment.filename || 'attachment';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 500);
}

/** Read one attachment's bytes (base64) from the message's cached .eml. */
async function readAttachment({ accountId, mailbox, uid, attachmentIndex }) {
  const { invoke } = window.__TAURI__.core;
  const args = { accountId, mailbox, uid, attachmentIndex };
  // The .eml lands a beat after the light fetch answers; give it two more tries.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await invoke('maildir_read_attachment', args);
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

function AttachmentContextMenu({ x, y, downloadedPath, canPreview, onPreview, onDownload, onSaveAs, onOpen, onOpenWith, onShowInFolder, onClose }) {
  const t = useT();
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const newX = x + rect.width > window.innerWidth ? x - rect.width : x;
      const newY = y + rect.height > window.innerHeight ? y - rect.height : y;
      setPosition({ x: newX, y: newY });
    }
  }, [x, y]);

  return (
    <Popover
      ref={menuRef}
      open
      onClose={onClose}
      role="menu"
      className="min-w-[180px]"
      style={{ left: position.x, top: position.y }}
    >
      {canPreview && (
        <MenuItem onClick={onPreview}>
          <Eye size={14} />
          {t('email.attachments.preview')}
        </MenuItem>
      )}
      {downloadedPath ? (
        <>
          <MenuItem onClick={onOpen}>
            <ExternalLink size={14} />
            {t('common.open')}
          </MenuItem>
          <MenuItem onClick={onOpenWith}>
            <AppWindow size={14} />
            {t('email.attachments.open')}
          </MenuItem>
          <div className="my-1 border-t border-mail-border" />
          <MenuItem onClick={onSaveAs}>
            <Save size={14} />
            {t('email.attachments.save')}
          </MenuItem>
          <MenuItem onClick={onShowInFolder}>
            <FolderOpen size={14} />
            {t('email.attachments.showFolder')}
          </MenuItem>
        </>
      ) : (
        <>
          <MenuItem onClick={onDownload}>
            <Download size={14} />
            {t('email.attachments.download')}
          </MenuItem>
          <MenuItem onClick={onSaveAs}>
            <Save size={14} />
            {t('email.attachments.save')}
          </MenuItem>
        </>
      )}
    </Popover>
  );
}

/**
 * The in-app preview: an image as a data: URI, a PDF in a frame from a blob:
 * URL (WKWebView and WebView2 render PDFs natively; WebKitGTK does not and
 * shows its own "download" prompt inside the frame). `loadContent` is the
 * row's reader so the bytes are fetched once and shared.
 */
function AttachmentPreviewDialog({ attachment, kind, loadContent, downloadedPath, onDownload, onSaveAs, onOpen, onClose }) {
  const t = useT();
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let blobUrl = null;
    let cancelled = false;
    loadContent().then((b64) => {
      if (cancelled) return;
      if (kind === 'pdf') {
        blobUrl = URL.createObjectURL(new Blob([base64ToBytes(b64)], { type: 'application/pdf' }));
        setSrc(blobUrl);
      } else {
        setSrc(`data:${mimeOf(attachment)};base64,${getCleanBase64(b64)}`);
      }
    }).catch((err) => {
      console.error('[Attachment] Preview failed:', err);
      if (!cancelled) setError(t('email.attachments.failedPreview'));
    });
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [attachment, kind, loadContent, t]);

  const isTauri = !!window.__TAURI__;
  const footer = (
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
      title={displayText(attachment.filename, t('email.attachments.unnamed'))}
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
            title={attachment.filename || 'PDF'}
            className="w-full h-[70vh] border-0"
            data-testid="attachment-preview-pdf"
          />
        ) : (
          <img
            src={src}
            alt={attachment.filename || ''}
            className="max-w-full max-h-[70vh] object-contain"
            data-testid="attachment-preview-image"
          />
        )}
      </div>
    </Dialog>
  );
}

/**
 * One attachment row. `accountId`/`mailbox` name the message's own folder —
 * the one its .eml is cached under — never the view's: in All Inboxes the
 * view says `UNIFIED`, which is not a Maildir folder, and reading there is
 * what "Failed to download" was.
 */
export function AttachmentItem({ attachment, attachmentIndex, emailUid, accountId, mailbox, compact }) {
  const t = useT();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [downloadedPath, setDownloadedPath] = useState(null);
  const [justDownloaded, setJustDownloaded] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const contentRef = useRef(attachment.content || null);
  const isTauri = !!window.__TAURI__;
  const kind = previewKind(attachment);
  const location = { accountId, mailbox, uid: emailUid, attachmentIndex };

  // The prefetch (or an earlier click) may have cached this already.
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    window.__TAURI__.core.invoke('cached_attachment_path', location)
      .then((path) => { if (!cancelled && path) setDownloadedPath(path); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, mailbox, emailUid, attachmentIndex, isTauri]);

  const ensureContent = async () => {
    if (contentRef.current) return contentRef.current;
    if (!isTauri) throw new Error('Attachment content not available');
    contentRef.current = await readAttachment(location);
    return contentRef.current;
  };

  const flashDownloaded = (path) => {
    setDownloadedPath(path);
    setJustDownloaded(true);
    setTimeout(() => setJustDownloaded(false), 3000);
  };

  const handleDownload = async (e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    setDownloading(true);
    setError(null);
    try {
      if (isTauri) {
        flashDownloaded(await window.__TAURI__.core.invoke('cache_attachment', location));
      } else {
        browserDownload({ ...attachment, content: await ensureContent() });
      }
    } catch (err) {
      console.error('[Attachment] Failed to download:', err);
      setError(t('email.attachments.failedDownload'));
      setTimeout(() => setError(null), 3000);
    } finally {
      setDownloading(false);
    }
  };

  const handleSaveAs = async () => {
    setContextMenu(null);
    if (!isTauri) return;

    try {
      const b64 = await ensureContent();
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { invoke } = window.__TAURI__.core;
      const fname = attachment.filename || 'attachment';

      const destPath = await save({
        defaultPath: fname,
        title: t('email.attachments.saveAttachment'),
      });
      if (!destPath) return; // user cancelled

      setDownloading(true);
      setError(null);
      const savedPath = await invoke('save_attachment_to', {
        filename: fname,
        contentBase64: getCleanBase64(b64),
        destPath,
      });
      flashDownloaded(savedPath);
    } catch (err) {
      console.error('[Attachment] Save As failed:', err);
      setError(t('email.attachments.failedSave'));
      setTimeout(() => setError(null), 3000);
    } finally {
      setDownloading(false);
    }
  };

  const handleContextMenu = (e) => {
    if (!isTauri) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const withPath = (command) => async (e) => {
    if (e?.stopPropagation) e.stopPropagation();
    setContextMenu(null);
    if (!downloadedPath) return;
    try {
      await window.__TAURI__.core.invoke(command, { path: downloadedPath });
    } catch (err) {
      console.error(`[Attachment] ${command} failed:`, err);
    }
  };
  const handleOpen = withPath('open_file');
  const handleOpenWith = withPath('open_with_dialog');
  const handleShowInFolder = withPath('show_in_folder');

  const openPreview = (e) => {
    if (e?.stopPropagation) e.stopPropagation();
    setContextMenu(null);
    setPreviewOpen(true);
  };

  const handleRowClick = kind ? openPreview : (downloadedPath && isTauri ? handleOpen : handleDownload);

  const formatSize = (bytes) => {
    if (!bytes) return t('email.attachments.unknownSize');
    if (bytes < 1024) return t('settings.backup.account.b', { bytes });
    if (bytes < 1024 * 1024) return t('settings.backup.account.kb', { bytes: (bytes / 1024).toFixed(1) });
    return t('settings.backup.account.mb', { bytes: (bytes / (1024 * 1024)).toFixed(1) });
  };

  const iconSize = compact ? 14 : 20;
  const badgeIconSize = compact ? 12 : 16;
  const iconButton = 'p-1 rounded-md text-mail-text-muted hover:text-mail-accent-text hover:bg-mail-accent/10 transition-colors';

  return (
    <>
      <div
        className={`flex items-center gap-${compact ? '2' : '3'} ${compact ? 'px-2.5 py-1.5' : 'p-3'} bg-mail-bg rounded-lg border transition-all group cursor-pointer
                   ${error ? 'border-mail-danger' : justDownloaded ? 'border-mail-success/50' : 'border-mail-border hover:border-mail-accent/50'}`}
        onClick={handleRowClick}
        onContextMenu={handleContextMenu}
        role="button"
        tabIndex={0}
        data-testid="attachment-item"
      >
        <div className={`${compact ? 'w-7 h-7' : 'w-10 h-10'} rounded-lg flex items-center justify-center ${justDownloaded ? 'bg-mail-success-tint' : 'bg-mail-accent/10'}`}>
          {justDownloaded ? (
            <Check size={iconSize} className="text-mail-success" />
          ) : (
            <FileText size={iconSize} className="text-mail-accent-text" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-mail-text truncate`}>
            {displayText(attachment.filename, t('email.attachments.unnamed'))}
          </div>
          <div className={`${compact ? 'text-[10px]' : 'text-xs'} text-mail-text-muted`}>
            {error ? (
              <span className="text-mail-danger">{error}</span>
            ) : justDownloaded ? (
              <span className="text-mail-success">{t('email.attachments.downloaded')}</span>
            ) : downloadedPath ? (
              <span className="text-mail-text-muted">{t('email.attachments.clickOpen')}</span>
            ) : (
              formatSize(attachment.size)
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          {kind && (
            <button
              type="button"
              onClick={openPreview}
              className={iconButton}
              title={t('email.attachments.preview')}
              aria-label={t('email.attachments.preview')}
              data-testid="attachment-preview"
            >
              <Eye size={badgeIconSize} />
            </button>
          )}
          {downloading ? (
            <div className={`${compact ? 'w-3 h-3' : 'w-4 h-4'} m-1 border-2 border-mail-accent border-t-transparent rounded-full animate-spin`} />
          ) : justDownloaded ? (
            <Check size={badgeIconSize} className="m-1 text-mail-success" />
          ) : downloadedPath && isTauri ? (
            <button
              type="button"
              onClick={handleOpen}
              className={iconButton}
              title={t('common.open')}
              aria-label={t('common.open')}
              data-testid="attachment-open"
            >
              <ExternalLink size={badgeIconSize} />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleDownload}
              className={iconButton}
              title={t('email.attachments.download')}
              aria-label={t('email.attachments.download')}
              data-testid="attachment-download"
            >
              <Download size={badgeIconSize} />
            </button>
          )}
        </div>
      </div>
      <AnimatePresence>
        {contextMenu && (
          <AttachmentContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            downloadedPath={downloadedPath}
            canPreview={!!kind}
            onPreview={openPreview}
            onDownload={() => { setContextMenu(null); handleDownload(); }}
            onSaveAs={handleSaveAs}
            onOpen={handleOpen}
            onOpenWith={handleOpenWith}
            onShowInFolder={handleShowInFolder}
            onClose={() => setContextMenu(null)}
          />
        )}
      </AnimatePresence>
      {previewOpen && (
        <AttachmentPreviewDialog
          attachment={attachment}
          kind={kind}
          loadContent={ensureContent}
          downloadedPath={downloadedPath}
          onDownload={() => handleDownload()}
          onSaveAs={handleSaveAs}
          onOpen={handleOpen}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  );
}

export function DownloadAllButton({ attachments, emailUid, accountId, mailbox }) {
  const t = useT();
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const isTauri = !!window.__TAURI__;

  const handleDownloadAll = async () => {
    if (attachments.length === 0) return;

    setDownloading(true);
    setProgress({ current: 0, total: attachments.length });

    try {
      for (let i = 0; i < attachments.length; i++) {
        const attachment = attachments[i];
        setProgress({ current: i + 1, total: attachments.length });
        const location = { accountId, mailbox, uid: emailUid, attachmentIndex: attachment._originalIndex };

        try {
          if (isTauri) {
            await window.__TAURI__.core.invoke('cache_attachment', location);
          } else if (attachment.content) {
            browserDownload(attachment);
            if (i < attachments.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          }
        } catch (err) {
          console.error(`Failed to download attachment ${i + 1}:`, err);
        }
      }
    } finally {
      setDownloading(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  return (
    <button
      onClick={handleDownloadAll}
      disabled={downloading}
      className="flex items-center gap-1.5 px-3 py-1.5 bg-mail-accent/10
                text-mail-accent-text hover:bg-mail-accent/20 rounded-lg text-sm
                font-medium transition-colors disabled:opacity-70"
    >
      {downloading ? (
        <>
          <div className="w-3.5 h-3.5 border-2 border-mail-accent border-t-transparent rounded-full animate-spin" />
          <span>{progress.current}/{progress.total}</span>
        </>
      ) : (
        <>
          <Download size={14} />
          <span>{t('email.attachments.downloadAll')}</span>
        </>
      )}
    </button>
  );
}
