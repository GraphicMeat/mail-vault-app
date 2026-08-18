import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, HardDrive } from 'lucide-react';
import { useMailStore } from '../../stores/mailStore';

/**
 * Where a message lives, as one glyph.
 *
 * Three axes, two of them tri-valued: the vault (archived or not), the server
 * (present / absent / unknown) and the backup mirror (present / absent /
 * unknown). Twelve semantic states collapse to nine renderings — `archived`
 * and `archived-server-unknown` share a glyph and differ only in wording,
 * because the visual claim they make is genuinely the same one.
 *
 * The rule the whole file exists to enforce: amber — "deleted from the server,
 * this is your only copy" — requires PROOF of server absence. An unverified
 * server uid set means "not asked yet", so it renders as a plain archived row
 * and says so in the tooltip. Rendering the alarm on an unanswered question
 * made every account switch flash "deleted from server" across the list.
 */

export function describeMessageState(email, { backedUp = false, serverKnown = false } = {}) {
  const dot = backedUp === null ? 'hollow' : backedUp ? 'filled' : null;
  const dotSuffix = dot === 'filled' ? '-backed-up' : dot === 'hollow' ? '-backup-unknown' : '';

  // A row that came from the server list is server-known by construction —
  // the flag describes the completeness of the uid set, not this row.
  if (!email?.isArchived) {
    return {
      id: `server-only${dotSuffix}`,
      icon: 'cloud',
      tone: 'server',
      dot,
      label: dot === 'filled' ? 'On the server and backup drive' : 'On the server',
      detail: dot === 'filled'
        ? 'Not in your vault — restore it to read it here.'
        : dot === 'hollow'
          ? "Not in your vault. Backup drive not connected — can't verify."
          : 'Not saved to your vault yet.',
    };
  }

  const provenGone = email.source === 'local-only' && serverKnown;

  if (provenGone) {
    return {
      id: `local-only${dotSuffix}`,
      icon: 'drive',
      tone: 'warning',
      dot,
      label: dot === 'filled'
        ? 'In your vault and backup drive'
        : dot === 'hollow' ? 'Your only known copy' : 'Your only copy',
      detail: dot === 'filled'
        ? 'Deleted from the server. Two copies left.'
        : dot === 'hollow'
          ? "Deleted from the server. Backup drive not connected — can't verify."
          : 'Deleted from the server. Nothing else has it.',
    };
  }

  const unknownServer = !serverKnown;
  return {
    id: `archived${unknownServer ? '-server-unknown' : ''}${dotSuffix}`,
    icon: 'drive',
    tone: 'local',
    dot,
    label: dot === 'filled' ? 'Saved in your vault and backup drive' : 'Saved in your vault',
    detail: (unknownServer ? 'Server copy not verified yet.' : 'Also still on the server.')
      + (unknownServer && dot === 'hollow' ? ' Backup drive not connected.' : '')
      + (!unknownServer && dot === 'filled' ? ' Three copies.' : '')
      + (!unknownServer && dot === 'hollow' ? " Backup drive not connected — can't verify." : ''),
  };
}

const TONE_CLASS = {
  server: 'text-mail-server',
  local: 'text-mail-local',
  warning: 'text-mail-warning',
};

const DOT_CLASS = {
  filled: 'bg-mail-local border-mail-local',
  hollow: 'bg-transparent border-mail-text-muted',
};

/**
 * Hover/focus tooltip. Portals to <body> because every consumer of this
 * component sits inside a virtualized list whose rows clip their overflow —
 * an in-flow tooltip is invisible for the top and bottom rows.
 */
export function StateTooltip({ label, detail, children, testId = 'msg-state-icon', state }) {
  const [pos, setPos] = useState(null);
  const ref = useRef(null);

  const open = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    // The legend sits on the window's bottom edge, where a below-anchored
    // tooltip renders off-screen entirely. Flip above there — and anchor the
    // flipped one by `bottom`, so the browser keeps it on-screen whatever its
    // real height. ponytail: 120 only picks the side, no measuring pass.
    const above = r.bottom + 120 > window.innerHeight;
    // Centering on an icon near either edge pushes half the tooltip out of
    // view; clamp against max-w-[240px] plus an 8px margin.
    const half = 128;
    const left = Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half);
    setPos(above
      ? { bottom: window.innerHeight - r.top + 6, left }
      : { top: r.bottom + 6, left });
  }, []);
  const close = useCallback(() => setPos(null), []);

  const isOpen = pos !== null;
  useEffect(() => {
    if (!isOpen) return;
    // The virtualized list scrolls an internal container, and `scroll`
    // doesn't bubble to window — capture is the only phase that sees it.
    // Close rather than reposition: cheaper, and correct for a hover tooltip.
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [isOpen, close]);

  return (
    <>
      <span
        ref={ref}
        data-testid={testId}
        data-state={state}
        tabIndex={0}
        className="inline-flex items-center justify-center relative outline-none focus-visible:ring-1 focus-visible:ring-mail-accent rounded"
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
      >
        {children}
      </span>
      {pos && createPortal(
        <div
          role="tooltip"
          data-testid="msg-state-tooltip"
          style={{ ...pos, transform: 'translateX(-50%)' }}
          className="fixed z-[9999] max-w-[240px] px-2.5 py-1.5 rounded-md pointer-events-none
                     bg-mail-surface border border-mail-border shadow-lg text-xs"
        >
          <div className="font-semibold text-mail-text">{label}</div>
          <div className="text-mail-text-muted mt-0.5">{detail}</div>
        </div>,
        document.body
      )}
    </>
  );
}

export function MessageStateIcon({ email, size = 14, backedUp = false, serverKnown = false }) {
  const state = describeMessageState(email, { backedUp, serverKnown });
  const Glyph = state.icon === 'cloud' ? Cloud : HardDrive;

  return (
    <StateTooltip label={state.label} detail={state.detail} state={state.id}>
      <span className="relative inline-flex">
        <Glyph size={size} className={TONE_CLASS[state.tone]} />
        {state.dot && (
          <span
            data-dot={state.dot}
            className={`absolute -bottom-0.5 -right-0.5 w-[6px] h-[6px] rounded-full border ${DOT_CLASS[state.dot]}`}
          />
        )}
      </span>
    </StateTooltip>
  );
}

/**
 * Store-connected form. Rows use this; the plain MessageStateIcon stays pure
 * for tests and for the legend, which has no email to describe.
 */
export function ConnectedStateIcon({ email, size = 14 }) {
  const backedUpKeys = useMailStore(s => s.backedUpKeys);
  const serverKnown = useMailStore(s => s.serverUids.complete);
  const key = `${email._accountId || useMailStore.getState().activeAccountId}:${email.uid}`;
  const backedUp = backedUpKeys === null ? null : backedUpKeys.has(key);
  return <MessageStateIcon email={email} size={size} backedUp={backedUp} serverKnown={serverKnown} />;
}
