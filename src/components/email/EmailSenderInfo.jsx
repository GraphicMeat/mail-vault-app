import React, { useState, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDateTime } from '../../utils/dateFormat';
import {
  ChevronDown,
  ChevronUp,
  Info,
  Code,
  RefreshCw,
} from 'lucide-react';
import { SenderVerificationBadge } from './EmailHeaderComponent';
import { SenderInfoPopover } from './SenderInfoPopover';
import { getSenderName } from '../../utils/emailParser';
import { t, useT  } from '../../i18n/index.js';

/**
 * Shared sender info component with three variants: single, thread, chat.
 * Renders avatar, sender name, email, DKIM shield, insights button,
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
  const t = useT();
  const [headerExpanded, setHeaderExpanded] = useState(false);
  // Sender Details popover (parity with chat view) — anchored to the clicked element
  const [detailsAnchor, setDetailsAnchor] = useState(null);
  const openDetails = (e) => {
    e.stopPropagation();
    setDetailsAnchor(e.currentTarget.getBoundingClientRect());
  };

  const senderName = getSenderName(email);
  const initial = senderName ? senderName[0].toUpperCase() : '?';
  const hasDistinctName = email?.from?.name && email.from.name !== email.from.address;

  // No custody glyph here. The band directly above this line already states
  // where the message lives, in words, from the ROW's derivation
  // (EmailViewer — custodyRowFor). This line could only ever restate it from a
  // weaker one: `email` is the viewer's own fetched copy, which never carries
  // `.isArchived`, so the glyph fell back to `archivedEmailIds.has(uid)` — a
  // uid set — and printed "On the server · Not saved to your vault yet" under a
  // band reading "Saved in your vault". Two statements 40px apart, and the
  // small one was wrong. archivedEmailIds is still passed on to the popover,
  // which is the only custody statement on ITS surface.

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
      {/* Avatar — click opens Sender Details (parity with chat view) */}
      <div
        className="w-8 h-8 bg-mail-accent rounded-full flex items-center justify-center flex-shrink-0 cursor-pointer"
        onClick={openDetails}
        title={t('email.sender.senderDetails')}
      >
        <span className="text-white font-semibold text-xs">{initial}</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {/* Sender name — click opens Sender Details (parity with chat view) */}
            <span
              className="text-sm font-semibold text-mail-text truncate cursor-pointer hover:underline"
              onClick={openDetails}
            >
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
                {t('email.viaList', { listName })}
              </span>
            )}

            {/* Insights button */}
            <button
              data-testid="sender-insights-toggle"
              onClick={(e) => { e.stopPropagation(); onToggleInsights?.(); }}
              className={`p-0.5 rounded transition-colors flex-shrink-0 ${showInsights ? 'text-mail-accent-text' : 'text-mail-text-muted hover:text-mail-text'}`}
              title={t('email.sender.senderInsights')}
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
              {t('email.header.to', { to: (Array.isArray(email.to) ? email.to : []).map(x => x.name || x.address).join(', ') || t('settings.cleanup.unknown') })}
              {email.cc?.length > 0 && (
                <span className="ml-2">{t('email.header.cc', { cc: email.cc.map(c => c.name || c.address).join(', ') })}</span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); setHeaderExpanded(!headerExpanded); }}
                className="ml-2 text-mail-accent-text hover:underline"
              >
                {headerExpanded ? t('email.sender.less') : t('email.sender.more')}
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
                  <div>{t('email.header.date', { date: email.date ? formatDateTime(email.date) : t('settings.cleanup.unknown') })}</div>
                  {email.messageId && <div className="break-all">{t('email.header.messageId', { messageId: email.messageId })}</div>}
                  {email.replyTo?.length > 0 && (
                    <div>{t('email.header.replyTo', { replyTo: email.replyTo.map(r => r.address || r).join(', ') })}</div>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleRaw?.(); }}
                    disabled={loadingRaw}
                    className={`mt-2 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                               ${showRaw
                                 ? 'bg-mail-accent-fill text-white'
                                 : 'bg-mail-surface hover:bg-mail-surface-hover text-mail-text-muted'}
                               disabled:opacity-50`}
                  >
                    {loadingRaw ? (
                      <RefreshCw size={12} className="animate-spin" />
                    ) : (
                      <Code size={12} />
                    )}
                    {loadingRaw ? t('chat.bubble.loading') : showRaw ? t('email.sender.rendered') : t('email.sender.viewSource')}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {detailsAnchor && (
        <SenderInfoPopover
          email={email}
          anchorRect={detailsAnchor}
          onClose={() => setDetailsAnchor(null)}
          archivedEmailIds={archivedEmailIds}
        />
      )}
    </div>
  );
});
