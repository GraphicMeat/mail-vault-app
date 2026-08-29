import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, CloudOff, HardDrive } from 'lucide-react';
import { useMailStore } from '../../stores/mailStore';
import { custodyProof, custodySource } from '../../stores/slices/custody';
import { t } from '../../i18n/index.js';

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
 * for ordinary archived mail. Three proofs qualify — the message was created
 * here and never had a server copy, this app deleted the server copy, or a
 * Message-ID sweep of every folder came back empty (probeServerCopy).
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
      // The vault absence belongs in the LABEL here. "On the server and backup
      // drive" names two places, neither of them the vault, and a user scanning
      // only the bold line reads that as safe.
      label: dot === 'filled' ? t('email.state.serverBackupDriveVault') : t('email.state.server'),
      detail: dot === 'filled'
        ? t('email.state.vaultRestoreReadHere')
        : dot === 'hollow'
          ? t('email.state.vaultBackupDriveConnectedT')
          : t('email.state.savedVaultYet'),
    };
  }

  // `email.source` is what the list derived, and the list derives it here —
  // custodySource, not a uid set. Recomputed rather than trusted when the
  // caller handed over a copy the derivation never touched (the viewer's).
  const provenGone = (email.source ?? custodySource(email)) === 'local-only';

  if (provenGone) {
    // Three ways to be the only copy, and they are not the same news. A staged
    // send never existed on a server; a delete this app issued cleared one
    // mailbox; a completed Message-ID sweep that found nothing means the server
    // lost it without being asked to — someone else deleted it. Say which.
    //
    // A row stamped 'local-only' with no proof field on it is the oldest of the
    // three by construction (nothing else could have stamped it), so that is
    // where the fallback lands.
    const proof = custodyProof(email) || 'never-on-server';
    // Only a delete this app issued leaves other copies plausible: it clears one
    // mailbox, and a label store (Gmail) keeps its own under All Mail or the Bin.
    // The sweep visited those.
    const nothingElseHasIt = proof !== 'we-deleted';
    const gone = proof === 'never-on-server' ? t('email.state.wasNeverServer')
      : proof === 'we-deleted' ? t('email.state.deletedServerCopy')
      : t('email.state.someoneElseDeletedServerCopy');
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
        ? t('email.state.vaultBackupDrive')
        : dot === 'hollow' ? t('email.state.onlyKnownCopy') : t('email.state.onlyCopy'),
      detail: dot === 'filled'
        ? t('email.state.twoCopiesLeft', { gone })
        : dot === 'hollow'
          ? t('email.state.backupDriveConnectedTVerify', { gone })
          : nothingElseHasIt ? t('email.state.nothingElse', { gone }) : gone,
    };
  }

  const unknownServer = !serverKnown;
  return {
    id: `archived${unknownServer ? '-server-unknown' : ''}${dotSuffix}`,
    icon: 'drive',
    tone: 'local',
    dot,
    label: dot === 'filled' ? t('email.state.savedVaultBackupDrive') : t('email.state.savedVault'),
    detail: (unknownServer ? t('email.state.serverCopyVerifiedYet') : t('email.state.alsoStillServer'))
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

// Deliberately hueless. The dot is a MODIFIER: it rides on all three base
// glyphs, so painting it in `--mail-local` (Vault Emerald, the "on your disk"
// token) put a green in-your-vault pip on a blue server-only cloud sitting
// directly above the words "Not saved to your vault yet". Fill vs outline
// carries this axis; colour is reserved for the base glyph alone.
const DOT_CLASS = {
  filled: 'bg-mail-text border-mail-text',
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
 * Does the backup mirror hold this row — true / false / null for "no answer".
 *
 * The ONE place the mirror key is built. It was computed inline in
 * ConnectedStateIcon and not at all in EmailViewer, so the viewer's band said
 * "On the server" while the row icon two lines below it said "On the server and
 * backup drive" about the same message. One builder, both callers.
 *
 * Scope, not just uid: a uid identifies a message inside one mailbox only.
 */
export function useBackedUp(email) {
  const backedUpKeys = useMailStore(s => s.backedUpKeys);
  const backedUpScopes = useMailStore(s => s.backedUpScopes);
  const backupConfigured = useMailStore(s => s.backupConfigured);
  const activeAccountId = useMailStore(s => s.activeAccountId);
  const activeMailbox = useMailStore(s => s.activeMailbox);
  // No backup drive at all: there is nowhere for a second copy to be, so the
  // axis does not apply and nothing is drawn or said. Checked BEFORE the null
  // test, which is the different case of a drive that exists and went unread.
  if (backupConfigured === false) return false;
  if (!email || backedUpKeys === null) return null;
  const accountId = email._accountId || activeAccountId;
  // A row that carries no folder tag is from the active view by construction —
  // the same rule custodyRowFor matches rows by.
  const mailbox = email._mailbox || (activeMailbox === 'UNIFIED' ? 'INBOX' : activeMailbox);
  const scope = `${accountId}:${mailbox}`;
  // Absence from a mailbox nobody read is not evidence that the drive lacks it.
  if (backedUpScopes && !backedUpScopes.has(scope)) return null;
  return backedUpKeys.has(`${scope}:${email.uid}`);
}

/**
 * Store-connected form. Rows use this; the plain MessageStateIcon stays pure
 * for tests and for the legend, which has no email to describe.
 */
export function ConnectedStateIcon({ email, size = 14 }) {
  const backedUp = useBackedUp(email);
  const serverKnown = useMailStore(s => s.serverUids.complete);
  return <MessageStateIcon email={email} size={size} backedUp={backedUp} serverKnown={serverKnown} />;
}
