import React, { useState, useEffect, useRef } from 'react';
import { useMailStore } from '../stores/mailStore';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';
import { ComposeModal } from './ComposeModal';
import {
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Star,
  MoreHorizontal,
  Paperclip,
  Download,
  Save,
  Archive,
  HardDrive,
  Cloud,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  FileText,
  Mail,
  MailOpen,
  FolderOpen,
  AppWindow,
  Check,
  Code
} from 'lucide-react';

function getRealAttachments(attachments, html) {
  if (!attachments) return [];
  return attachments.filter(att => {
    const type = (att.contentType || '').toLowerCase();
    if (!type.startsWith('image/')) return true;
    // Only hide if the image has a Content-ID that is actually
    // referenced in the HTML body (i.e. embedded via cid:)
    if (att.contentId && html) {
      const cid = att.contentId.replace(/^<|>$/g, '');
      if (html.includes(`cid:${cid}`)) return false;
    }
    // Tracking pixels: tiny unnamed images
    if (!att.filename && att.size && att.size < 5000) return false;
    return true;
  });
}

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

function AttachmentItem({ attachment, account, folder }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [downloadedPath, setDownloadedPath] = useState(null);
  const [justDownloaded, setJustDownloaded] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const isTauri = !!window.__TAURI__;

  const handleDownload = async (e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }

    if (!attachment.content) {
      setError('Attachment content not available');
      setTimeout(() => setError(null), 3000);
      return;
    }

    setDownloading(true);
    setError(null);

    try {
      if (isTauri) {
        const { invoke } = window.__TAURI__.core;
        const base64Content = getCleanBase64(attachment.content);
        const savedPath = await invoke('save_attachment', {
          filename: attachment.filename || 'attachment',
          contentBase64: base64Content,
          account: account || null,
          folder: folder || null,
        });
        setDownloadedPath(savedPath);
        setJustDownloaded(true);
        setTimeout(() => setJustDownloaded(false), 3000);
      } else {
        browserDownload(attachment);
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
    if (!attachment.content || !isTauri) return;

    try {
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
      const base64Content = getCleanBase64(attachment.content);
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

  return (
    <>
      <div
        className={`flex items-center gap-3 p-3 bg-mail-bg rounded-lg border transition-all group cursor-pointer
                   ${error ? 'border-mail-danger' : justDownloaded ? 'border-green-500/50' : 'border-mail-border hover:border-mail-accent/50'}`}
        onClick={downloadedPath && isTauri ? handleOpen : handleDownload}
        onContextMenu={handleContextMenu}
        role="button"
        tabIndex={0}
      >
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${justDownloaded ? 'bg-green-500/10' : 'bg-mail-accent/10'}`}>
          {justDownloaded ? (
            <Check size={20} className="text-green-500" />
          ) : (
            <FileText size={20} className="text-mail-accent" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-mail-text truncate">
            {attachment.filename || 'Unnamed attachment'}
          </div>
          <div className="text-xs text-mail-text-muted">
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
          <div className="w-4 h-4 border-2 border-mail-accent border-t-transparent rounded-full animate-spin" />
        ) : justDownloaded ? (
          <Check size={16} className="text-green-500" />
        ) : downloadedPath ? (
          <ExternalLink
            size={16}
            className="text-mail-text-muted group-hover:text-mail-accent transition-colors"
          />
        ) : (
          <Download
            size={16}
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

function DownloadAllButton({ attachments, account, folder }) {
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const isTauri = !!window.__TAURI__;

  const handleDownloadAll = async () => {
    const validAttachments = attachments.filter(a => a.content);
    if (validAttachments.length === 0) {
      alert('No attachment content available for download');
      return;
    }

    setDownloading(true);
    setProgress({ current: 0, total: validAttachments.length });

    try {
      for (let i = 0; i < validAttachments.length; i++) {
        const attachment = validAttachments[i];
        setProgress({ current: i + 1, total: validAttachments.length });

        try {
          if (isTauri) {
            const { invoke } = window.__TAURI__.core;
            const base64Content = getCleanBase64(attachment.content);
            await invoke('save_attachment', {
              filename: attachment.filename || `attachment_${i + 1}`,
              contentBase64: base64Content,
              account: account || null,
              folder: folder || null,
            });
          } else {
            browserDownload(attachment);
            if (i < validAttachments.length - 1) {
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

function EmailHeader({ email, expanded, onToggle, showRaw, onToggleRaw }) {
  return (
    <div
      className="p-4 border-b border-mail-border cursor-pointer"
      onClick={onToggle}
    >
      <div className="flex items-start gap-4">
        {/* Avatar */}
        <div className="w-10 h-10 bg-mail-accent rounded-full flex items-center justify-center flex-shrink-0">
          <span className="text-white font-semibold text-sm">
            {(email.from?.name || email.from?.address || '?')[0].toUpperCase()}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-mail-text">
              {email.from?.name || email.from?.address || 'Unknown'}
            </span>
            {email.from?.name && (
              <span className="text-sm text-mail-text-muted">
                &lt;{email.from.address}&gt;
              </span>
            )}
          </div>

          <div className="text-sm text-mail-text-muted">
            To: {email.to?.map(t => t.name || t.address).join(', ') || 'Unknown'}
            {email.cc?.length > 0 && (
              <span className="ml-2">
                CC: {email.cc.map(c => c.name || c.address).join(', ')}
              </span>
            )}
          </div>

          <AnimatePresence>
            {expanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="mt-2 text-xs text-mail-text-muted space-y-1 overflow-hidden"
              >
                <div>Date: {format(new Date(email.date), 'PPpp')}</div>
                {email.messageId && <div>Message-ID: {email.messageId}</div>}
                {email.replyTo?.length > 0 && (
                  <div>Reply-To: {email.replyTo.map(r => r.address).join(', ')}</div>
                )}
                {email.rawSource && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleRaw(); }}
                    className={`mt-2 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                               ${showRaw
                                 ? 'bg-mail-accent text-white'
                                 : 'bg-mail-surface hover:bg-mail-surface-hover text-mail-text-muted'}`}
                  >
                    <Code size={12} />
                    {showRaw ? 'Rendered' : 'View Source'}
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex items-center gap-2 text-sm text-mail-text-muted">
          <span>{format(new Date(email.date), 'MMM d, yyyy h:mm a')}</span>
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </div>
    </div>
  );
}

export function EmailViewer() {
  const {
    selectedEmail,
    selectedEmailSource,
    loadingEmail,
    savedEmailIds,
    archivedEmailIds,
    saveEmailLocally,
    removeLocalEmail,
    exportEmail,
    markEmailReadStatus,
    deleteEmailFromServer,
    activeAccountId,
    activeMailbox
  } = useMailStore();

  const [headerExpanded, setHeaderExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [composeMode, setComposeMode] = useState(null);
  const [togglingRead, setTogglingRead] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUnarchive, setConfirmUnarchive] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const iframeRef = useRef(null);
  
  const isCached = selectedEmail && savedEmailIds.has(selectedEmail.uid);
  const isArchived = selectedEmail && archivedEmailIds.has(selectedEmail.uid);
  const isLocalOnly = selectedEmailSource === 'local-only';
  const isRead = selectedEmail?.flags?.includes('\\Seen');

  // Reset view states when switching emails
  useEffect(() => {
    setShowRaw(false);
    setConfirmDelete(false);
    setConfirmUnarchive(false);
  }, [selectedEmail?.uid]);
  
  const handleSave = async () => {
    if (!selectedEmail) return;
    setSaving(true);
    try {
      await saveEmailLocally(selectedEmail.uid);
    } finally {
      setSaving(false);
    }
  };
  
  const handleRemoveLocal = () => {
    if (!selectedEmail) return;
    setConfirmUnarchive(true);
  };

  const confirmRemoveLocal = async () => {
    setConfirmUnarchive(false);
    await removeLocalEmail(selectedEmail.uid);
  };
  
  const handleExport = async () => {
    if (!selectedEmail) return;
    const exported = await exportEmail(selectedEmail.uid);
    if (!exported) return;

    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { invoke } = window.__TAURI__.core;

      const destPath = await save({
        defaultPath: exported.filename,
        title: 'Export Email',
      });
      if (!destPath) return; // user cancelled

      await invoke('save_attachment_to', {
        filename: exported.filename,
        contentBase64: exported.rawBase64,
        destPath,
      });
    } catch (err) {
      console.error('[Export] Save As failed:', err);
    }
  };
  
  const handleToggleReadStatus = async () => {
    if (!selectedEmail || togglingRead) return;
    setTogglingRead(true);
    try {
      await markEmailReadStatus(selectedEmail.uid, !isRead);
    } finally {
      setTogglingRead(false);
    }
  };
  
  const handleDelete = () => {
    if (!selectedEmail || deleting) return;
    setConfirmDelete(true);
  };

  const confirmDeleteEmail = async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await deleteEmailFromServer(selectedEmail.uid);
    } finally {
      setDeleting(false);
    }
  };
  
  // Extract body content from email HTML — strip outer document structure
  // so we don't nest <html>/<body> inside our template
  const getEmailBodyContent = (html) => {
    if (!html) return '';
    // Extract content between <body...> and </body>
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return bodyMatch ? bodyMatch[1] : html;
  };

  // Render email with its original styling on a light background (like Apple Mail)
  // Email HTML is designed for light backgrounds — forcing dark mode breaks formatting
  const iframeContent = selectedEmail?.html ? `
    <!DOCTYPE html>
    <html>
      <head>
        <base target="_blank">
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            padding: 16px;
            background: #ffffff;
            color: #333333;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-size: 14px;
            line-height: 1.6;
          }
          img { max-width: 100%; height: auto; }
          table { max-width: 100% !important; }
        </style>
      </head>
      <body>${getEmailBodyContent(selectedEmail.html)}</body>
    </html>
  ` : '';
  
  // Auto-resize iframe and apply dark mode overrides
  useEffect(() => {
    if (iframeRef.current && selectedEmail?.html) {
      const iframe = iframeRef.current;

      const resizeIframe = () => {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (doc && doc.body) {
            const height = Math.max(
              doc.body.scrollHeight,
              doc.body.offsetHeight,
              doc.documentElement?.scrollHeight || 0,
              doc.documentElement?.offsetHeight || 0
            );
            iframe.style.height = Math.max(height + 32, 300) + 'px';
          }
        } catch (e) {
          console.error('Failed to resize iframe:', e);
        }
      };

      // Intercept link clicks inside iframe and open in system browser
      const interceptLinks = () => {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!doc) return;
          doc.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (link && link.href && !link.href.startsWith('cid:')) {
              e.preventDefault();
              e.stopPropagation();
              const url = link.href;
              // Use Tauri shell plugin to open in system browser
              import('@tauri-apps/plugin-shell').then(({ open }) => {
                open(url);
              }).catch(() => {
                window.open(url, '_blank');
              });
            }
          });
          // Custom context menu (replaces native "Open Frame in New Window" which doesn't work in Tauri)
          doc.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            // Remove any existing custom menu
            const existing = doc.getElementById('mv-ctx-menu');
            if (existing) existing.remove();
            // Build menu
            const menu = doc.createElement('div');
            menu.id = 'mv-ctx-menu';
            menu.style.cssText = 'position:fixed;z-index:99999;background:#ffffff;border:1px solid #d1d5db;border-radius:6px;padding:4px 0;min-width:180px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.15);';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';
            const items = [
              { label: 'Copy', action: () => doc.execCommand('copy') },
              { label: 'Select All', action: () => doc.execCommand('selectAll') },
            ];
            items.forEach(({ label, action }) => {
              const item = doc.createElement('div');
              item.textContent = label;
              item.style.cssText = 'padding:6px 14px;cursor:pointer;color:#333333;';
              item.onmouseover = () => item.style.background = '#f3f4f6';
              item.onmouseout = () => item.style.background = 'none';
              item.onclick = () => { action(); menu.remove(); };
              menu.appendChild(item);
            });
            doc.body.appendChild(menu);
            // Close on click outside
            const close = () => { menu.remove(); doc.removeEventListener('click', close); };
            setTimeout(() => doc.addEventListener('click', close), 0);
          });
        } catch (e) {
          console.error('Failed to intercept iframe links:', e);
        }
      };

      // Resize after load
      iframe.onload = () => {
        interceptLinks();
        resizeIframe();
        setTimeout(resizeIframe, 200);
        setTimeout(resizeIframe, 1000);
      };

      // Initial resize
      setTimeout(resizeIframe, 100);
    }
  }, [selectedEmail?.html]);
  
  if (!selectedEmail && !loadingEmail) {
    return (
      <div className="flex-1 flex items-center justify-center bg-mail-bg h-full min-h-0">
        <div className="text-center text-mail-text-muted">
          <FileText size={48} className="mx-auto mb-4 opacity-30" />
          <p>Select an email to read</p>
        </div>
      </div>
    );
  }

  if (loadingEmail) {
    return (
      <div className="flex-1 flex items-center justify-center bg-mail-bg h-full min-h-0">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
          className="w-8 h-8 border-2 border-mail-accent border-t-transparent rounded-full"
        />
      </div>
    );
  }
  
  return (
    <div className="flex-1 flex flex-col bg-mail-bg overflow-hidden min-h-0 h-full relative">
      {/* Toolbar */}
      <div data-tauri-drag-region className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setComposeMode('reply')}
            className="p-2 hover:bg-mail-surface rounded-lg transition-colors" 
            title="Reply"
          >
            <Reply size={18} className="text-mail-text-muted" />
          </button>
          <button 
            onClick={() => setComposeMode('replyAll')}
            className="p-2 hover:bg-mail-surface rounded-lg transition-colors" 
            title="Reply All"
          >
            <ReplyAll size={18} className="text-mail-text-muted" />
          </button>
          <button
            onClick={() => setComposeMode('forward')}
            className="p-2 hover:bg-mail-surface rounded-lg transition-colors"
            title="Forward"
          >
            <Forward size={18} className="text-mail-text-muted" />
          </button>

          {selectedEmail?.html && (
            <>
              <div className="w-px h-6 bg-mail-border mx-2" />
              <button
                onClick={() => {
                  const invoke = window.__TAURI__?.core?.invoke;
                  if (!invoke) return;
                  invoke('open_email_window', {
                    html: iframeContent,
                    title: selectedEmail.subject || 'Email',
                  });
                }}
                className="p-2 hover:bg-mail-surface rounded-lg transition-colors"
                title="Open in New Window"
              >
                <ExternalLink size={18} className="text-mail-text-muted" />
              </button>
            </>
          )}

          {/* Server-only actions - hidden for local-only emails */}
          {!isLocalOnly && (
            <>
              <div className="w-px h-6 bg-mail-border mx-2" />
              <button 
                onClick={handleToggleReadStatus}
                disabled={togglingRead}
                className="p-2 hover:bg-mail-surface rounded-lg transition-colors disabled:opacity-50" 
                title={isRead ? "Mark as unread" : "Mark as read"}
              >
                {isRead ? (
                  <Mail size={18} className="text-mail-text-muted" />
                ) : (
                  <MailOpen size={18} className="text-mail-text-muted" />
                )}
              </button>
              <button 
                onClick={handleDelete}
                disabled={deleting}
                className="p-2 hover:bg-mail-surface rounded-lg transition-colors disabled:opacity-50"
                title="Delete"
              >
                <Trash2 size={18} className="text-mail-text-muted" />
              </button>
            </>
          )}
        </div>
        
        <div className="flex items-center gap-2">
          {/* Storage indicator */}
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm
                          ${isLocalOnly
                            ? 'bg-mail-warning/10 text-mail-warning'
                            : isArchived
                              ? 'bg-mail-local/10 text-mail-local'
                              : 'bg-mail-server/10 text-mail-server'}`}>
            {isLocalOnly ? (
              <>
                <HardDrive size={14} />
                <span>Local only</span>
              </>
            ) : isArchived ? (
              <>
                <HardDrive size={14} />
                <span>Archived</span>
              </>
            ) : (
              <>
                <Cloud size={14} />
                <span>Server</span>
              </>
            )}
          </div>

          {isLocalOnly ? (
            <>
              <button
                onClick={handleRemoveLocal}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-mail-danger/10
                          text-mail-danger hover:bg-mail-danger/20 rounded-lg text-sm transition-colors"
              >
                <Trash2 size={14} />
                Delete
              </button>
              <button
                onClick={handleExport}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-mail-surface
                          hover:bg-mail-surface-hover rounded-lg text-sm transition-colors"
              >
                <Download size={14} />
                Export
              </button>
            </>
          ) : isArchived ? (
            <>
              <button
                onClick={handleRemoveLocal}
                className="flex items-center gap-1.5 px-3 py-1.5 text-mail-text-muted
                          hover:bg-mail-surface-hover rounded-lg text-sm transition-colors"
              >
                <Archive size={14} />
                Unarchive
              </button>
              <button
                onClick={handleExport}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-mail-surface
                          hover:bg-mail-surface-hover rounded-lg text-sm transition-colors"
              >
                <Download size={14} />
                Export
              </button>
            </>
          ) : (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-mail-local/10
                        text-mail-local hover:bg-mail-local/20 rounded-lg text-sm
                        font-medium transition-colors disabled:opacity-50"
            >
              <Archive size={14} />
              {saving ? 'Archiving...' : 'Archive'}
            </button>
          )}
        </div>
      </div>
      
      {/* Subject */}
      <div className="px-4 py-4 border-b border-mail-border">
        <h1 className="text-xl font-semibold text-mail-text">
          {selectedEmail.subject}
        </h1>
      </div>
      
      {/* Header */}
      <EmailHeader
        email={selectedEmail}
        expanded={headerExpanded}
        onToggle={() => setHeaderExpanded(!headerExpanded)}
        showRaw={showRaw}
        onToggleRaw={() => setShowRaw(r => !r)}
      />
      
      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="p-4">
          {showRaw && selectedEmail.rawSource ? (
            <pre className="text-xs font-mono text-mail-text bg-mail-surface rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-all">
              {atob(selectedEmail.rawSource)}
            </pre>
          ) : selectedEmail.html ? (
            <div className="rounded-lg overflow-hidden bg-white">
              <iframe
                ref={iframeRef}
                srcDoc={iframeContent}
                className="w-full border-0"
                style={{ minHeight: '300px', display: 'block' }}
                sandbox="allow-same-origin allow-popups"
                title="Email content"
              />
            </div>
          ) : (
            <div className="email-content whitespace-pre-wrap text-mail-text">
              {selectedEmail.text || 'No content'}
            </div>
          )}
        </div>
        
        {/* Attachments */}
        {(() => {
          const realAttachments = getRealAttachments(selectedEmail.attachments, selectedEmail.html);
          return realAttachments.length > 0 && (
            <div className="p-4 border-t border-mail-border">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-sm text-mail-text-muted">
                  <Paperclip size={14} />
                  <span>{realAttachments.length} Attachment{realAttachments.length !== 1 ? 's' : ''}</span>
                </div>
                {realAttachments.length > 1 && (
                  <DownloadAllButton attachments={realAttachments} account={activeAccountId} folder={activeMailbox} />
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {realAttachments.map((attachment, index) => (
                  <AttachmentItem key={index} attachment={attachment} account={activeAccountId} folder={activeMailbox} />
                ))}
              </div>
            </div>
          );
        })()}
      </div>
      
      {/* Compose Modal */}
      <AnimatePresence>
        {composeMode && (
          <ComposeModal
            mode={composeMode}
            replyTo={selectedEmail}
            onClose={() => setComposeMode(null)}
          />
        )}
      </AnimatePresence>

      {/* Delete Confirmation */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/40 flex items-center justify-center z-50"
            onClick={() => setConfirmDelete(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-mail-surface border border-mail-border rounded-xl p-6 shadow-xl max-w-sm mx-4"
            >
              <h3 className="text-lg font-semibold text-mail-text mb-2">Delete email?</h3>
              <p className="text-sm text-mail-text-muted mb-4">
                {isArchived
                  ? 'This email is archived locally. Deleting from server will keep the archived copy.'
                  : 'This email will be permanently deleted from the server.'}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-4 py-2 text-sm text-mail-text bg-mail-bg border border-mail-border
                            rounded-lg hover:bg-mail-surface-hover transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDeleteEmail}
                  className="px-4 py-2 text-sm text-white bg-red-600 rounded-lg
                            hover:bg-red-700 transition-colors"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Unarchive / Delete Local Confirmation */}
      <AnimatePresence>
        {confirmUnarchive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/40 flex items-center justify-center z-50"
            onClick={() => setConfirmUnarchive(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-mail-surface border border-mail-border rounded-xl p-6 shadow-xl max-w-sm mx-4"
            >
              <h3 className="text-lg font-semibold text-mail-text mb-2">
                {isLocalOnly ? 'Delete email?' : 'Unarchive email?'}
              </h3>
              <p className="text-sm text-mail-text-muted mb-4">
                {isLocalOnly
                  ? 'This email only exists in your local archive. Deleting it is permanent and cannot be undone.'
                  : 'The cached copy will be removed. The email will still be available on the server.'}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmUnarchive(false)}
                  className="px-4 py-2 text-sm text-mail-text bg-mail-bg border border-mail-border
                            rounded-lg hover:bg-mail-surface-hover transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmRemoveLocal}
                  className="px-4 py-2 text-sm text-white bg-red-600 rounded-lg
                            hover:bg-red-700 transition-colors"
                >
                  {isLocalOnly ? 'Delete' : 'Unarchive'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
