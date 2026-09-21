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
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FolderDown,
  FolderOpen,
  AppWindow,
  Check,
} from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { send } from '../../services/transport';

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

/**
 * The tile shows what the file IS, not that it is a file.
 *
 * Images get their own bytes as a thumbnail (`THUMB_MAX_BYTES` keeps a 40px
 * square from pulling a 30MB camera original over IPC); everything else gets
 * the icon of its kind, because one `FileText` for a zip, a spreadsheet and a
 * video told the user nothing the filename did not already say.
 */
const THUMB_MAX_BYTES = 4 * 1024 * 1024;
// A photo album arrives as twenty images; reading them all on mount would
// hold twenty full base64 copies in the webview for twenty 40px squares. The
// rows past this one keep their icon — and a thread renders a row per
// message, so the cap is per message list, not per window.
const THUMB_MAX_COUNT = 8;

// A 1x1 transparent PNG. `start_drag` requires a drag image and rejects
// anything that is not PNG data; this stands in when rendering the row fails.
const DRAG_FALLBACK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const ICON_BY_EXT = {
  zip: FileArchive, rar: FileArchive, '7z': FileArchive, gz: FileArchive, tar: FileArchive,
  csv: FileSpreadsheet, xls: FileSpreadsheet, xlsx: FileSpreadsheet, numbers: FileSpreadsheet,
  mp3: FileAudio, wav: FileAudio, m4a: FileAudio, aac: FileAudio, flac: FileAudio, ogg: FileAudio,
  mp4: FileVideo, mov: FileVideo, avi: FileVideo, mkv: FileVideo, webm: FileVideo,
  json: FileCode, xml: FileCode, html: FileCode, js: FileCode, ics: FileCode,
};

export function attachmentIcon({ contentType, filename } = {}) {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  const ext = (filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ICON_BY_EXT[ext]) return ICON_BY_EXT[ext];
  if (type.startsWith('audio/')) return FileAudio;
  if (type.startsWith('video/')) return FileVideo;
  if (type === 'application/zip' || type === 'application/x-tar') return FileArchive;
  if (type.startsWith('text/') || type === 'application/pdf' || ext === 'pdf') return FileText;
  if (type.startsWith('application/') || !type) return File;
  return FileText;
}

/**
 * Where the export folder for one message goes, from its subject.
 *
 * A subject is not a filename: it carries `/`, `:`, newlines, and runs past
 * any sane path component. `vault_files::fs_safe` does the same job for the
 * attachment cache; this is its JS twin for a folder the USER sees, so it
 * keeps spaces rather than replacing them with underscores.
 */
export function exportFolderName(subject, fallback) {
  const sanitized = String(subject || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ');
  // By code point: a plain `slice` can cut an emoji in half and leave a lone
  // surrogate in a folder name.
  const clean = [...sanitized]
    .slice(0, 60)
    .join('')
    // A leading dot hides the folder; a leading or trailing dash is what a
    // subject that began with a path separator leaves behind.
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '');
  return clean ? `${clean} - ${fallback}` : fallback;
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

/**
 * Where in ~/Downloads this file goes.
 *
 * The sandbox entitlement (`files.downloads.read-write`, both plists) covers
 * this folder without a save panel, which is what makes Download a one-click
 * action — it used to write into the app's own attachment cache, so getting
 * the file where the user expected it still needed a right-click and a dialog.
 *
 * A name already taken gets a counter rather than being overwritten: an
 * unrelated `invoice.pdf` sitting in Downloads is not ours to destroy, and no
 * browser download does that either.
 */
async function downloadsDest(filename) {
  const { downloadDir, join } = await import('@tauri-apps/api/path');
  const { exists } = await import('@tauri-apps/plugin-fs');
  const dir = await downloadDir();
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  // ponytail: a linear probe, capped — a folder holding 500 copies of one
  // name is not a case worth a smarter search, and the cap stops a failing
  // `exists` from spinning forever.
  for (let n = 0; n < 500; n++) {
    const candidate = await join(dir, n === 0 ? filename : `${base} (${n})${ext}`);
    // A refused `exists` must not cost the download: the worst it can do is
    // overwrite a same-named file, while letting it throw turns every
    // download into "Failed to download".
    if (!await exists(candidate).catch(() => false)) return candidate;
  }
  return await join(dir, `${base} (${Date.now()})${ext}`);
}

/** Read one attachment's bytes (base64) from the message's cached .eml. */
async function readAttachment({ accountId, mailbox, uid, attachmentIndex }) {
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
      {/* Open is unconditional: it caches the file itself when nothing is
          cached yet, so the first right-click can already reach Preview.
          Everything below it needs a path that exists on disk. */}
      <MenuItem onClick={onOpen}>
        <ExternalLink size={14} />
        {t('common.open')}
      </MenuItem>
      {downloadedPath ? (
        <>
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
export function AttachmentItem({ attachment, attachmentIndex, emailUid, accountId, mailbox, compact, listIndex = 0 }) {
  const t = useT();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [downloadedPath, setDownloadedPath] = useState(null);
  const [justDownloaded, setJustDownloaded] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [thumb, setThumb] = useState(null);
  const rowRef = useRef(null);
  const contentRef = useRef(attachment.content || null);
  const isDemo = !!window.__MAILVAULT_DEMO__;
  const isTauri = !!window.__TAURI__ && !isDemo;
  const kind = previewKind(attachment);
  const location = { accountId, mailbox, uid: emailUid, attachmentIndex };

  // The prefetch (or an earlier click) may have cached this already.
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    send('cached_attachment_path', location)
      .then((path) => { if (!cancelled && path) setDownloadedPath(path); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, mailbox, emailUid, attachmentIndex, isTauri]);

  const ensureContent = async () => {
    if (contentRef.current) return contentRef.current;
    if (!window.__TAURI__?.core?.invoke) throw new Error('Attachment content not available');
    contentRef.current = await readAttachment(location);
    return contentRef.current;
  };

  // The thumbnail shares `contentRef` with the preview and the download, so
  // an image is read from the .eml once however many of the three run.
  useEffect(() => {
    if (kind !== 'image') return undefined;
    if (attachment.size && attachment.size > THUMB_MAX_BYTES) return undefined;
    if (listIndex >= THUMB_MAX_COUNT) return undefined;
    let cancelled = false;
    ensureContent()
      .then((b64) => { if (!cancelled) setThumb(`data:${mimeOf(attachment)};base64,${getCleanBase64(b64)}`); })
      .catch(() => {}); // no bytes yet is not an error worth showing: the icon stands in
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, mailbox, emailUid, attachmentIndex, kind, listIndex]);

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
        const fname = attachment.filename || 'attachment';
        const b64 = await ensureContent();
        flashDownloaded(await window.__TAURI__.core.invoke('save_attachment_to', {
          filename: fname,
          contentBase64: getCleanBase64(b64),
          destPath: await downloadsDest(fname),
        }));
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
    if (isDemo) {
      try {
        browserDownload({ ...attachment, content: await ensureContent() });
        flashDownloaded(`browser-downloads/${attachment.filename || 'attachment'}`);
      } catch (err) {
        console.error('[Attachment] Browser save failed:', err);
        setError(t('email.attachments.failedSave'));
        setTimeout(() => setError(null), 3000);
      }
      return;
    }
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

  /**
   * Hand the file to the system's default app on the FIRST click.
   *
   * `handleOpen` needs a cached path, and the only thing that cached one was
   * the download button — which the previewable kinds (image, PDF) never show,
   * because their slot holds the eye. So for exactly the files someone wants
   * in Preview, there was no one-click way out of the app.
   */
  const openExternally = async (e) => {
    if (e?.stopPropagation) e.stopPropagation();
    setContextMenu(null);
    if (!isTauri) return;
    setDownloading(true);
    setError(null);
    try {
      const { invoke } = window.__TAURI__.core;
      const path = downloadedPath ?? await send('cache_attachment', location);
      setDownloadedPath(path);
      await invoke('open_file', { path });
    } catch (err) {
      console.error('[Attachment] Open externally failed:', err);
      setError(t('email.attachments.failedDownload'));
      setTimeout(() => setError(null), 3000);
    } finally {
      setDownloading(false);
    }
  };

  /**
   * The cached path, caching it first when nothing is cached yet.
   *
   * A drag needs a real file on disk, and `dragstart` is the only place that
   * caches one: doing it on `mousedown` would write a cache copy on every
   * plain click of a row, including the Download button's, which is exactly
   * the private-cache write Download was changed to stop making.
   */
  const pathPromiseRef = useRef(null);
  const ensurePath = () => {
    if (downloadedPath) return Promise.resolve(downloadedPath);
    if (!pathPromiseRef.current) {
      pathPromiseRef.current = send('cache_attachment', location)
        .then((path) => { setDownloadedPath(path); return path; })
        .catch((err) => { pathPromiseRef.current = null; throw err; });
    }
    return pathPromiseRef.current;
  };

  /**
   * Drag the file out to Finder (or any other app).
   *
   * WebKit's own HTML5 drag hands a WKWebView page's `DownloadURL` to nobody:
   * dropping it on the Desktop produces a `.webloc`, not the file. So the
   * browser drag is cancelled and a real AppKit/Win32/GTK drag session is
   * started from the file already on disk, with a picture of this row as the
   * drag image.
   */
  const handleDragStart = async (e) => {
    if (!isTauri) return;
    e.preventDefault();
    try {
      const path = await ensurePath();
      const [{ Channel }, { domToPng }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('modern-screenshot'),
      ]);
      const image = await domToPng(rowRef.current, { scale: 1 }).catch(() => DRAG_FALLBACK_PNG);
      // The LIVE global bridge, like every other invoke in this file: the
      // module's copy talks to `__TAURI_INTERNALS__` directly, which no e2e
      // fixture can swap — and an unstubbed start_drag on the runner opens a
      // real drag session.
      await window.__TAURI__.core.invoke('plugin:drag|start_drag', {
        item: [path],
        image,
        // The plugin's callback is not optional; nothing here needs the drop
        // result, so it is drained.
        onEvent: new Channel(),
      });
    } catch (err) {
      console.error('[Attachment] Drag failed:', err);
    }
  };

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
  const KindIcon = attachmentIcon(attachment);
  const iconButton = 'p-1 min-w-7 min-h-7 inline-flex items-center justify-center rounded-md text-mail-text-muted hover:text-mail-accent-text hover:bg-mail-accent/10 transition-colors';

  return (
    <>
      <div
        ref={rowRef}
        className={`flex items-center gap-${compact ? '2' : '3'} ${compact ? 'px-2.5 py-1.5' : 'p-3'} bg-mail-bg rounded-lg border transition-all group cursor-pointer
                   ${error ? 'border-mail-danger' : justDownloaded ? 'border-mail-success/50' : 'border-mail-border hover:border-mail-accent/50'}`}
        draggable={isTauri}
        onDragStart={isTauri ? handleDragStart : undefined}
        onClick={handleRowClick}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          handleRowClick(event);
        }}
        onContextMenu={handleContextMenu}
        role="button"
        tabIndex={0}
        data-testid="attachment-item"
      >
        <div className={`${compact ? 'w-7 h-7' : 'w-10 h-10'} shrink-0 rounded-lg overflow-hidden flex items-center justify-center ${justDownloaded ? 'bg-mail-success-tint' : 'bg-mail-accent/10'}`}>
          {justDownloaded ? (
            <Check size={iconSize} className="text-mail-success" />
          ) : thumb ? (
            <img
              src={thumb}
              alt=""
              className="w-full h-full object-cover"
              data-testid="attachment-thumb"
            />
          ) : (
            <KindIcon size={iconSize} className="text-mail-accent-text" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-mail-text truncate`}>
            {displayText(attachment.filename, t('email.attachments.unnamed'))}
          </div>
          <div className={`text-xs text-mail-text-muted`}>
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
          {isTauri && (
            <button
              type="button"
              onClick={openExternally}
              className={iconButton}
              title={t('common.open')}
              aria-label={t('common.open')}
              data-testid="attachment-open-external"
            >
              <ExternalLink size={badgeIconSize} />
            </button>
          )}
          {/* Save As was right-click only, which is not discoverable and not
              reachable at all without a mouse. Hidden in `compact` rows
              (OriginalEmailModal) — a fourth button there crushes the
              filename; the context menu still has it. */}
          {(isTauri || isDemo) && !compact && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleSaveAs(); }}
              className={iconButton}
              title={t('email.attachments.save')}
              aria-label={t('email.attachments.save')}
              data-testid="attachment-save-as"
            >
              <Save size={badgeIconSize} />
            </button>
          )}
          {downloading ? (
            <div className={`${compact ? 'w-3 h-3' : 'w-4 h-4'} m-1 border-2 border-mail-accent border-t-transparent rounded-full animate-spin`} />
          ) : justDownloaded ? (
            <Check size={badgeIconSize} className="m-1 text-mail-success" />
          ) : downloadedPath && isTauri ? null /* the Open button above already is this row's open, and two identical
                 ExternalLinks side by side read as two different actions */ : (
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
            onOpen={openExternally}
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

/**
 * Export every attachment of one message into a folder of its own.
 *
 * It used to loop `cache_attachment`, which writes into the app's PRIVATE
 * attachment cache — the files were "downloaded" somewhere the user could
 * not find. The daemon now writes them into `~/Downloads/<subject> -
 * Attachments` (a `(n)` sibling when that folder is taken, so two messages
 * never merge) and the folder is revealed when it lands.
 */
export function DownloadAllButton({ attachments, emailUid, accountId, mailbox, subject }) {
  const t = useT();
  const [downloading, setDownloading] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const isDemo = !!window.__MAILVAULT_DEMO__;
  const isTauri = !!window.__TAURI__ && !isDemo;

  const handleDownloadAll = async () => {
    if (attachments.length === 0) return;
    setDownloading(true);
    setError(null);
    try {
      const destDir = isTauri
        ? await (async () => {
            const { downloadDir, join } = await import('@tauri-apps/api/path');
            return join(await downloadDir(), exportFolderName(subject, t('email.attachments.folderName')));
          })()
        : '';
      const result = await send('export_attachments', {
        accountId,
        mailbox,
        uid: emailUid,
        indices: attachments.map((a) => a._originalIndex),
        destDir,
      });
      // The folder's own name, not "Downloaded": when Finder refuses to open
      // (a sandbox scope it does not hold), this is the only thing that says
      // where the files went.
      setDone(result?.dir ? result.dir.split('/').pop() : t('email.attachments.downloaded'));
      setTimeout(() => setDone(null), 6000);
      if (isTauri && result?.dir) {
        await window.__TAURI__.core.invoke('show_in_folder', { path: result.dir }).catch(() => {});
      }
    } catch (err) {
      console.error('[Attachment] Download all failed:', err);
      setError(t('email.attachments.failedDownload'));
      setTimeout(() => setError(null), 3000);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button
      onClick={handleDownloadAll}
      disabled={downloading}
      data-testid="attachment-download-all"
      className="flex items-center gap-1.5 px-3 py-1.5 bg-mail-accent/10
                text-mail-accent-text hover:bg-mail-accent/20 rounded-lg text-sm
                font-medium transition-colors disabled:opacity-70"
    >
      {downloading ? (
        <>
          <div className="w-3.5 h-3.5 border-2 border-mail-accent border-t-transparent rounded-full animate-spin" />
          <span>{t('email.attachments.downloadAll')}</span>
        </>
      ) : error ? (
        <span className="text-mail-danger">{error}</span>
      ) : done ? (
        <>
          <Check size={14} />
          <span className="max-w-[16rem] truncate">{done}</span>
        </>
      ) : (
        <>
          <FolderDown size={14} />
          <span>{t('email.attachments.downloadAll')}</span>
        </>
      )}
    </button>
  );
}
