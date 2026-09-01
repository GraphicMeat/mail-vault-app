import { t } from '../i18n/index.js';
// The words this product uses for where a message lives, in one place.
//
// PRODUCT.md fixes the vocabulary: the place a copy is kept is "your vault",
// the place it came from is "the server", and the external mirror is "your
// backup drive". The app used to say "this computer", "your device" and
// "locally archived" for the same thing in different dialogs, so the
// per-message state glyph and the confirmation about that message disagreed.
//
// The delete confirmations also used to claim "This cannot be undone" for
// every server delete. That is only true when no vault copy exists. Deleting
// from a server is a supported, encouraged operation here — over-warning
// about the safe case teaches people to click through the warning that
// matters. Say which of the three cases they are in instead.

/**
 * What a server delete costs, given how many of the messages the vault holds.
 * Written to follow a lead clause that already named the action and the count.
 *
 * @param {number} total   messages the delete will touch
 * @param {number} inVault how many of them already have a vault copy
 */
export function vaultClause(total, inVault) {
  if (inVault === 0) {
    return t('custody.noCopyVaultSoCannot');
  }
  if (inVault >= total) {
    return total === 1
      ? t('custody.vaultKeepsCopyPutBack')
      : t('custody.vaultKeepsCopiesPutThem');
  }
  const exposed = total - inVault;
  return t('custody.themVaultOtherOnlyServer', { inVault: inVault.toLocaleString(), exposed: exposed.toLocaleString(), exposed2: exposed === 1 ? 'exists' : 'exist' });
}

/** Confirmation body for "Delete from server" on a row or a thread. */
export function describeServerDelete(total, inVault) {
  const lead = total === 1
    ? t('custody.emailLeavesServer')
    : t('custody.theseEmailsLeaveServer', { total: total.toLocaleString() });
  return `${lead} ${vaultClause(total, inVault)}`;
}


// Which label each scope earns. Also the gate: a scope with no copy of our own
// has no entry, and a caller with no entry has no item to render.
const PURGE_LABEL_KEY = {
  v: 'rowMenu.deleteVault',
  vb: 'rowMenu.deleteVaultBackup',
  b: 'rowMenu.deleteBackup',
  sv: 'rowMenu.deleteServerVault',
  sb: 'rowMenu.deleteServerBackup',
  svb: 'rowMenu.deleteServerVaultBackup',
};

/**
 * "Delete everywhere", named for the places this message is actually in.
 *
 * The purge itself is unchanged — it clears the server, the vault and the
 * backup mirror in that order — but saying "Delete everywhere" over a message
 * the vault has never held offers to destroy something that is not there, and
 * the row menu offered exactly that on every server-only message: the same
 * work as the "Delete from server" one line above it, under a name claiming
 * far more, over a confirmation that promised to clear a vault and a backup
 * drive that had never held it.
 *
 * @param {{server:boolean, vault:boolean, backup:boolean}} scope where the
 *        messages this row acts on live, ORed over the whole set
 * @param {number} total how many messages that is
 * @returns {{label:string, title:string, description:string}|null}
 *          null when nothing but the server holds them — no item belongs here
 */
export function describePurge({ server = false, vault = false, backup = false } = {}, total = 1) {
  const key = PURGE_LABEL_KEY[`${server ? 's' : ''}${vault ? 'v' : ''}${backup ? 'b' : ''}`];
  if (!key) return null;
  return {
    label: t(key),
    // One title for all six scopes: the button under it already names the
    // places, and six more translated question forms buy nothing.
    title: t('rowMenu.deletePermanently2'),
    // `count` is the raw number — a formatted one selects no plural category
    // and renders the key itself.
    description: t('custody.purgeNothingLeft', { count: total }),
  };
}
