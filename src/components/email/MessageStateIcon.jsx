import React, { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, HardDrive } from 'lucide-react';

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
    if (r) setPos({ top: r.bottom + 6, left: r.left + r.width / 2 });
  }, []);
  const close = useCallback(() => setPos(null), []);

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
          style={{ top: pos.top, left: pos.left, transform: 'translateX(-50%)' }}
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
