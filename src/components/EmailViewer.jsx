import React, { useState, useEffect, useRef } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useThemeStore } from '../stores/themeStore';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';
import { ComposeModal } from './ComposeModal';
import {
  X,
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Star,
  MoreHorizontal,
  Paperclip,
  Download,
  Save,
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
        const { invoke } = window.__TAURI__.tauri;
        const base64Content = getCleanBase64(attachment.content);
        const savedPath = await invoke('save_attachment', {
          filename: attachment.filename || 'attachment',
          contentBase64: base64Content,
          account: account || null,
          folder: folder || null,
        });
        setDownloadedPath(savedPath);
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
      const { save } = window.__TAURI__.dialog;
      const { invoke } = window.__TAURI__.tauri;
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
        const { invoke } = window.__TAURI__.tauri;
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
        const { invoke } = window.__TAURI__.tauri;
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
        const { invoke } = window.__TAURI__.tauri;
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
                   ${error ? 'border-mail-danger' : downloadedPath ? 'border-green-500/50' : 'border-mail-border hover:border-mail-accent/50'}`}
        onClick={downloadedPath && isTauri ? handleOpen : handleDownload}
        onContextMenu={handleContextMenu}
        role="button"
        tabIndex={0}
      >
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${downloadedPath ? 'bg-green-500/10' : 'bg-mail-accent/10'}`}>
          {downloadedPath ? (
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
            ) : downloadedPath ? (
              <span className="text-green-500">Downloaded</span>
            ) : (
              formatSize(attachment.size)
            )}
          </div>
        </div>
        {downloading ? (
          <div className="w-4 h-4 border-2 border-mail-accent border-t-transparent rounded-full animate-spin" />
        ) : downloadedPath ? (
          <Check size={16} className="text-green-500" />
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
            const { invoke } = window.__TAURI__.tauri;
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
    saveEmailLocally,
    removeLocalEmail,
    exportEmail,
    markEmailReadStatus,
    deleteEmailFromServer,
    activeAccountId,
    activeMailbox
  } = useMailStore();

  const { theme } = useThemeStore();
  
  const [headerExpanded, setHeaderExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [composeMode, setComposeMode] = useState(null);
  const [togglingRead, setTogglingRead] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const iframeRef = useRef(null);
  
  const isLocal = selectedEmail && savedEmailIds.has(selectedEmail.uid);
  const isLocalOnly = selectedEmailSource === 'local-only';
  const isRead = selectedEmail?.flags?.includes('\\Seen');

  // Reset raw view when switching emails
  useEffect(() => {
    setShowRaw(false);
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
  
  const handleRemoveLocal = async () => {
    if (!selectedEmail) return;
    
    const confirmed = confirm(
      isLocalOnly 
        ? 'This email only exists in your local storage.\n\nDeleting it will permanently remove it and cannot be undone.\n\nAre you sure you want to delete this email?'
        : 'Remove this email from local storage?\n\nThe email will still be available on the server.'
    );
    
    if (!confirmed) return;
    
    await removeLocalEmail(selectedEmail.uid);
  };
  
  const handleExport = async () => {
    if (!selectedEmail) return;
    const exported = await exportEmail(selectedEmail.uid);
    if (exported) {
      const blob = new Blob([exported.content], { type: exported.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exported.filename;
      a.click();
      URL.revokeObjectURL(url);
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
  
  const handleDelete = async () => {
    if (!selectedEmail || deleting) return;
    
    if (isLocal) {
      // Email exists on server AND locally
      const confirmed = confirm(
        'This email is saved locally and exists on the server.\n\n' +
        'Deleting from server will keep the local copy.\n\n' +
        'Are you sure you want to delete this email from the server?'
      );
      if (!confirmed) return;
    } else {
      // Email only on server
      if (!confirm('Are you sure you want to delete this email?')) return;
    }
    
    setDeleting(true);
    try {
      await deleteEmailFromServer(selectedEmail.uid);
    } finally {
      setDeleting(false);
    }
  };
  
  // Build HTML content for iframe with dark mode support
  const isDarkMode = theme === 'dark';
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
            background: ${isDarkMode ? '#1a1a2e' : '#ffffff'} !important;
            color: ${isDarkMode ? '#e2e8f0' : '#333333'};
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-size: 14px;
            line-height: 1.6;
          }
          a { color: #6366f1; }
          img { max-width: 100%; height: auto; }
          table { max-width: 100% !important; }

          /* Dark mode adjustments */
          ${isDarkMode ? `
            /* Invert common light backgrounds in emails */
            div[style*="background-color: #fff"],
            div[style*="background-color: white"],
            div[style*="background-color:#fff"],
            div[style*="background-color:#ffffff"],
            td[style*="background-color: #fff"],
            td[style*="background-color: white"],
            td[style*="background-color:#fff"],
            td[style*="background-color:#ffffff"] {
              background-color: #1a1a2e !important;
            }

            /* Force text colors for readability */
            div[style*="color: #000"],
            div[style*="color:#000"],
            div[style*="color: black"],
            span[style*="color: #000"],
            span[style*="color:#000"],
            span[style*="color: black"],
            p[style*="color: #000"],
            p[style*="color:#000"],
            p[style*="color: black"],
            td[style*="color: #000"],
            td[style*="color:#000"],
            td[style*="color: black"] {
              color: #e2e8f0 !important;
            }

            /* Handle blockquotes */
            blockquote {
              border-left: 3px solid #4a5568;
              padding-left: 12px;
              margin-left: 0;
              color: #a0aec0;
            }

            /* Handle code blocks */
            pre, code {
              background: #2d3748 !important;
              color: #e2e8f0 !important;
            }

            /* Handle horizontal rules */
            hr {
              border-color: #4a5568;
            }
          ` : ''}
        </style>
      </head>
      <body>${selectedEmail.html}</body>
    </html>
  ` : '';
  
  // Auto-resize iframe to content height
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
      
      // Resize after load
      iframe.onload = () => {
        resizeIframe();
        setTimeout(resizeIframe, 200);
        setTimeout(resizeIframe, 1000);
      };
      
      // Initial resize
      setTimeout(resizeIframe, 100);
    }
  }, [selectedEmail?.html, theme]);
  
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
    <div className="flex-1 flex flex-col bg-mail-bg overflow-hidden min-h-0 h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
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
          {/* Local storage indicator */}
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm
                          ${isLocalOnly 
                            ? 'bg-mail-warning/10 text-mail-warning' 
                            : isLocal 
                              ? 'bg-mail-local/10 text-mail-local' 
                              : 'bg-mail-server/10 text-mail-server'}`}>
            {isLocalOnly ? (
              <>
                <HardDrive size={14} />
                <span>Local only</span>
              </>
            ) : isLocal ? (
              <>
                <HardDrive size={14} />
                <span>Saved locally</span>
              </>
            ) : (
              <>
                <Cloud size={14} />
                <span>Server only</span>
              </>
            )}
          </div>
          
          {isLocalOnly ? (
            <>
              <button
                onClick={handleExport}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-mail-surface 
                          hover:bg-mail-surface-hover rounded-lg text-sm transition-colors"
              >
                <Download size={14} />
                Export
              </button>
              <button
                onClick={handleRemoveLocal}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-mail-danger/10
                          text-mail-danger hover:bg-mail-danger/20 rounded-lg text-sm transition-colors"
              >
                <Trash2 size={14} />
                Delete
              </button>
            </>
          ) : isLocal ? (
            <>
              <button
                onClick={handleExport}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-mail-surface 
                          hover:bg-mail-surface-hover rounded-lg text-sm transition-colors"
              >
                <Download size={14} />
                Export
              </button>
              <button
                onClick={handleRemoveLocal}
                className="flex items-center gap-1.5 px-3 py-1.5 text-mail-text-muted
                          hover:bg-mail-surface-hover rounded-lg text-sm transition-colors"
              >
                <X size={14} />
                Remove local
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
              <Save size={14} />
              {saving ? 'Saving...' : 'Save Locally'}
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
            <div className={`rounded-lg overflow-hidden ${isDarkMode ? 'bg-[#1a1a2e]' : 'bg-white'}`}>
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
    </div>
  );
}
