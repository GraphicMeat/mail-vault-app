import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, CloudOff, HardDrive } from 'lucide-react';
import { useMailStore } from '../../stores/mailStore';
import { custodySource } from '../../stores/slices/custody';

/**
 * Where a message lives, as one glyph.
 *
 * Three axes, two of them tri-valued: the vault (archived or not), the server
 * (present / absent / unknown) and the backup mirror (present / absent /
 * unknown). Twelve semantic states collapse to nine renderings — `archived`
 * and `archived-server-unknown` share a glyph and differ only in wording,
 * because the visual claim they make is genuinely the same one.
 *
 * The rule the whole file exists to enforce: Only-Copy Gold — "the vault is the
 * copy you have left" — requires PROOF, and `custodySource` is the only place
 * that decides what counts as proof. It is never derived from the active
 * mailbox's uid set: a message missing from INBOX is routinely alive in All
 * Mail, a label, or the Bin, and stamping the alarm on that made the list gold
 * for ordinary archived mail. Two proofs qualify — the message was created here
 * and never had a server copy, or this app deleted the server copy.
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

  // `email.source` is what the list derived, and the list derives it here —
  // custodySource, not a uid set. Recomputed rather than trusted when the
  // caller handed over a copy the derivation never touched (the viewer's).
  const provenGone = (email.source ?? custodySource(email)) === 'local-only';

  if (provenGone) {
    // Never on a server at all (staged send, local draft) reads differently
    // from a server copy this app deleted, and the difference is the whole
    // reason the row is gold — say which one it is.
    const neverOnServer = email.serverDeleted !== true;
    const gone = neverOnServer ? 'It was never on the server.' : 'You deleted the server copy.';
    return {
      // Its own glyph, not the vault's. Emerald and gold converge under
      // deuteranopia and the tooltip is hover/focus-only, so with a shared
      // HardDrive the difference between "safe in your vault" and "the last
      // copy in existence" was carried by hue alone.
      id: `local-only${dotSuffix}`,
      icon: 'cloud-off',
      tone: 'only-copy',
      dot,
      label: dot === 'filled'
        ? 'In your vault and backup drive'
        : dot === 'hollow' ? 'Your only known copy' : 'Your only copy',
      detail: dot === 'filled'
        ? `${gone} Two copies left.`
        : dot === 'hollow'
          ? `${gone} Backup drive not connected — can't verify.`
          // "Nothing else has it" is only sayable about a message that never
          // reached a server. A delete this app issued clears one mailbox; a
          // label store (Gmail) keeps its own copy under All Mail or the Bin.
          : neverOnServer ? `${gone} Nothing else has it.` : gone,
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
  'only-copy': 'text-mail-only-copy',
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
                     bg-mail-surface border border-mail-border text-xs"
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
  const Glyph = state.icon === 'cloud' ? Cloud : state.icon === 'cloud-off' ? CloudOff : HardDrive;

  return (
    <StateTooltip label={state.label} detail={state.detail} state={state.id}>
      <span className="custody-chip" data-tone={state.tone}>
        <span className="custody-glyph">
          <Glyph size={size} className={TONE_CLASS[state.tone]} />
          {state.dot && (
            <span
              data-dot={state.dot}
              className={`absolute -bottom-0.5 -right-0.5 w-[6px] h-[6px] rounded-full border ${DOT_CLASS[state.dot]}`}
            />
          )}
        </span>
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
