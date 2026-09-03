import React, { useState, useEffect, useRef, useMemo } from 'react';
import { displayText } from '../../utils/bidiText';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDateTime } from '../../utils/dateFormat';
import {
  ChevronDown,
  ChevronUp,
  Code,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Info,
} from 'lucide-react';
import { checkSenderVerification, parseAuthResults } from '../../utils/senderCheck';
import { getSenderName } from '../../utils/emailParser';
import { useViewportShift } from '../../hooks/useViewportShift';
import { t, useT  } from '../../i18n/index.js';

// ── Auth Detail Popover ────────────────────────────────────────────────

export function AuthDetailPopover({ email, onClose, anchorRect }) {
  const t = useT();
  const popoverRef = useRef(null);
  const auth = useMemo(() => parseAuthResults(email?.authenticationResults), [email?.authenticationResults]);
  const verification = useMemo(() => checkSenderVerification(email), [email?.from, email?.replyTo, email?.returnPath, email?.authenticationResults]);
  const hasAuth = auth.spf !== null || auth.dkim !== null || auth.dmarc !== null;

  // Check reply-to match
  const fromDomain = email?.from?.address?.split('@')[1]?.toLowerCase() || '';
  const replyToAddr = Array.isArray(email?.replyTo) ? email.replyTo[0]?.address : email?.replyTo?.address;
  const replyToDomain = replyToAddr?.split('@')[1]?.toLowerCase() || '';
  const replyToMatches = !replyToAddr || replyToDomain === fromDomain;

  useEffect(() => {
    const handleClick = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const StatusDot = ({ result }) => {
    if (result === 'pass' || result === 'bestguesspass') return <span className="inline-block w-2 h-2 rounded-full bg-mail-success" />;
    if (result === 'fail' || result === 'softfail') return <span className="inline-block w-2 h-2 rounded-full bg-mail-danger" />;
    return <span className="inline-block w-2 h-2 rounded-full bg-mail-text-muted" />;
  };

  const senderIssues = verification.issues?.filter(i => i.level === 'danger' || i.level === 'warning') || [];

  // Fixed position from the anchor, with viewport edge detection. Rendered via
  // portal — an inline absolute popover gets clipped/overlapped inside
  // collapsed thread rows (row containers stack above it).
  const position = useMemo(() => {
    if (!anchorRect) return null;
    const WIDTH = 320;
    const HEIGHT = 260;
    const MARGIN = 8;
    let top = anchorRect.bottom + 4;
    let left = anchorRect.left;
    if (top + HEIGHT > window.innerHeight) top = Math.max(MARGIN, anchorRect.top - HEIGHT - 4);
    if (left + WIDTH > window.innerWidth) left = window.innerWidth - WIDTH - MARGIN;
    if (left < MARGIN) left = MARGIN;
    return { top, left };
  }, [anchorRect]);
  // The guess above uses a fixed HEIGHT; the panel's real height (an issues
  // list, a long chain of headers) is measured once it exists.
  useViewportShift(popoverRef, true, [position]);

  const popover = (
    <div ref={popoverRef}
         className={`${position ? 'fixed' : 'absolute top-full left-0 mt-1'} z-50 bg-mail-surface border border-mail-border rounded-lg p-3 min-w-[240px] max-w-[320px]`}
         style={position || undefined}
         onClick={(e) => e.stopPropagation()}>
      <div className="text-xs font-semibold text-mail-text mb-2">{t('email.header.senderDetails')}</div>

      {/* Sender identity */}
      <div className="space-y-1 mb-2 text-xs">
        <div className="flex items-start gap-2">
          <span className="text-mail-text-muted w-16 flex-shrink-0">{t('common.from')}</span>
          <span className="text-mail-text break-all">{email?.from?.address || 'unknown'}</span>
        </div>
        {email?.from?.name && email.from.name !== email.from.address && (
          <div className="flex items-start gap-2">
            <span className="text-mail-text-muted w-16 flex-shrink-0">{t('email.header.name')}</span>
            <span className="text-mail-text break-all">{email.from.name}</span>
          </div>
        )}
      </div>

      {/* Sender issues (impersonation, mismatches) */}
      {senderIssues.length > 0 && (
        <div className="space-y-1.5 mb-2 border-t border-mail-border pt-2">
          {senderIssues.map((issue, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 mt-1 ${issue.level === 'danger' ? 'bg-mail-danger' : 'bg-mail-warning'}`} />
              <span className={issue.level === 'danger' ? 'text-mail-danger' : 'text-mail-warning'}>{issue.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Authentication results */}
      {hasAuth ? (
        <div className="space-y-1.5 border-t border-mail-border pt-2">
          <div className="text-xs font-semibold text-mail-text mb-1">{t('email.header.authentication')}</div>
          <div className="flex items-center gap-2 text-xs">
            <StatusDot result={auth.spf} />
            <span className="text-mail-text-muted w-12">{t('email.header.spf')}</span>
            <span className="text-mail-text">{auth.spf || 'none'}</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <StatusDot result={auth.dkim} />
            <span className="text-mail-text-muted w-12">{t('email.header.dkim')}</span>
            <span className="text-mail-text">{auth.dkim || 'none'}</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <StatusDot result={auth.dmarc} />
            <span className="text-mail-text-muted w-12">{t('email.header.dmarc')}</span>
            <span className="text-mail-text">{auth.dmarc || 'none'}</span>
          </div>
          {replyToAddr && (
            <div className="flex items-center gap-2 text-xs border-t border-mail-border pt-1.5 mt-1.5">
              <span className={`inline-block w-2 h-2 rounded-full ${replyToMatches ? 'bg-mail-success' : 'bg-mail-warning'}`} />
              <span className="text-mail-text-muted">{t('email.header.reply')}</span>
              <span className="text-mail-text">{replyToMatches ? t('email.header.matchesSender') : replyToAddr}</span>
            </div>
          )}
        </div>
      ) : senderIssues.length === 0 ? (
        <div className="text-xs text-mail-text-muted border-t border-mail-border pt-2">
          {t('email.header.noAuthenticationDataAvailableEmail')}
        </div>
      ) : null}
    </div>
  );

  return position ? createPortal(popover, document.body) : popover;
}

// ── Sender Verification Badge ────────────────────────────────────────────────

export function SenderVerificationBadge({ email, size = 14 }) {
  const [popoverAnchor, setPopoverAnchor] = useState(null);
  const { status, tooltip } = useMemo(
    () => checkSenderVerification(email),
    [email?.from, email?.replyTo, email?.returnPath, email?.authenticationResults]
  );

  if (status === 'none') return null;

  const colorClass = status === 'verified' ? 'text-mail-success' : status === 'warning' ? 'text-mail-warning' : 'text-mail-danger';
  const Icon = status === 'verified' ? ShieldCheck : status === 'warning' ? AlertTriangle : ShieldAlert;

  return (
    <span className="relative inline-flex items-center flex-shrink-0">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setPopoverAnchor(popoverAnchor ? null : e.currentTarget.getBoundingClientRect());
        }}
        className={`${colorClass} hover:opacity-80 transition-opacity`}
        title={tooltip}
      >
        <Icon size={size} />
      </button>
      {popoverAnchor && (
        <AuthDetailPopover email={email} anchorRect={popoverAnchor} onClose={() => setPopoverAnchor(null)} />
      )}
    </span>
  );
}

// ── Email Header ────────────────────────────────────────────────────────────

export function EmailHeader({ email, expanded, onToggle, showRaw, onToggleRaw, loadingRaw, showInsights, onToggleInsights }) {
  const t = useT();
  return (
    <div
      className="p-4 border-b border-mail-border cursor-pointer"
      onClick={onToggle}
    >
      <div className="flex items-start gap-4">
        {/* Avatar */}
        <div className="w-10 h-10 bg-mail-accent rounded-full flex items-center justify-center flex-shrink-0">
          <span className="text-white font-semibold text-sm">
            {getSenderName(email)[0].toUpperCase()}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span dir="auto" className="font-semibold text-mail-text">
              {displayText(getSenderName(email))}
            </span>
            <SenderVerificationBadge email={email} />
            {email.from?.name && (
              <span className="text-sm text-mail-text-muted">
                &lt;{email.from.address}&gt;
              </span>
            )}
            <button
              data-testid="sender-insights-toggle"
              onClick={(e) => { e.stopPropagation(); onToggleInsights?.(); }}
              className={`p-0.5 rounded transition-colors flex-shrink-0 ${showInsights ? 'text-mail-accent-text' : 'text-mail-text-muted hover:text-mail-text'}`}
              title={t('email.header.senderInsights')}
            >
              <Info size={14} />
            </button>
          </div>

          <div className="text-sm text-mail-text-muted">
            {t('email.header.to', { to: (Array.isArray(email.to) ? email.to : []).map(x => x.name || x.address).join(', ') || t('settings.cleanup.unknown') })}
            {email.cc?.length > 0 && (
              <span className="ml-2">
                {t('email.header.cc', { cc: email.cc.map(c => c.name || c.address).join(', ') })}
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
                <div>{t('email.header.date', { date: formatDateTime(email.date) })}</div>
                {email.messageId && <div>{t('email.header.messageId', { messageId: email.messageId })}</div>}
                {email.replyTo?.length > 0 && (
                  <div>{t('email.header.replyTo', { replyTo: email.replyTo.map(r => r.address).join(', ') })}</div>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleRaw(); }}
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

        <div className="flex items-center gap-2 text-sm text-mail-text-muted">
          <span>{formatDateTime(email.date)}</span>
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </div>
    </div>
  );
}
