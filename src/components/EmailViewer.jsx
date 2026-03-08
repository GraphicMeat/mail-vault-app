import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useShallow } from 'zustand/react/shallow';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';
import { ComposeModal } from './ComposeModal';
import { useChatBodyLoader, emailKey } from '../hooks/useChatBodyLoader';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../utils/iframeQuoteFolding';
import { splitQuotedContent } from '../utils/quoteFolding';
import { splitSignature, hashSignature } from '../utils/signatureFolding';
import { useSettingsStore } from '../stores/settingsStore';
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
  Code,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle
} from 'lucide-react';
import { getRealAttachments, replaceCidUrls } from '../services/attachmentUtils';
import { checkSenderVerification } from '../utils/senderCheck';

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

  const activeAccountId = useMailStore(s => s.activeAccountId);
  const activeMailbox = useMailStore(s => s.activeMailbox);

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

function DownloadAllButton({ attachments, emailUid, account, folder }) {
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const isTauri = !!window.__TAURI__;

  const activeAccountId = useMailStore(s => s.activeAccountId);
  const activeMailbox = useMailStore(s => s.activeMailbox);

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

function EmailHeader({ email, expanded, onToggle, showRaw, onToggleRaw, loadingRaw }) {
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
            <SenderVerificationBadge email={email} />
            {email.from?.name && (
              <span className="text-sm text-mail-text-muted">
                &lt;{email.from.address}&gt;
              </span>
            )}
          </div>

          <div className="text-sm text-mail-text-muted">
            To: {(Array.isArray(email.to) ? email.to : []).map(t => t.name || t.address).join(', ') || 'Unknown'}
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
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleRaw(); }}
                  disabled={loadingRaw}
                  className={`mt-2 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                             ${showRaw
                               ? 'bg-mail-accent text-white'
                               : 'bg-mail-surface hover:bg-mail-surface-hover text-mail-text-muted'}
                             disabled:opacity-50`}
                >
                  {loadingRaw ? (
                    <RefreshCw size={12} className="animate-spin" />
                  ) : (
                    <Code size={12} />
                  )}
                  {loadingRaw ? 'Loading...' : showRaw ? 'Rendered' : 'View Source'}
                </button>
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

// ── Sender Verification Badge ────────────────────────────────────────────────

function SenderVerificationBadge({ email, size = 14 }) {
  const { status, tooltip } = useMemo(
    () => checkSenderVerification(email),
    [email?.from, email?.replyTo, email?.returnPath, email?.authenticationResults]
  );

  if (status === 'none') return null;

  if (status === 'verified') {
    return (
      <span className="inline-flex items-center text-green-500 flex-shrink-0" title={tooltip}>
        <ShieldCheck size={size} />
      </span>
    );
  }

  if (status === 'warning') {
    return (
      <span className="inline-flex items-center text-orange-500 flex-shrink-0" title={tooltip}>
        <AlertTriangle size={size} />
      </span>
    );
  }

  if (status === 'danger') {
    return (
      <span className="inline-flex items-center text-red-500 flex-shrink-0" title={tooltip}>
        <ShieldAlert size={size} />
      </span>
    );
  }

  return null;
}

// ── Thread Email Item (one email in a thread conversation view) ──────────────

function ThreadEmailItemContent({ email, loadedEmail, isLoading, signatureDisplay, shouldShowSignature }) {
  const iframeRef = useRef(null);
  const [quotesExpanded, setQuotesExpanded] = useState(false);
  const [sigExpanded, setSigExpanded] = useState(false);

  const { newContent, quotedContent } = useMemo(
    () => splitQuotedContent(loadedEmail?.text || loadedEmail?.textBody || ''),
    [loadedEmail?.text, loadedEmail?.textBody]
  );

  // Split signature from the plain text content (after quote splitting)
  const { body: bodyWithoutSig, signature } = useMemo(
    () => splitSignature(newContent),
    [newContent]
  );

  // Determine if signature should be shown inline
  const showSigInline = signatureDisplay === 'always-show'
    || (signatureDisplay === 'smart' && shouldShowSignature);

  const iframeContent = useMemo(() => {
    if (!loadedEmail?.html) return '';
    const htmlWithCid = replaceCidUrls(loadedEmail.html, loadedEmail.attachments);
    const bodyMatch = htmlWithCid.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : htmlWithCid;
    return `
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
            overflow-x: hidden;
            max-width: 100%;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-size: 14px;
            line-height: 1.6;
            word-wrap: break-word;
            overflow-wrap: break-word;
          }
          img { max-width: 100%; height: auto; }
          table { max-width: 100% !important; width: auto !important; }
          pre, code { white-space: pre-wrap; max-width: 100%; overflow-wrap: break-word; }
        </style>
      </head>
      <body>${bodyHtml}${getQuoteFoldingScript()}${getSignatureFoldingScript(signatureDisplay)}</body>
    </html>
  `;
  }, [loadedEmail?.html, signatureDisplay]);

  // Auto-resize iframe and intercept links
  useEffect(() => {
    if (!iframeRef.current || !loadedEmail?.html) return;

    const iframe = iframeRef.current;
    let resizeTimers = [];

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
          iframe.style.height = Math.max(height + 32, 100) + 'px';
        }
      } catch (e) {
        console.error('Failed to resize thread iframe:', e);
      }
    };

    const handleClick = (e) => {
      const link = e.target.closest('a');
      if (link && link.href && !link.href.startsWith('cid:')) {
        e.preventDefault();
        e.stopPropagation();
        import('@tauri-apps/plugin-shell').then(({ open }) => {
          open(link.href);
        }).catch(() => {
          window.open(link.href, '_blank');
        });
      }
    };

    const onLoad = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) doc.addEventListener('click', handleClick);
      } catch (e) {}
      resizeIframe();
      resizeTimers.push(setTimeout(resizeIframe, 200));
      resizeTimers.push(setTimeout(resizeIframe, 1000));
    };

    const handleMessage = (e) => {
      if (e.data?.type === 'iframe-resize' && e.data.height && iframeRef.current) {
        iframeRef.current.style.height = Math.max(e.data.height + 32, 100) + 'px';
      }
    };
    window.addEventListener('message', handleMessage);

    iframe.addEventListener('load', onLoad);
    resizeTimers.push(setTimeout(resizeIframe, 100));

    return () => {
      iframe.removeEventListener('load', onLoad);
      window.removeEventListener('message', handleMessage);
      resizeTimers.forEach(t => clearTimeout(t));
    };
  }, [loadedEmail?.html]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-5 h-5 border-2 border-mail-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!loadedEmail) {
    return (
      <div className="py-4 text-sm text-mail-text-muted">
        Could not load email content
      </div>
    );
  }

  return (
    <>
      {loadedEmail.html ? (
        <div className="rounded-lg overflow-hidden bg-white mt-2 max-w-full">
          <iframe
            ref={iframeRef}
            srcDoc={iframeContent}
            className="w-full border-0"
            style={{ minHeight: '100px', display: 'block', maxWidth: '100%' }}
            sandbox="allow-same-origin allow-popups allow-scripts"
            title={`Email from ${email.from?.name || email.from?.address}`}
          />
        </div>
      ) : (
        <div className="email-content whitespace-pre-wrap text-mail-text mt-2 text-sm break-words overflow-hidden">
          {bodyWithoutSig || 'No content'}
          {signature && signatureDisplay !== 'always-hide' && (
            showSigInline
              ? (
                <div className="mt-2 text-mail-text-muted text-xs whitespace-pre-wrap opacity-60">
                  {signature}
                </div>
              )
              : (
                <>
                  <button
                    onClick={() => setSigExpanded(prev => !prev)}
                    className="block mt-2 text-xs text-mail-text-muted hover:text-mail-accent cursor-pointer select-none"
                  >
                    {sigExpanded ? '\u25BE Hide signature' : '\u2014 Show signature'}
                  </button>
                  {sigExpanded && (
                    <div className="mt-1 text-mail-text-muted text-xs whitespace-pre-wrap opacity-60">
                      {signature}
                    </div>
                  )}
                </>
              )
          )}
          {quotedContent && (
            <>
              <button
                onClick={() => setQuotesExpanded(prev => !prev)}
                className="block mt-2 text-xs text-mail-text-muted hover:text-mail-accent bg-mail-surface border border-mail-border rounded px-2 py-0.5 cursor-pointer select-none"
              >
                {quotesExpanded ? '\u25BE Hide quoted text' : '\u22EF'}
              </button>
              {quotesExpanded && (
                <div className="mt-1 text-mail-text-muted border-l-2 border-mail-border pl-3">
                  {quotedContent}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

function ThreadEmailItem({ email, bodiesMapRef, registerListener, isLast, activeAccountId, activeMailbox, archivedEmailIds, signatureDisplay, shouldShowSignature }) {
  const [expanded, setExpanded] = useState(isLast);
  const [, forceUpdate] = useState(0);
  const [composeMode, setComposeMode] = useState(null);
  const [headerExpanded, setHeaderExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [rawSource, setRawSource] = useState(null);
  const [loadingRaw, setLoadingRaw] = useState(false);
  const key = emailKey(email);

  // Register for body load notifications
  useEffect(() => {
    return registerListener(key, () => forceUpdate(n => n + 1));
  }, [key, registerListener]);

  const bodyEntry = bodiesMapRef.current.get(key);
  const loadedEmail = bodyEntry?.status === 'loaded' ? bodyEntry.email : null;
  const isLoading = bodyEntry?.status === 'loading';

  const realAttachments = loadedEmail ? getRealAttachments(loadedEmail.attachments, loadedEmail.html) : [];

  return (
    <div className={`border-b border-mail-border overflow-hidden ${expanded ? '' : 'hover:bg-mail-surface-hover'}`} style={{ contain: 'inline-size' }}>
      {/* Header — always visible */}
      <div
        className="flex items-start gap-2 px-3 py-2.5 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Avatar */}
        <div className="w-7 h-7 bg-mail-accent rounded-full flex items-center justify-center flex-shrink-0">
          <span className="text-white font-semibold text-[11px]">
            {(email.from?.name || email.from?.address || '?')[0].toUpperCase()}
          </span>
        </div>

        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {email.source === 'local-only' ? (
                <HardDrive size={12} className="text-mail-warning flex-shrink-0" title="Local only" />
              ) : archivedEmailIds?.has(email.uid) ? (
                <HardDrive size={12} className="text-mail-local flex-shrink-0" title="Archived" />
              ) : (
                <Cloud size={12} className="flex-shrink-0" style={{ color: 'rgba(59, 130, 246, 0.5)' }} title="Server" />
              )}
              <span className="font-semibold text-sm text-mail-text truncate">
                {email.from?.name || email.from?.address || 'Unknown'}
              </span>
              <SenderVerificationBadge email={email} />
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-[11px] text-mail-text-muted">
                {format(new Date(email.date), 'MMM d, h:mm a')}
              </span>
              {expanded ? <ChevronUp size={14} className="text-mail-text-muted" /> : <ChevronDown size={14} className="text-mail-text-muted" />}
            </div>
          </div>
          {!expanded && (
            <p className="text-xs text-mail-text-muted truncate mt-0.5">
              {loadedEmail?.text?.substring(0, 200) || email.subject || ''}
            </p>
          )}
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 overflow-hidden" style={{ contain: 'inline-size' }}>
          {/* To/CC line */}
          <div className="text-xs text-mail-text-muted mb-2 pl-9">
            <div>
              To: {(Array.isArray(email.to) ? email.to : []).map(t => t.name || t.address).join(', ') || 'Unknown'}
              {email.cc?.length > 0 && (
                <span className="ml-2">CC: {email.cc.map(c => c.name || c.address).join(', ')}</span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); setHeaderExpanded(!headerExpanded); }}
                className="ml-2 text-mail-accent hover:underline"
              >
                {headerExpanded ? 'Less' : 'More'}
              </button>
            </div>
            <AnimatePresence>
              {headerExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="mt-1 space-y-0.5 overflow-hidden"
                >
                  <div>Date: {format(new Date(email.date), 'PPpp')}</div>
                  {email.messageId && <div className="break-all">Message-ID: {email.messageId}</div>}
                  {email.replyTo?.length > 0 && (
                    <div>Reply-To: {email.replyTo.map(r => r.address || r).join(', ')}</div>
                  )}
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (showRaw) { setShowRaw(false); return; }
                      if (!rawSource) {
                        setLoadingRaw(true);
                        try {
                          const isTauri = !!window.__TAURI__;
                          if (isTauri) {
                            const { invoke } = window.__TAURI__.core;
                            const b64 = await invoke('maildir_read_raw_source', {
                              accountId: activeAccountId,
                              mailbox: activeMailbox,
                              uid: email.uid,
                            });
                            setRawSource(b64);
                          }
                        } catch (err) {
                          console.error('[ThreadEmailItem] Failed to load raw source:', err);
                        } finally {
                          setLoadingRaw(false);
                        }
                      }
                      setShowRaw(true);
                    }}
                    disabled={loadingRaw}
                    className={`mt-1 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                               ${showRaw
                                 ? 'bg-mail-accent text-white'
                                 : 'bg-mail-surface hover:bg-mail-surface-hover text-mail-text-muted'}
                               disabled:opacity-50`}
                  >
                    {loadingRaw ? <RefreshCw size={12} className="animate-spin" /> : <Code size={12} />}
                    {loadingRaw ? 'Loading...' : showRaw ? 'Rendered' : 'View Source'}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Body */}
          <div className="pl-9 overflow-hidden" style={{ contain: 'inline-size' }}>
            {showRaw && rawSource ? (
              <pre className="text-xs font-mono text-mail-text bg-mail-surface rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-all">
                {atob(rawSource)}
              </pre>
            ) : (
              <ThreadEmailItemContent email={email} loadedEmail={loadedEmail} isLoading={isLoading} signatureDisplay={signatureDisplay} shouldShowSignature={shouldShowSignature} />
            )}
          </div>

          {/* Attachments */}
          {realAttachments.length > 0 && (
            <div className="mt-3 pl-9">
              <div className="flex items-center gap-2 text-xs text-mail-text-muted mb-2">
                <Paperclip size={12} />
                <span>{realAttachments.length} Attachment{realAttachments.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {realAttachments.map((attachment, index) => (
                  <AttachmentItem
                    key={index}
                    attachment={attachment}
                    attachmentIndex={attachment._originalIndex}
                    emailUid={email.uid}
                    account={activeAccountId}
                    folder={activeMailbox}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Reply actions */}
          <div className="flex items-center gap-2 mt-3 pl-9">
            <button
              onClick={(e) => { e.stopPropagation(); setComposeMode('reply'); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-mail-text-muted
                        bg-mail-surface hover:bg-mail-surface-hover rounded-lg border border-mail-border transition-colors"
            >
              <Reply size={14} />
              Reply
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setComposeMode('replyAll'); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-mail-text-muted
                        bg-mail-surface hover:bg-mail-surface-hover rounded-lg border border-mail-border transition-colors"
            >
              <ReplyAll size={14} />
              Reply All
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setComposeMode('forward'); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-mail-text-muted
                        bg-mail-surface hover:bg-mail-surface-hover rounded-lg border border-mail-border transition-colors"
            >
              <Forward size={14} />
              Forward
            </button>
          </div>
        </div>
      )}

      {/* Compose Modal for this email */}
      <AnimatePresence>
        {composeMode && (
          <ComposeModal
            mode={composeMode}
            replyTo={loadedEmail || email}
            onClose={() => setComposeMode(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Thread View (shows all emails in a thread) ──────────────────────────────

function ThreadView({ thread }) {
  const { activeAccountId, activeMailbox, savedEmailIds, archivedEmailIds, saveEmailsLocally } = useMailStore(
    useShallow(s => ({ activeAccountId: s.activeAccountId, activeMailbox: s.activeMailbox, savedEmailIds: s.savedEmailIds, archivedEmailIds: s.archivedEmailIds, saveEmailsLocally: s.saveEmailsLocally }))
  );
  const signatureDisplay = useSettingsStore(s => s.signatureDisplay);
  const threadSortOrder = useSettingsStore(s => s.threadSortOrder);
  const [saving, setSaving] = useState(false);
  const scrollContainerRef = useRef(null);
  const lastEmailRef = useRef(null);

  // Sort emails by user preference (oldest-first or newest-first)
  const sortedEmails = useMemo(() =>
    [...thread.emails].sort((a, b) =>
      threadSortOrder === 'newest-first'
        ? new Date(b.date) - new Date(a.date)
        : new Date(a.date) - new Date(b.date)
    ),
    [thread.emails, threadSortOrder]
  );

  const { bodiesMapRef, registerListener } = useChatBodyLoader(sortedEmails);

  // Smart mode: track seen signatures per sender to show only first occurrence
  const sigVisMap = useMemo(() => {
    if (signatureDisplay !== 'smart') return {};
    const seenBySender = {};
    const result = {};
    for (const email of sortedEmails) {
      const sender = email.from?.address || '';
      const body = bodiesMapRef.current?.get(emailKey(email));
      const text = body?.email?.text || body?.email?.textBody || '';
      const { signature } = splitSignature(text);
      const sigHash = hashSignature(signature);

      if (!seenBySender[sender]) seenBySender[sender] = new Set();

      if (!signature || !sigHash) {
        result[email.uid] = true;
      } else if (!seenBySender[sender].has(sigHash)) {
        seenBySender[sender].add(sigHash);
        result[email.uid] = true; // first occurrence — show
      } else {
        result[email.uid] = false; // duplicate — collapse
      }
    }
    return result;
  }, [sortedEmails, signatureDisplay]);

  // Scroll to the newest (last) email on mount — scoped to the scroll container
  const threadId = thread.threadId;
  useEffect(() => {
    const timer = setTimeout(() => {
      if (lastEmailRef.current && scrollContainerRef.current) {
        const container = scrollContainerRef.current;
        const el = lastEmailRef.current;
        container.scrollTop = el.offsetTop;
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [threadId]);

  const allArchived = thread.emails.every(e => archivedEmailIds.has(e.uid));

  const handleArchiveThread = async () => {
    setSaving(true);
    try {
      const uids = thread.emails.filter(em => !archivedEmailIds.has(em.uid)).map(em => em.uid);
      if (uids.length > 0) await saveEmailsLocally(uids);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-mail-bg overflow-hidden min-h-0 min-w-0 h-full">
      {/* Thread header */}
      <div data-tauri-drag-region className="flex items-center justify-between px-3 py-2.5 border-b border-mail-border">
        <div className="flex flex-col justify-center flex-1 min-w-0 min-h-[34px]">
          <h1 className="text-sm font-semibold text-mail-text truncate">
            {thread.subject}
          </h1>
          <span className="text-xs text-mail-text-muted">
            {thread.messageCount} message{thread.messageCount !== 1 ? 's' : ''} in thread
          </span>
        </div>

        {!allArchived && (
          <button
            onClick={handleArchiveThread}
            disabled={saving}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm
                      font-medium transition-colors disabled:opacity-50 ml-2 text-mail-local"
            style={{ backgroundColor: 'color-mix(in srgb, var(--mail-local) 10%, transparent)' }}
            onMouseEnter={e => e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--mail-local) 20%, transparent)'}
            onMouseLeave={e => e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--mail-local) 10%, transparent)'}
          >
            <Archive size={14} />
            {saving ? 'Archiving...' : 'Archive All'}
          </button>
        )}
      </div>

      {/* Thread emails — w-0 min-w-full prevents children from expanding container beyond viewport */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 w-full" style={{ contain: 'inline-size' }}>
        {sortedEmails.map((email, idx) => {
          const isLast = idx === sortedEmails.length - 1;
          return (
            <div key={emailKey(email)} ref={isLast ? lastEmailRef : undefined} className="w-full overflow-hidden" style={{ contain: 'inline-size' }}>
              <ThreadEmailItem
                email={email}
                bodiesMapRef={bodiesMapRef}
                registerListener={registerListener}
                isLast={isLast}
                activeAccountId={activeAccountId}
                activeMailbox={activeMailbox}
                archivedEmailIds={archivedEmailIds}
                signatureDisplay={signatureDisplay}
                shouldShowSignature={sigVisMap[email.uid] !== false}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Single Email Viewer ─────────────────────────────────────────────────────

export function EmailViewer() {
  const selectedEmail = useMailStore(s => s.selectedEmail);
  const selectedEmailSource = useMailStore(s => s.selectedEmailSource);
  const selectedThread = useMailStore(s => s.selectedThread);
  const loadingEmail = useMailStore(s => s.loadingEmail);
  const savedEmailIds = useMailStore(s => s.savedEmailIds);
  const archivedEmailIds = useMailStore(s => s.archivedEmailIds);
  const saveEmailLocally = useMailStore(s => s.saveEmailLocally);
  const removeLocalEmail = useMailStore(s => s.removeLocalEmail);
  const exportEmail = useMailStore(s => s.exportEmail);
  const markEmailReadStatus = useMailStore(s => s.markEmailReadStatus);
  const deleteEmailFromServer = useMailStore(s => s.deleteEmailFromServer);
  const activeAccountId = useMailStore(s => s.activeAccountId);
  const activeMailbox = useMailStore(s => s.activeMailbox);

  const [headerExpanded, setHeaderExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [composeMode, setComposeMode] = useState(null);
  const [togglingRead, setTogglingRead] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUnarchive, setConfirmUnarchive] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [rawSource, setRawSource] = useState(null);
  const [loadingRaw, setLoadingRaw] = useState(false);
  const iframeRef = useRef(null);
  
  const isCached = selectedEmail && savedEmailIds.has(selectedEmail.uid);
  const isArchived = selectedEmail && archivedEmailIds.has(selectedEmail.uid);
  const isLocalOnly = selectedEmailSource === 'local-only';
  const isRead = selectedEmail?.flags?.includes('\\Seen');

  // Reset view states when switching emails
  useEffect(() => {
    setShowRaw(false);
    setRawSource(null);
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
          * { overflow-wrap: break-word; word-wrap: break-word; }
          body { overflow-x: hidden; max-width: 100%; }
          table { table-layout: fixed; width: 100% !important; overflow: hidden; }
          td, th { overflow: hidden; text-overflow: ellipsis; }
          pre { white-space: pre-wrap; overflow-x: auto; max-width: 100%; }
          blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #ddd; overflow: hidden; }
        </style>
      </head>
      <body>${getEmailBodyContent(replaceCidUrls(selectedEmail.html, selectedEmail.attachments))}</body>
    </html>
  ` : '';
  
  // Auto-resize iframe and apply dark mode overrides
  useEffect(() => {
    if (!iframeRef.current || !selectedEmail?.html) return;

    const iframe = iframeRef.current;
    let resizeTimers = [];

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

    // Named handlers so we can remove them in cleanup
    const handleClick = (e) => {
      const link = e.target.closest('a');
      if (link && link.href && !link.href.startsWith('cid:')) {
        e.preventDefault();
        e.stopPropagation();
        const url = link.href;
        import('@tauri-apps/plugin-shell').then(({ open }) => {
          open(url);
        }).catch(() => {
          window.open(url, '_blank');
        });
      }
    };

    const handleContextMenu = (e) => {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;
      e.preventDefault();
      const existing = doc.getElementById('mv-ctx-menu');
      if (existing) existing.remove();
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
      const close = () => { menu.remove(); doc.removeEventListener('click', close); };
      setTimeout(() => doc.addEventListener('click', close), 0);
    };

    let currentDoc = null;

    const onLoad = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) return;
        // Remove listeners from previous document if any
        if (currentDoc && currentDoc !== doc) {
          currentDoc.removeEventListener('click', handleClick);
          currentDoc.removeEventListener('contextmenu', handleContextMenu);
        }
        currentDoc = doc;
        doc.addEventListener('click', handleClick);
        doc.addEventListener('contextmenu', handleContextMenu);
      } catch (e) {
        console.error('Failed to intercept iframe links:', e);
      }
      resizeIframe();
      resizeTimers.push(setTimeout(resizeIframe, 200));
      resizeTimers.push(setTimeout(resizeIframe, 1000));
    };

    iframe.addEventListener('load', onLoad);
    resizeTimers.push(setTimeout(resizeIframe, 100));

    return () => {
      iframe.removeEventListener('load', onLoad);
      resizeTimers.forEach(t => clearTimeout(t));
      if (currentDoc) {
        try {
          currentDoc.removeEventListener('click', handleClick);
          currentDoc.removeEventListener('contextmenu', handleContextMenu);
        } catch { /* iframe may already be detached */ }
      }
    };
  }, [selectedEmail?.html]);
  
  // Thread view — show all emails in the thread
  if (selectedThread) {
    return <ThreadView thread={selectedThread} />;
  }

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
    <div className="flex-1 flex flex-col bg-mail-bg overflow-hidden min-h-0 min-w-0 h-full relative">
      {/* Toolbar */}
      <div data-tauri-drag-region className="flex items-center justify-between px-3 py-2 border-b border-mail-border">
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
        
        <div className="flex items-center gap-1">
          {isLocalOnly ? (
            <>
              <button
                onClick={handleRemoveLocal}
                className="p-2 hover:bg-mail-surface rounded-lg transition-colors"
                title="Delete local copy"
              >
                <Trash2 size={18} className="text-mail-danger" />
              </button>
              <button
                onClick={handleExport}
                className="p-2 hover:bg-mail-surface rounded-lg transition-colors"
                title="Export .eml"
              >
                <Download size={18} className="text-mail-text-muted" />
              </button>
            </>
          ) : isArchived ? (
            <>
              <button
                onClick={handleRemoveLocal}
                className="p-2 hover:bg-mail-surface rounded-lg transition-colors"
                title="Unarchive"
              >
                <Archive size={18} className="text-mail-text-muted" />
              </button>
              <button
                onClick={handleExport}
                className="p-2 hover:bg-mail-surface rounded-lg transition-colors"
                title="Export .eml"
              >
                <Download size={18} className="text-mail-text-muted" />
              </button>
            </>
          ) : (
            <button
              onClick={handleSave}
              disabled={saving}
              className="p-2 hover:bg-mail-surface rounded-lg transition-colors disabled:opacity-50"
              title={saving ? 'Archiving...' : 'Archive'}
            >
              <Archive size={18} className="text-mail-local" />
            </button>
          )}
        </div>
      </div>
      
      {/* Subject */}
      <div className="px-3 py-2.5 border-b border-mail-border flex items-start gap-2">
        <h1 className="text-lg font-semibold text-mail-text flex-1 min-w-0">
          {selectedEmail.subject}
        </h1>
        <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium flex-shrink-0 mt-0.5
                        ${isLocalOnly
                          ? 'text-mail-warning'
                          : isArchived
                            ? 'text-mail-local'
                            : 'text-mail-text-muted'}`}
             style={{
               backgroundColor: isLocalOnly
                 ? 'color-mix(in srgb, var(--mail-warning) 10%, transparent)'
                 : isArchived
                   ? 'color-mix(in srgb, var(--mail-local) 10%, transparent)'
                   : 'color-mix(in srgb, var(--mail-accent) 8%, transparent)'
             }}
        >
          {isLocalOnly ? (
            <><HardDrive size={12} /><span>Local only</span></>
          ) : isArchived ? (
            <><HardDrive size={12} /><span>Archived</span></>
          ) : (
            <><Cloud size={12} /><span>Server</span></>
          )}
        </div>
      </div>
      
      {/* Header */}
      <EmailHeader
        email={selectedEmail}
        expanded={headerExpanded}
        onToggle={() => setHeaderExpanded(!headerExpanded)}
        showRaw={showRaw}
        loadingRaw={loadingRaw}
        onToggleRaw={async () => {
          if (showRaw) {
            setShowRaw(false);
            return;
          }
          // Lazy-load rawSource on first "View Source" click
          if (!rawSource) {
            setLoadingRaw(true);
            try {
              const isTauri = !!window.__TAURI__;
              if (isTauri) {
                const { invoke } = window.__TAURI__.core;
                const b64 = await invoke('maildir_read_raw_source', {
                  accountId: activeAccountId,
                  mailbox: activeMailbox,
                  uid: selectedEmail.uid,
                });
                setRawSource(b64);
              }
            } catch (err) {
              console.error('[EmailViewer] Failed to load raw source:', err);
            } finally {
              setLoadingRaw(false);
            }
          }
          setShowRaw(true);
        }}
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="p-4">
          {showRaw && rawSource ? (
            <pre className="text-xs font-mono text-mail-text bg-mail-surface rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-all">
              {atob(rawSource)}
            </pre>
          ) : selectedEmail.html ? (
            <div className="rounded-lg overflow-hidden bg-white max-w-full" style={{ contain: 'inline-size' }}>
              <iframe
                ref={iframeRef}
                srcDoc={iframeContent}
                className="w-full border-0"
                style={{ minHeight: '300px', display: 'block', maxWidth: '100%' }}
                sandbox="allow-same-origin allow-popups allow-scripts"
                title="Email content"
                onContextMenu={e => e.preventDefault()}
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
                  <DownloadAllButton attachments={realAttachments} emailUid={selectedEmail.uid} account={activeAccountId} folder={activeMailbox} />
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {realAttachments.map((attachment, index) => (
                  <AttachmentItem key={index} attachment={attachment} attachmentIndex={attachment._originalIndex} emailUid={selectedEmail.uid} account={activeAccountId} folder={activeMailbox} />
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
