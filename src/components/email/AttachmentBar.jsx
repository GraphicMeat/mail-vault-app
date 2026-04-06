import React, { useState, useEffect, useRef } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Download,
  Save,
  ExternalLink,
  FileText,
  FolderOpen,
  AppWindow,
  Check,
} from 'lucide-react';

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

function browserDownload(attachment) {
  let base64Content = attachment.content;
  let contentType = attachment.contentType || 'application/octet-stream';

  if (typeof base64Content === 'string' && base64Content.startsWith('data:')) {
    const matches = base64Content.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      contentType = matches[1];
      base64Content = matches[2];
    }
  }
  if (typeof base64Content === 'string') {
    base64Content = base64Content.replace(/[\s\n\r]/g, '');
  }

  const binary = atob(base64Content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: contentType });
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

function AttachmentContextMenu({ x, y, downloadedPath, onDownload, onSaveAs, onOpen, onOpenWith, onShowInFolder, onClose }) {
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

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  return (
    <motion.div
      ref={menuRef}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="fixed z-50 bg-mail-surface border border-mail-border rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: position.x, top: position.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {downloadedPath ? (
        <>
          <button
            onClick={onOpen}
            className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2 text-mail-text"
          >
            <ExternalLink size={14} />
            Open
          </button>
          <button
            onClick={onOpenWith}
            className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2 text-mail-text"
          >
            <AppWindow size={14} />
            Open With...
          </button>
          <div className="my-1 border-t border-mail-border" />
          <button
            onClick={onSaveAs}
            className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2 text-mail-text"
          >
            <Save size={14} />
            Save As...
          </button>
          <button
            onClick={onShowInFolder}
            className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2 text-mail-text"
          >
            <FolderOpen size={14} />
            Show in Folder
          </button>
        </>
      ) : (
        <>
          <button
            onClick={onDownload}
            className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2 text-mail-text"
          >
            <Download size={14} />
            Download
          </button>
          <button
            onClick={onSaveAs}
            className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2 text-mail-text"
          >
            <Save size={14} />
            Save As...
          </button>
        </>
      )}
    </motion.div>
  );
}

export function AttachmentItem({ attachment, attachmentIndex, emailUid, account, folder, accountId: accountIdProp, mailbox: mailboxProp, compact }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [downloadedPath, setDownloadedPath] = useState(null);
  const [justDownloaded, setJustDownloaded] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [contentBase64, setContentBase64] = useState(attachment.content || null);
  const isTauri = !!window.__TAURI__;

  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const activeMailbox = useAccountStore(s => s.activeMailbox);

  const resolvedAccountId = accountIdProp || activeAccountId;
  const resolvedMailbox = mailboxProp || activeMailbox;

  // Lazy-load attachment content from disk on demand (with retry for timing)
  const ensureContent = async () => {
    if (contentBase64) return contentBase64;
    if (isTauri) {
      const { invoke } = window.__TAURI__.core;
      const args = { accountId: resolvedAccountId, mailbox: resolvedMailbox, uid: emailUid, attachmentIndex };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const b64 = await invoke('maildir_read_attachment', args);
          setContentBase64(b64);
          return b64;
        } catch (err) {
          if (attempt < 2 && String(err).includes('not found')) {
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          throw err;
        }
      }
    }
    throw new Error('Attachment content not available');
  };

  const handleDownload = async (e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }

    setDownloading(true);
    setError(null);

    try {
      const b64 = await ensureContent();
      if (!b64) throw new Error('Could not load attachment content');

      if (isTauri) {
        const { invoke } = window.__TAURI__.core;
        const base64Content = getCleanBase64(b64);
        const savedPath = await invoke('save_attachment', {
          filename: attachment.filename || 'attachment',
          contentBase64: base64Content,
          account: resolvedAccountId || null,
          folder: resolvedMailbox || null,
        });
        setDownloadedPath(savedPath);
        setJustDownloaded(true);
        setTimeout(() => setJustDownloaded(false), 3000);
      } else {
        browserDownload({ ...attachment, content: b64 });
      }
    } catch (err) {
      console.error('[Attachment] Failed to download:', err);
      setError('Failed to download');
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
      if (!b64) throw new Error('Could not load attachment content');

      const { save } = await import('@tauri-apps/plugin-dialog');
      const { invoke } = window.__TAURI__.core;
      const fname = attachment.filename || 'attachment';

      const destPath = await save({
        defaultPath: fname,
        title: 'Save Attachment',
      });
      if (!destPath) return; // user cancelled

      setDownloading(true);
      setError(null);
      const base64Content = getCleanBase64(b64);
      const savedPath = await invoke('save_attachment_to', {
        filename: fname,
        contentBase64: base64Content,
        destPath,
      });
      setDownloadedPath(savedPath);
      setJustDownloaded(true);
      setTimeout(() => setJustDownloaded(false), 3000);
    } catch (err) {
      console.error('[Attachment] Save As failed:', err);
      setError('Failed to save');
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

  const handleOpen = async () => {
    setContextMenu(null);
    if (downloadedPath) {
      try {
        const { invoke } = window.__TAURI__.core;
        await invoke('open_file', { path: downloadedPath });
      } catch (err) {
        console.error('[Attachment] Failed to open:', err);
      }
    }
  };

  const handleOpenWith = async () => {
    setContextMenu(null);
    if (downloadedPath) {
      try {
        const { invoke } = window.__TAURI__.core;
        await invoke('open_with_dialog', { path: downloadedPath });
      } catch (err) {
        console.error('[Attachment] Failed to open with:', err);
      }
    }
  };

  const handleShowInFolder = async () => {
    setContextMenu(null);
    if (downloadedPath) {
      try {
        const { invoke } = window.__TAURI__.core;
        await invoke('show_in_folder', { path: downloadedPath });
      } catch (err) {
        console.error('[Attachment] Failed to show in folder:', err);
      }
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return 'Unknown size';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const iconSize = compact ? 14 : 20;
  const badgeIconSize = compact ? 12 : 16;

  return (
    <>
      <div
        className={`flex items-center gap-${compact ? '2' : '3'} ${compact ? 'px-2.5 py-1.5' : 'p-3'} bg-mail-bg rounded-lg border transition-all group cursor-pointer
                   ${error ? 'border-mail-danger' : justDownloaded ? 'border-green-500/50' : 'border-mail-border hover:border-mail-accent/50'}`}
        onClick={downloadedPath && isTauri ? handleOpen : handleDownload}
        onContextMenu={handleContextMenu}
        role="button"
        tabIndex={0}
      >
        <div className={`${compact ? 'w-7 h-7' : 'w-10 h-10'} rounded-lg flex items-center justify-center ${justDownloaded ? 'bg-green-500/10' : 'bg-mail-accent/10'}`}>
          {justDownloaded ? (
            <Check size={iconSize} className="text-green-500" />
          ) : (
            <FileText size={iconSize} className="text-mail-accent" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-mail-text truncate`}>
            {attachment.filename || 'Unnamed attachment'}
          </div>
          <div className={`${compact ? 'text-[10px]' : 'text-xs'} text-mail-text-muted`}>
            {error ? (
              <span className="text-mail-danger">{error}</span>
            ) : justDownloaded ? (
              <span className="text-green-500">Downloaded</span>
            ) : downloadedPath ? (
              <span className="text-mail-text-muted">Click to open</span>
            ) : (
              formatSize(attachment.size)
            )}
          </div>
        </div>
        {downloading ? (
          <div className={`${compact ? 'w-3 h-3' : 'w-4 h-4'} border-2 border-mail-accent border-t-transparent rounded-full animate-spin`} />
        ) : justDownloaded ? (
          <Check size={badgeIconSize} className="text-green-500" />
        ) : downloadedPath ? (
          <ExternalLink
            size={badgeIconSize}
            className="text-mail-text-muted group-hover:text-mail-accent transition-colors"
          />
        ) : (
          <Download
            size={badgeIconSize}
            className="text-mail-text-muted group-hover:text-mail-accent transition-colors"
          />
        )}
      </div>
      <AnimatePresence>
        {contextMenu && (
          <AttachmentContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            downloadedPath={downloadedPath}
            onDownload={() => { setContextMenu(null); handleDownload(); }}
            onSaveAs={handleSaveAs}
            onOpen={handleOpen}
            onOpenWith={handleOpenWith}
            onShowInFolder={handleShowInFolder}
            onClose={() => setContextMenu(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

export function DownloadAllButton({ attachments, emailUid, account, folder }) {
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const isTauri = !!window.__TAURI__;

  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const activeMailbox = useAccountStore(s => s.activeMailbox);

  const handleDownloadAll = async () => {
    if (attachments.length === 0) return;

    setDownloading(true);
    setProgress({ current: 0, total: attachments.length });

    try {
      for (let i = 0; i < attachments.length; i++) {
        const attachment = attachments[i];
        setProgress({ current: i + 1, total: attachments.length });

        try {
          // Lazy-load content for each attachment
          let b64 = attachment.content;
          if (!b64 && isTauri) {
            const { invoke } = window.__TAURI__.core;
            b64 = await invoke('maildir_read_attachment', {
              accountId: activeAccountId,
              mailbox: activeMailbox,
              uid: emailUid,
              attachmentIndex: attachment._originalIndex,
            });
          }
          if (!b64) continue;

          if (isTauri) {
            const { invoke } = window.__TAURI__.core;
            const base64Content = getCleanBase64(b64);
            await invoke('save_attachment', {
              filename: attachment.filename || `attachment_${i + 1}`,
              contentBase64: base64Content,
              account: account || null,
              folder: folder || null,
            });
          } else {
            browserDownload({ ...attachment, content: b64 });
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
                text-mail-accent hover:bg-mail-accent/20 rounded-lg text-sm
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
          <span>Download All</span>
        </>
      )}
    </button>
  );
}
