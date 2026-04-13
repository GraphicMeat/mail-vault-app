import React, { useState, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDateTime } from '../../utils/dateFormat';
import {
  ChevronDown,
  ChevronUp,
  Info,
  Cloud,
  HardDrive,
  Code,
  RefreshCw,
} from 'lucide-react';
import { SenderVerificationBadge } from './EmailHeaderComponent';
import { getSenderName } from '../../utils/emailParser';

/**
 * Shared sender info component with three variants: single, thread, chat.
 * Renders avatar, sender name, email, storage icon, DKIM shield, insights button,
 * To/CC, timestamp, and "via" indicator in a unified layout.
 */
export const EmailSenderInfo = memo(function EmailSenderInfo({
  email,
  variant = 'single',
  expanded,
  onToggle,
  showRaw,
  onToggleRaw,
  loadingRaw,
  showInsights,
  onToggleInsights,
  archivedEmailIds,
  onAvatarClick,
  onNameClick,
}) {
  const [headerExpanded, setHeaderExpanded] = useState(false);

  const senderName = getSenderName(email);
  const initial = senderName ? senderName[0].toUpperCase() : '?';
  const hasDistinctName = email?.from?.name && email.from.name !== email.from.address;

  // Extract mailing list name from List-Id
  const listId = email?.listId || email?.headers?.['list-id'];
  let listName = null;
  if (listId) {
    const match = listId.match(/^"?([^"<]+)"?\s*</);
    if (match) listName = match[1].trim();
  }

  // ── Chat variant: compact avatar + clickable name ──
  if (variant === 'chat') {
    return (
      <div className="flex items-center gap-2">
        <div
          className="w-8 h-8 bg-mail-accent rounded-full flex items-center justify-center flex-shrink-0 cursor-pointer"
          onClick={onAvatarClick}
          title={senderName}
        >
          <span className="text-white font-semibold text-xs">{initial}</span>
        </div>
        <span
          className="text-xs font-semibold text-mail-text cursor-pointer hover:underline"
          onClick={onNameClick}
        >
          {senderName}
        </span>
      </div>
    );
  }

  // ── Single / Thread variant: full inline layout ──
  return (
    <div
      className="flex items-start gap-2 px-3 py-2.5 cursor-pointer"
      onClick={onToggle}
    >
      {/* Avatar */}
      <div className="w-8 h-8 bg-mail-accent rounded-full flex items-center justify-center flex-shrink-0">
        <span className="text-white font-semibold text-xs">{initial}</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {/* Storage icon */}
            {email.source === 'local-only' ? (
              <HardDrive size={12} className="text-mail-warning flex-shrink-0" title="Local only" />
            ) : archivedEmailIds?.has(email.uid) ? (
              <HardDrive size={12} className="text-mail-local flex-shrink-0" title="Archived" />
            ) : (
              <Cloud size={12} className="flex-shrink-0" style={{ color: 'rgba(59, 130, 246, 0.5)' }} title="Server" />
            )}

            {/* Sender name */}
            <span className="text-sm font-semibold text-mail-text truncate">
              {senderName}
            </span>

            {/* DKIM / verification badge */}
            <SenderVerificationBadge email={email} />

            {/* Sender email (only when name differs from address) */}
            {hasDistinctName && (
              <span className="text-xs text-mail-text-muted truncate">
                &lt;{email.from.address}&gt;
              </span>
            )}

            {/* "via" mailing list indicator */}
            {listName && (
              <span className="text-[10px] text-mail-text-muted italic flex-shrink-0">
                via {listName}
              </span>
            )}

            {/* Insights button */}
            <button
              onClick={(e) => { e.stopPropagation(); onToggleInsights?.(); }}
              className={`p-0.5 rounded transition-colors flex-shrink-0 ${showInsights ? 'text-mail-accent' : 'text-mail-text-muted hover:text-mail-text'}`}
              title="Sender insights"
            >
              <Info size={12} />
            </button>
          </div>

          {/* Timestamp + expand chevron */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span className="text-[10px] text-mail-text-muted">
              {email.date ? formatDateTime(email.date) : ''}
            </span>
            {expanded ? (
              <ChevronUp size={14} className="text-mail-text-muted" />
            ) : (
              <ChevronDown size={14} className="text-mail-text-muted" />
            )}
          </div>
        </div>

        {/* To/CC line (visible when parent is expanded) */}
        {expanded && (
          <div className="text-xs text-mail-text-muted mt-1">
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

            {/* Extended details */}
            <AnimatePresence>
              {headerExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="mt-1 space-y-0.5 overflow-hidden"
                >
                  <div>Date: {email.date ? formatDateTime(email.date) : 'Unknown'}</div>
                  {email.messageId && <div className="break-all">Message-ID: {email.messageId}</div>}
                  {email.replyTo?.length > 0 && (
                    <div>Reply-To: {email.replyTo.map(r => r.address || r).join(', ')}</div>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleRaw?.(); }}
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
        )}
      </div>
    </div>
  );
});
