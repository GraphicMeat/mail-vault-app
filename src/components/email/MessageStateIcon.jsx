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
