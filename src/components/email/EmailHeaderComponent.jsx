import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';
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

// ── Auth Detail Popover ────────────────────────────────────────────────

export function AuthDetailPopover({ email, onClose }) {
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
    if (result === 'pass' || result === 'bestguesspass') return <span className="inline-block w-2 h-2 rounded-full bg-green-500" />;
    if (result === 'fail' || result === 'softfail') return <span className="inline-block w-2 h-2 rounded-full bg-red-500" />;
    return <span className="inline-block w-2 h-2 rounded-full bg-gray-400" />;
  };

  const senderIssues = verification.issues?.filter(i => i.level === 'danger' || i.level === 'warning') || [];

  return (
    <div ref={popoverRef} className="absolute z-50 top-full left-0 mt-1 bg-mail-surface border border-mail-border rounded-lg shadow-lg p-3 min-w-[240px] max-w-[320px]"
         onClick={(e) => e.stopPropagation()}>
      <div className="text-xs font-semibold text-mail-text mb-2">Sender Details</div>

      {/* Sender identity */}
      <div className="space-y-1 mb-2 text-xs">
        <div className="flex items-start gap-2">
          <span className="text-mail-text-muted w-16 flex-shrink-0">From</span>
          <span className="text-mail-text break-all">{email?.from?.address || 'unknown'}</span>
        </div>
        {email?.from?.name && email.from.name !== email.from.address && (
          <div className="flex items-start gap-2">
            <span className="text-mail-text-muted w-16 flex-shrink-0">Name</span>
            <span className="text-mail-text break-all">{email.from.name}</span>
          </div>
        )}
      </div>

      {/* Sender issues (impersonation, mismatches) */}
      {senderIssues.length > 0 && (
        <div className="space-y-1.5 mb-2 border-t border-mail-border pt-2">
          {senderIssues.map((issue, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 mt-1 ${issue.level === 'danger' ? 'bg-red-500' : 'bg-orange-500'}`} />
              <span className={issue.level === 'danger' ? 'text-red-500' : 'text-orange-500'}>{issue.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Authentication results */}
      {hasAuth ? (
        <div className="space-y-1.5 border-t border-mail-border pt-2">
          <div className="text-xs font-semibold text-mail-text mb-1">Authentication</div>
          <div className="flex items-center gap-2 text-xs">
            <StatusDot result={auth.spf} />
            <span className="text-mail-text-muted w-12">SPF</span>
            <span className="text-mail-text">{auth.spf || 'none'}</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <StatusDot result={auth.dkim} />
            <span className="text-mail-text-muted w-12">DKIM</span>
            <span className="text-mail-text">{auth.dkim || 'none'}</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <StatusDot result={auth.dmarc} />
            <span className="text-mail-text-muted w-12">DMARC</span>
            <span className="text-mail-text">{auth.dmarc || 'none'}</span>
          </div>
          {replyToAddr && (
            <div className="flex items-center gap-2 text-xs border-t border-mail-border pt-1.5 mt-1.5">
              <span className={`inline-block w-2 h-2 rounded-full ${replyToMatches ? 'bg-green-500' : 'bg-orange-500'}`} />
              <span className="text-mail-text-muted">Reply-To</span>
              <span className="text-mail-text">{replyToMatches ? 'matches sender' : replyToAddr}</span>
            </div>
          )}
        </div>
      ) : senderIssues.length === 0 ? (
        <div className="text-xs text-mail-text-muted border-t border-mail-border pt-2">
          No authentication data available for this email. The sender's mail server did not include SPF, DKIM, or DMARC headers.
        </div>
      ) : null}
    </div>
  );
}

// ── Sender Verification Badge ────────────────────────────────────────────────

export function SenderVerificationBadge({ email, size = 14 }) {
  const [showPopover, setShowPopover] = useState(false);
  const { status, tooltip } = useMemo(
    () => checkSenderVerification(email),
    [email?.from, email?.replyTo, email?.returnPath, email?.authenticationResults]
  );

  if (status === 'none') return null;

  const colorClass = status === 'verified' ? 'text-green-500' : status === 'warning' ? 'text-orange-500' : 'text-red-500';
  const Icon = status === 'verified' ? ShieldCheck : status === 'warning' ? AlertTriangle : ShieldAlert;

  return (
    <span className="relative inline-flex items-center flex-shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); setShowPopover(!showPopover); }}
        className={`${colorClass} hover:opacity-80 transition-opacity`}
        title={tooltip}
      >
        <Icon size={size} />
      </button>
      {showPopover && (
        <AuthDetailPopover email={email} onClose={() => setShowPopover(false)} />
      )}
    </span>
  );
}

// ── Email Header ────────────────────────────────────────────────────────────

export function EmailHeader({ email, expanded, onToggle, showRaw, onToggleRaw, loadingRaw, showInsights, onToggleInsights }) {
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
            <button
              data-testid="sender-insights-toggle"
              onClick={(e) => { e.stopPropagation(); onToggleInsights?.(); }}
              className={`p-0.5 rounded transition-colors flex-shrink-0 ${showInsights ? 'text-mail-accent' : 'text-mail-text-muted hover:text-mail-text'}`}
              title="Sender insights"
            >
              <Info size={14} />
            </button>
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
