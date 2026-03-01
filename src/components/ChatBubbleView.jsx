import React, { useMemo, useRef, useEffect, useState } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useShallow } from 'zustand/react/shallow';
import { motion, AnimatePresence } from 'framer-motion';
import {
  getAvatarColor,
  getInitials,
  getCleanMessageBody,
  buildThreads,
  formatMessageTime,
  formatDateSeparator,
  isDifferentDay,
  isFromUser
} from '../utils/emailParser';
import { useChatBodyLoader, emailKey } from '../hooks/useChatBodyLoader';
import {
  ChevronLeft,
  Paperclip,
  Eye,
  X,
  Reply,
  ReplyAll,
  Forward,
  Download,
  MoreVertical,
  ExternalLink,
  Loader,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle
} from 'lucide-react';
import { AttachmentItem } from './EmailViewer';
import { getRealAttachments } from '../services/attachmentUtils';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../utils/iframeQuoteFolding';
import { splitQuotedContent } from '../utils/quoteFolding';
import { splitSignature } from '../utils/signatureFolding';
import { useSettingsStore } from '../stores/settingsStore';
import { checkSenderVerification } from '../utils/senderCheck';

function SenderBadge({ email, size = 10 }) {
  const { status, tooltip } = useMemo(
    () => checkSenderVerification(email),
    [email?.from, email?.replyTo, email?.returnPath, email?.authenticationResults]
  );

  if (status === 'none') return null;

  const config = {
    verified: { Icon: ShieldCheck, color: 'text-green-500' },
    warning: { Icon: AlertTriangle, color: 'text-orange-500' },
    danger: { Icon: ShieldAlert, color: 'text-red-500' },
  };

  const { Icon, color } = config[status];
  return (
    <span className={`inline-flex items-center ${color}`} title={tooltip}>
      <Icon size={size} />
    </span>
  );
}

export function ChatBubbleView({ correspondent, threadId, userEmail, onBack, onReply }) {
  const scrollRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const [showOriginal, setShowOriginal] = useState(null); // email uid or null
  const [contextMenu, setContextMenu] = useState(null); // { x, y, email } or null
  const [fullViewEmail, setFullViewEmail] = useState(null); // email to show in full view modal

  // Derive thread from live correspondent data using RFC header-based threading
  const topic = useMemo(() => {
    const threads = buildThreads(correspondent.emails);
    return threads.get(threadId) || { subject: threadId, emails: [] };
  }, [correspondent.emails, threadId]);

  const { bodiesMapRef, registerListener } = useChatBodyLoader(topic.emails);

  // Scroll to bottom only on initial mount (threadId change = new thread opened)
  const initialScrollDoneRef = useRef(false);
  useEffect(() => {
    initialScrollDoneRef.current = false;
    stickToBottomRef.current = true;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        initialScrollDoneRef.current = true;
      }
    });
  }, [threadId]);

  // Keep scroll pinned to bottom as content loads (messages expanding),
  // until the user manually scrolls up via wheel/touch
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    // Detect only real user-initiated scrolls (wheel/touch), not browser
    // scroll events fired due to content resizing
    const checkUserScroll = () => {
      requestAnimationFrame(() => {
        const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        stickToBottomRef.current = distFromBottom < 40;
      });
    };

    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });

    el.addEventListener('wheel', checkUserScroll, { passive: true });
    el.addEventListener('touchmove', checkUserScroll, { passive: true });
    observer.observe(el);
    for (const child of el.children) {
      observer.observe(child);
    }

    // Watch for new children (bubbles added to DOM)
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) observer.observe(node);
        }
      }
    });
    mo.observe(el, { childList: true });

    return () => {
      el.removeEventListener('wheel', checkUserScroll);
      el.removeEventListener('touchmove', checkUserScroll);
      observer.disconnect();
      mo.disconnect();
    };
  }, [threadId]);

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  const avatarColor = getAvatarColor(correspondent.email);
  const initials = getInitials(correspondent.name, correspondent.email);

  // Get the latest email for the default reply
  const latestEmail = topic.emails[topic.emails.length - 1];

  const handleContextMenu = (e, email) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      email
    });
  };

  const handleReplyToEmail = (email, mode = 'reply') => {
    setContextMenu(null);
    if (onReply) {
      onReply(email, mode);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div data-tauri-drag-region className="flex items-center gap-2.5 px-4 py-[14px] border-b border-mail-border bg-mail-surface">
        <button
          onClick={onBack}
          className="p-1 hover:bg-mail-border rounded-lg transition-colors"
        >
          <ChevronLeft size={18} className="text-mail-text-muted" />
        </button>

        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-mail-text truncate leading-tight">
            {topic.subject}
          </h2>
          <p className="text-[11px] text-mail-text-muted truncate leading-tight">
            {correspondent.name} &middot; {topic.emails.length} message{topic.emails.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {topic.emails.map((email, index) => {
          const prevEmail = index > 0 ? topic.emails[index - 1] : null;
          const showDateSeparator = !prevEmail || isDifferentDay(prevEmail.date, email.date);
          const fromUser = isFromUser(email, userEmail);

          const eKey = emailKey(email);
          return (
            <React.Fragment key={eKey}>
              {/* Date Separator */}
              {showDateSeparator && (
                <div className="flex items-center justify-center py-4">
                  <span className="px-3 py-1 bg-mail-bg border border-mail-border rounded-full text-xs text-mail-text-muted">
                    {formatDateSeparator(email.date)}
                  </span>
                </div>
              )}

              {/* Message Bubble */}
              <MessageBubble
                email={email}
                eKey={eKey}
                fromUser={fromUser}
                avatarColor={avatarColor}
                initials={initials}
                isOriginalVisible={showOriginal === eKey}
                onToggleOriginal={() => setShowOriginal(
                  showOriginal === eKey ? null : eKey
                )}
                onContextMenu={(e) => handleContextMenu(e, email)}
                onReply={() => handleReplyToEmail(email)}
                onOpenFullView={() => {
                  const bodyEntry = bodiesMapRef.current?.get(eKey);
                  setFullViewEmail(bodyEntry?.email ? { ...email, ...bodyEntry.email } : email);
                }}
                bodiesMapRef={bodiesMapRef}
                registerListener={registerListener}
              />
            </React.Fragment>
          );
        })}
      </div>

      {/* Reply Footer */}
      <div className="px-4 py-3 border-t border-mail-border bg-mail-surface">
        <button
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                    bg-mail-accent hover:bg-mail-accent-hover text-white
                    rounded-lg font-medium transition-colors"
          onClick={() => handleReplyToEmail(latestEmail, 'reply')}
        >
          <Reply size={18} />
          Reply
        </button>
      </div>

      {/* Context Menu */}
      <AnimatePresence>
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onReply={() => handleReplyToEmail(contextMenu.email, 'reply')}
            onReplyAll={() => handleReplyToEmail(contextMenu.email, 'replyAll')}
            onForward={() => handleReplyToEmail(contextMenu.email, 'forward')}
            onClose={() => setContextMenu(null)}
          />
        )}
      </AnimatePresence>

      {/* Full View Email Modal */}
      <AnimatePresence>
        {fullViewEmail && (
          <FullViewEmailModal
            email={fullViewEmail}
            onClose={() => setFullViewEmail(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ContextMenu({ x, y, onReply, onReplyAll, onForward, onClose }) {
  // Adjust position to keep menu in viewport
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
    <motion.div
      ref={menuRef}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="fixed z-50 bg-mail-surface border border-mail-border rounded-lg shadow-xl py-1 min-w-[160px]"
      style={{ left: position.x, top: position.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={onReply}
        className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                  flex items-center gap-2 text-mail-text"
      >
        <Reply size={14} />
        Reply
      </button>
      <button
        onClick={onReplyAll}
        className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                  flex items-center gap-2 text-mail-text"
      >
        <ReplyAll size={14} />
        Reply All
      </button>
      <button
        onClick={onForward}
        className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                  flex items-center gap-2 text-mail-text"
      >
        <Forward size={14} />
        Forward
      </button>
    </motion.div>
  );
}

function MessageBubble({ email, eKey, fromUser, avatarColor, initials, isOriginalVisible, onToggleOriginal, onContextMenu, onReply, onOpenFullView, bodiesMapRef, registerListener }) {
  const iframeRef = useRef(null);
  const [quotesExpanded, setQuotesExpanded] = useState(false);
  const [sigExpanded, setSigExpanded] = useState(false);

  const signatureDisplay = useSettingsStore(s => s.signatureDisplay);
  const activeAccountId = useMailStore(s => s.activeAccountId);
  const activeMailbox = useMailStore(s => s.activeMailbox);
  const getSentMailboxPath = useMailStore(s => s.getSentMailboxPath);

  // Subscribe to body load updates for this specific email
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!registerListener) return;
    return registerListener(eKey, () => forceUpdate(n => n + 1));
  }, [eKey, registerListener]);

  // Merge fetched body into header-only email
  const bodyEntry = bodiesMapRef?.current?.get(eKey);
  const mergedEmail = bodyEntry?.email ? { ...email, ...bodyEntry.email } : email;
  const isBodyLoading = bodyEntry?.status === 'loading';

  // For detecting if content was stripped (still needs getCleanMessageBody for comparison)
  const strippedBody = useMemo(() => getCleanMessageBody(mergedEmail), [mergedEmail]);

  // Split plain text into new content and quoted content
  const plainText = mergedEmail?.text || mergedEmail?.textBody || '';
  const { newContent: cleanBody, quotedContent } = useMemo(
    () => {
      if (!plainText && mergedEmail?.html) {
        // HTML-only email — quotes handled by iframe script, use stripped body
        return { newContent: strippedBody, quotedContent: '' };
      }
      return splitQuotedContent(plainText);
    },
    [plainText, mergedEmail?.html, strippedBody]
  );

  // Split signature from the clean body
  const { body: bodyWithoutSig, signature } = useMemo(
    () => splitSignature(cleanBody),
    [cleanBody]
  );

  const hasAttachments = mergedEmail.attachments?.length > 0 || mergedEmail.hasAttachments;
  const realAttachments = useMemo(
    () => mergedEmail.attachments ? getRealAttachments(mergedEmail.attachments, mergedEmail.html) : [],
    [mergedEmail.attachments, mergedEmail.html]
  );
  const emailMailbox = email._fromSentFolder ? getSentMailboxPath() : activeMailbox;
  const hasHtml = !!mergedEmail.html;
  const wasStripped = !hasHtml && strippedBody.length < (mergedEmail.text?.length || 0) * 0.8;

  // Check if we have displayable content
  const hasDisplayableContent = hasHtml || (cleanBody && cleanBody.trim().length > 0);

  // Handle double-click to open full view
  const handleDoubleClick = (e) => {
    // Don't trigger on text selection
    if (window.getSelection()?.toString()) return;
    onOpenFullView?.();
  };

  // Handle open full view button click
  const handleOpenFullView = (e) => {
    e.stopPropagation();
    onOpenFullView?.();
  };

  // Build HTML content for iframe with theme-aware colors
  const iframeContent = useMemo(() => {
    if (!mergedEmail.html) return '';

    // Use appropriate text color based on bubble type
    const textColor = fromUser ? '#ffffff' : 'var(--mail-text, #e4e4e7)';
    const linkColor = fromUser ? '#c7d2fe' : '#6366f1';
    const quoteColor = fromUser ? 'rgba(255,255,255,0.6)' : '#6b7280';
    const quoteBorder = fromUser ? 'rgba(255,255,255,0.3)' : '#d1d5db';

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
              padding: 8px;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              font-size: 14px;
              line-height: 1.5;
              word-wrap: break-word;
              overflow-wrap: break-word;
              background-color: transparent !important;
              color: ${textColor};
            }
            img {
              max-width: 100%;
              height: auto;
            }
            a {
              color: ${linkColor};
            }
            table {
              max-width: 100%;
              border-collapse: collapse;
            }
            pre, code {
              white-space: pre-wrap;
              word-wrap: break-word;
              max-width: 100%;
              overflow-x: auto;
            }
            blockquote {
              border-left: 3px solid ${quoteBorder};
              margin: 8px 0;
              padding-left: 12px;
              color: ${quoteColor};
            }
          </style>
        </head>
        <body>${mergedEmail.html}${getQuoteFoldingScript()}${getSignatureFoldingScript(signatureDisplay)}</body>
      </html>
    `;
  }, [mergedEmail.html, fromUser, signatureDisplay]);

  // Auto-resize iframe
  useEffect(() => {
    const handleMessage = (e) => {
      if (e.data?.type === 'iframe-resize' && e.data.height && iframeRef.current) {
        iframeRef.current.style.height = Math.min(e.data.height + 16, 400) + 'px';
      }
    };
    window.addEventListener('message', handleMessage);

    if (iframeRef.current && mergedEmail.html) {
      const iframe = iframeRef.current;

      const resizeIframe = () => {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (doc && doc.body) {
            const height = Math.max(
              doc.body.scrollHeight,
              doc.body.offsetHeight,
              50
            );
            iframe.style.height = Math.min(height + 16, 400) + 'px';
          }
        } catch (e) {
          console.error('Failed to resize iframe:', e);
        }
      };

      iframe.onload = () => {
        resizeIframe();
        setTimeout(resizeIframe, 200);
        // Prevent native context menu, intercept links, and apply dark mode overrides
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (doc) {
            doc.addEventListener('contextmenu', (e) => e.preventDefault());
            doc.addEventListener('click', (e) => {
              const link = e.target.closest('a');
              if (link && link.href && !link.href.startsWith('cid:')) {
                e.preventDefault();
                import('@tauri-apps/plugin-shell').then(({ open }) => {
                  open(link.href);
                }).catch(() => {
                  window.open(link.href, '_blank');
                });
              }
            });
          }
        } catch (e) { /* iframe access error */ }
      };

      setTimeout(resizeIframe, 100);
    }

    return () => window.removeEventListener('message', handleMessage);
  }, [mergedEmail.html]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex gap-2 ${fromUser ? 'flex-row-reverse' : 'flex-row'}`}
      onContextMenu={onContextMenu}
    >
      {/* Avatar (only for other person) */}
      {!fromUser && (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium flex-shrink-0 mt-1"
          style={{ backgroundColor: avatarColor }}
        >
          {initials}
        </div>
      )}

      {/* Bubble */}
      <div className={`max-w-[80%] ${fromUser ? 'items-end' : 'items-start'}`}>
        <div
          onDoubleClick={handleDoubleClick}
          className={`rounded-2xl overflow-hidden cursor-pointer ${
            fromUser
              ? 'chat-bubble-sent rounded-br-md'
              : 'chat-bubble-received rounded-bl-md'
          }`}
          title="Double-click to open in new window"
        >
          {/* Message Content */}
          {isOriginalVisible ? (
            <div className="px-4 py-2.5 space-y-2">
              <div className="text-xs opacity-70 font-medium pb-1 border-b border-current/20">
                Original message:
              </div>
              {mergedEmail.html ? (
                <iframe
                  ref={iframeRef}
                  srcDoc={iframeContent}
                  className="w-full border-0 rounded"
                  style={{ minHeight: '100px', maxHeight: '400px' }}
                  sandbox="allow-same-origin allow-popups"
                  title="Email content"
                />
              ) : (
                <div className="whitespace-pre-wrap break-words text-sm">
                  {mergedEmail.text || mergedEmail.textBody || '(No text content)'}
                </div>
              )}
            </div>
          ) : hasHtml ? (
            <div className="overflow-hidden">
              <iframe
                ref={iframeRef}
                srcDoc={iframeContent}
                className="w-full border-0"
                style={{ minHeight: '50px', maxHeight: '400px' }}
                sandbox="allow-same-origin allow-popups"
                title="Email content"
              />
            </div>
          ) : hasDisplayableContent ? (
            <div className="px-4 py-2.5 whitespace-pre-wrap break-words text-sm">
              {bodyWithoutSig}
              {signature && signatureDisplay !== 'always-hide' && (
                signatureDisplay === 'always-show' ? (
                  <div className={`mt-2 text-xs whitespace-pre-wrap opacity-60 ${
                    fromUser ? 'text-white/60' : 'text-mail-text-muted'
                  }`}>
                    {signature}
                  </div>
                ) : (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); setSigExpanded(prev => !prev); }}
                      className={`block mt-2 text-xs cursor-pointer select-none ${
                        fromUser ? 'text-white/60 hover:text-white' : 'text-mail-text-muted hover:text-mail-accent'
                      }`}
                    >
                      {sigExpanded ? '\u25BE Hide signature' : '\u2014 Show signature'}
                    </button>
                    {sigExpanded && (
                      <div className={`mt-1 text-xs whitespace-pre-wrap opacity-60 ${
                        fromUser ? 'text-white/60' : 'text-mail-text-muted'
                      }`}>
                        {signature}
                      </div>
                    )}
                  </>
                )
              )}
              {quotedContent && (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); setQuotesExpanded(prev => !prev); }}
                    className={`block mt-1 text-xs cursor-pointer select-none rounded px-2 py-0.5 border transition-colors ${
                      fromUser
                        ? 'text-white/70 hover:text-white bg-white/10 border-white/20'
                        : 'text-mail-text-muted hover:text-mail-accent bg-mail-surface border-mail-border'
                    }`}
                  >
                    {quotesExpanded ? '\u25BE Hide quoted text' : '\u22EF'}
                  </button>
                  {quotesExpanded && (
                    <div className={`mt-1 border-l-2 pl-2 ${
                      fromUser ? 'text-white/60 border-white/30' : 'text-mail-text-muted border-mail-border'
                    }`}>
                      {quotedContent}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : isBodyLoading ? (
            <div className="px-4 py-3 flex items-center gap-2">
              <Loader size={14} className={`animate-spin flex-shrink-0 ${fromUser ? 'text-white/70' : 'text-mail-text-muted'}`} />
              <span className={`text-sm ${fromUser ? 'text-white/70' : 'text-mail-text-muted'}`}>
                Loading...
              </span>
            </div>
          ) : (
            <div className="px-4 py-3 flex flex-col items-center gap-2">
              <p className={`text-sm ${fromUser ? 'text-white/70' : 'text-mail-text-muted'}`}>
                Content cannot be displayed
              </p>
              <button
                onClick={handleOpenFullView}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  fromUser
                    ? 'bg-white/20 hover:bg-white/30 text-white'
                    : 'bg-mail-accent/10 hover:bg-mail-accent/20 text-mail-accent'
                }`}
              >
                <ExternalLink size={12} />
                Open in new window
              </button>
            </div>
          )}

          {/* Attachments */}
          {hasAttachments && realAttachments.length > 0 && (
            <div className={`flex flex-col gap-1.5 px-3 py-2 border-t ${
              fromUser ? 'border-white/20' : 'border-mail-border'
            }`}>
              {realAttachments.map((att) => (
                <AttachmentItem
                  key={att._originalIndex}
                  attachment={att}
                  attachmentIndex={att._originalIndex}
                  emailUid={email.uid}
                  account={activeAccountId}
                  folder={emailMailbox}
                  accountId={activeAccountId}
                  mailbox={emailMailbox}
                  compact
                />
              ))}
            </div>
          )}
          {hasAttachments && realAttachments.length === 0 && !mergedEmail.attachments && (
            <div className={`flex items-center gap-2 px-4 py-2 border-t ${
              fromUser ? 'border-white/20' : 'border-mail-border'
            }`}>
              <Paperclip size={14} className="opacity-70" />
              <span className="text-xs opacity-70">Attachments</span>
            </div>
          )}
        </div>

        {/* Meta row */}
        <div className={`flex items-center gap-2 mt-1 px-1 ${fromUser ? 'justify-end' : 'justify-start'}`}>
          <span className="text-[10px] text-mail-text-muted">
            {formatMessageTime(email.date)}
          </span>
          <SenderBadge email={email} />

          {/* View original toggle (for text messages or to see full HTML) */}
          {(wasStripped || hasHtml) && (
            <button
              onClick={onToggleOriginal}
              className="flex items-center gap-1 text-[10px] text-mail-accent hover:underline"
            >
              <Eye size={10} />
              {isOriginalVisible ? 'Show cleaned' : 'View original'}
            </button>
          )}

          {/* Open in new window button */}
          <button
            onClick={handleOpenFullView}
            className="flex items-center gap-1 text-[10px] text-mail-text-muted hover:text-mail-accent"
            title="Open in new window"
          >
            <ExternalLink size={10} />
          </button>

          {/* Quick reply button */}
          <button
            onClick={onReply}
            className="flex items-center gap-1 text-[10px] text-mail-text-muted hover:text-mail-accent"
          >
            <Reply size={10} />
          </button>
        </div>
      </div>

      {/* Spacer for user messages (to align with avatar space) */}
      {fromUser && <div className="w-8 flex-shrink-0" />}
    </motion.div>
  );
}

// Modal for viewing full original email
export function OriginalEmailModal({ email, onClose }) {
  if (!email) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          className="bg-mail-surface border border-mail-border rounded-xl shadow-xl
                    max-w-2xl w-full max-h-[80vh] overflow-hidden"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
            <h3 className="font-semibold text-mail-text">Original Email</h3>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-mail-border rounded-lg transition-colors"
            >
              <X size={18} className="text-mail-text-muted" />
            </button>
          </div>

          {/* Email Details */}
          <div className="p-4 border-b border-mail-border space-y-2 text-sm">
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16">From:</span>
              <span className="text-mail-text">
                {email.from?.name} &lt;{email.from?.address}&gt;
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16">To:</span>
              <span className="text-mail-text">
                {email.to?.map(t => `${t.name || ''} <${t.address}>`).join(', ')}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16">Subject:</span>
              <span className="text-mail-text font-medium">{email.subject}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-mail-text-muted w-16">Date:</span>
              <span className="text-mail-text">
                {new Date(email.date).toLocaleString()}
              </span>
            </div>
          </div>

          {/* Body */}
          <div className="p-4 overflow-y-auto max-h-[50vh]">
            <pre className="whitespace-pre-wrap text-sm text-mail-text font-sans">
              {email.text || email.textBody || '(No text content)'}
            </pre>
          </div>

          {/* Attachments */}
          {email.attachments?.length > 0 && (
            <div className="px-4 py-3 border-t border-mail-border">
              <h4 className="text-sm font-medium text-mail-text mb-2">Attachments</h4>
              <div className="flex flex-wrap gap-2">
                {email.attachments.map((att, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-1.5 bg-mail-bg border border-mail-border rounded-lg text-sm"
                  >
                    <Paperclip size={14} className="text-mail-text-muted" />
                    <span className="text-mail-text">{att.filename}</span>
                    <button className="p-1 hover:bg-mail-border rounded">
                      <Download size={14} className="text-mail-accent" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// Full-screen modal for viewing complete email with HTML rendering
function FullViewEmailModal({ email: initialEmail, onClose }) {
  const { selectEmail, selectedEmail, loadingEmail, activeAccountId, activeMailbox, getSentMailboxPath } = useMailStore(
    useShallow(s => ({ selectEmail: s.selectEmail, selectedEmail: s.selectedEmail, loadingEmail: s.loadingEmail, activeAccountId: s.activeAccountId, activeMailbox: s.activeMailbox, getSentMailboxPath: s.getSentMailboxPath }))
  );
  const iframeRef = useRef(null);
  const [fetchedEmail, setFetchedEmail] = useState(null);

  // Fetch full email content if not already available
  useEffect(() => {
    const fetchFullEmail = async () => {
      // Check if we already have full content (non-empty html or text)
      const hasContent = (initialEmail.html && initialEmail.html.trim().length > 0) ||
                         (initialEmail.text && initialEmail.text.trim().length > 0);

      if (hasContent) {
        setFetchedEmail(initialEmail);
        return;
      }

      // Need to fetch full content - use selectEmail
      try {
        await selectEmail(initialEmail.uid, initialEmail.source || 'server');
      } catch (e) {
        console.error('Failed to fetch full email:', e);
        // Even if fetch fails, set the initial email so we show something
        setFetchedEmail(initialEmail);
      }
    };

    fetchFullEmail();
  }, [initialEmail, selectEmail]);

  // Use selectedEmail from store if we just fetched it
  useEffect(() => {
    if (selectedEmail && selectedEmail.uid === initialEmail.uid) {
      setFetchedEmail(selectedEmail);
    }
  }, [selectedEmail, initialEmail.uid]);

  // Use fetched email or fall back to initial
  const email = fetchedEmail || initialEmail;

  // Build full HTML content for iframe
  const iframeContent = useMemo(() => {
    const htmlBody = email.html || `<pre style="white-space: pre-wrap; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0;">${
      (email.text || email.textBody || '(No content)').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }</pre>`;

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
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              font-size: 14px;
              line-height: 1.6;
              word-wrap: break-word;
              overflow-wrap: break-word;
              background-color: #ffffff;
              color: #333333;
            }
            img {
              max-width: 100%;
              height: auto;
            }
            a {
              color: #2563eb;
            }
            table {
              max-width: 100%;
              border-collapse: collapse;
            }
            pre, code {
              white-space: pre-wrap;
              word-wrap: break-word;
              max-width: 100%;
              overflow-x: auto;
              background: #f5f5f5;
              padding: 2px 6px;
              border-radius: 4px;
            }
            blockquote {
              border-left: 3px solid #d1d5db;
              margin: 8px 0;
              padding-left: 12px;
              color: #6b7280;
            }
          </style>
        </head>
        <body>${htmlBody}</body>
      </html>
    `;
  }, [email]);

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Intercept links and prevent native context menu in full-view iframe
  useEffect(() => {
    if (!iframeRef.current) return;
    const iframe = iframeRef.current;
    const setup = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) return;
        doc.addEventListener('contextmenu', (e) => e.preventDefault());
        doc.addEventListener('click', (e) => {
          const link = e.target.closest('a');
          if (link && link.href && !link.href.startsWith('cid:')) {
            e.preventDefault();
            import('@tauri-apps/plugin-shell').then(({ open }) => {
              open(link.href);
            }).catch(() => {
              window.open(link.href, '_blank');
            });
          }
        });
      } catch (e) { /* iframe access error */ }
    };
    iframe.addEventListener('load', setup);
    setup(); // in case already loaded
    return () => iframe.removeEventListener('load', setup);
  }, [email]);

  if (!email) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/60 z-50 flex flex-col"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 20, opacity: 0 }}
        className="flex-1 m-4 bg-mail-surface border border-mail-border rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border bg-mail-bg">
          <div className="flex-1 min-w-0 mr-4">
            <h2 className="font-semibold text-mail-text truncate text-lg">
              {email.subject || '(No subject)'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-mail-border rounded-lg transition-colors flex-shrink-0"
          >
            <X size={20} className="text-mail-text-muted" />
          </button>
        </div>

        {/* Email Meta */}
        <div className="px-4 py-3 border-b border-mail-border bg-mail-surface space-y-1 text-sm">
          <div className="flex gap-2">
            <span className="text-mail-text-muted w-14 flex-shrink-0">From:</span>
            <span className="text-mail-text truncate">
              {email.from?.name ? `${email.from.name} <${email.from.address}>` : email.from?.address}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-mail-text-muted w-14 flex-shrink-0">To:</span>
            <span className="text-mail-text truncate">
              {email.to?.map(t => t.name ? `${t.name} <${t.address}>` : t.address).join(', ')}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-mail-text-muted w-14 flex-shrink-0">Date:</span>
            <span className="text-mail-text">
              {email.date ? new Date(email.date).toLocaleString() : ''}
            </span>
          </div>
        </div>

        {/* Email Body - Full Height iframe */}
        <div className="flex-1 overflow-hidden relative">
          {!fetchedEmail && loadingEmail ? (
            <div className="absolute inset-0 flex items-center justify-center bg-mail-bg">
              <div className="flex flex-col items-center gap-3">
                <Loader size={32} className="text-mail-accent animate-spin" />
                <span className="text-sm text-mail-text-muted">Loading email content...</span>
              </div>
            </div>
          ) : (
            <iframe
              ref={iframeRef}
              srcDoc={iframeContent}
              className="w-full h-full border-0"
              sandbox="allow-same-origin allow-popups"
              title="Full email content"
            />
          )}
        </div>

        {/* Attachments */}
        {(() => {
          const modalAttachments = getRealAttachments(email.attachments, email.html);
          const modalMailbox = initialEmail._fromSentFolder ? getSentMailboxPath() : activeMailbox;
          return modalAttachments.length > 0 ? (
            <div className="px-4 py-3 border-t border-mail-border bg-mail-bg">
              <div className="grid grid-cols-2 gap-2">
                {modalAttachments.map((att) => (
                  <AttachmentItem
                    key={att._originalIndex}
                    attachment={att}
                    attachmentIndex={att._originalIndex}
                    emailUid={email.uid}
                    account={activeAccountId}
                    folder={modalMailbox}
                    accountId={activeAccountId}
                    mailbox={modalMailbox}
                  />
                ))}
              </div>
            </div>
          ) : null;
        })()}
      </motion.div>
    </motion.div>
  );
}
