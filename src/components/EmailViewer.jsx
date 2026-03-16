import React, { memo, useState, useEffect, useRef } from 'react';
import { useMailStore } from '../stores/mailStore';
import { motion, AnimatePresence } from 'framer-motion';
import { ComposeModal } from './ComposeModal';
import {
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Paperclip,
  Download,
  Archive,
  HardDrive,
  Cloud,
  ExternalLink,
  FileText,
  Mail,
  MailOpen,
  FolderSymlink,
} from 'lucide-react';
import { getRealAttachments, replaceCidUrls } from '../services/attachmentUtils';
import { MoveToFolderDropdown } from './MoveToFolderDropdown';
import { SenderInsightsPanel } from './SenderInsightsPanel';
import { ThreadView } from './email/ThreadView';
import { EmailHeader } from './email/EmailHeaderComponent';
import { AttachmentItem, DownloadAllButton } from './email/AttachmentBar';
import { scanEmailLinks, checkLinkAlert } from '../utils/linkSafety';
import { LinkSafetyModal } from './LinkSafetyModal';
import { LinkAlertIcon } from './LinkAlertIcon';
import { useSettingsStore } from '../stores/settingsStore';

// Re-export AttachmentItem for any external consumers
export { AttachmentItem } from './email/AttachmentBar';

// ── Single Email Viewer ─────────────────────────────────────────────────────

function EmailViewerComponent() {
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

  const linkSafetyEnabled = useSettingsStore(s => s.linkSafetyEnabled);
  const linkSafetyClickConfirm = useSettingsStore(s => s.linkSafetyClickConfirm);
  const [linkSafetyAlert, setLinkSafetyAlert] = useState(null);
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
  const [showMoveDropdown, setShowMoveDropdown] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const moveButtonRef = useRef(null);
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
    setShowInsights(false);
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
  const iframeContent = (() => {
    if (!selectedEmail?.html) return '';
    let html = `
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
    </html>`;
    if (linkSafetyEnabled) {
      const { modifiedHtml, maxAlertLevel } = scanEmailLinks(html, selectedEmail.uid);
      html = modifiedHtml;
      if (maxAlertLevel && !selectedEmail._linkAlert) {
        // Update selectedEmail, emails, and sortedEmails so all views show the icon
        useMailStore.setState(state => ({
          selectedEmail: { ...state.selectedEmail, _linkAlert: maxAlertLevel },
          emails: state.emails.map(e => e.uid === selectedEmail.uid ? { ...e, _linkAlert: maxAlertLevel } : e),
          sortedEmails: state.sortedEmails.map(e => e.uid === selectedEmail.uid ? { ...e, _linkAlert: maxAlertLevel } : e),
        }));
      }
    }
    return html;
  })();

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
      if (!link || !link.href) return;
      if (link.href.startsWith('cid:') || link.href.startsWith('mailto:') || link.href.startsWith('tel:') || link.href.startsWith('#')) return;
      e.preventDefault();
      e.stopPropagation();
      // Check link safety before opening
      if (linkSafetyEnabled && linkSafetyClickConfirm) {
        const alert = checkLinkAlert(link);
        if (alert) {
          setLinkSafetyAlert(alert);
          return;
        }
      }
      const url = link.href;
      import('@tauri-apps/plugin-shell').then(({ open }) => {
        open(url);
      }).catch(() => {
        window.open(url, '_blank');
      });
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
              <div className="relative">
                <button
                  ref={moveButtonRef}
                  data-testid="move-to-folder-btn"
                  onClick={() => setShowMoveDropdown(v => !v)}
                  className="p-2 hover:bg-mail-surface rounded-lg transition-colors"
                  title="Move to folder"
                >
                  <FolderSymlink size={18} className="text-mail-text-muted" />
                </button>
                {showMoveDropdown && selectedEmail && (
                  <MoveToFolderDropdown
                    uids={[selectedEmail.uid]}
                    onClose={() => setShowMoveDropdown(false)}
                    anchorRect={moveButtonRef.current?.getBoundingClientRect()}
                  />
                )}
              </div>
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
        <h1 className="text-lg font-semibold text-mail-text flex-1 min-w-0 flex items-center gap-1.5">
          <LinkAlertIcon level={selectedEmail._linkAlert} size={18} />
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
        showInsights={showInsights}
        onToggleInsights={() => setShowInsights(!showInsights)}
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

      {/* Sender Insights */}
      <AnimatePresence>
        {showInsights && selectedEmail?.from?.address && (
          <SenderInsightsPanel senderEmail={selectedEmail.from.address} />
        )}
      </AnimatePresence>

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

      <LinkSafetyModal
        alert={linkSafetyAlert}
        onCancel={() => setLinkSafetyAlert(null)}
        onOpenAnyway={() => {
          const url = linkSafetyAlert.actualUrl;
          setLinkSafetyAlert(null);
          import('@tauri-apps/plugin-shell').then(({ open }) => open(url)).catch(() => window.open(url, '_blank'));
        }}
      />
    </div>
  );
}

export const EmailViewer = memo(EmailViewerComponent);
