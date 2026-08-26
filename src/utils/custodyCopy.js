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
    return 'No copy is in your vault, so this cannot be undone.';
  }
  if (inVault >= total) {
    return total === 1
      ? 'Your vault keeps the copy, and you can put it back on the server later.'
      : 'Your vault keeps the copies, and you can put them back on the server later.';
  }
  const exposed = total - inVault;
  return `${inVault.toLocaleString()} of them are in your vault. The other ${exposed.toLocaleString()} ${exposed === 1 ? 'exists' : 'exist'} only on the server and will be gone for good.`;
}

/** Confirmation body for "Delete from server" on a row or a thread. */
export function describeServerDelete(total, inVault) {
  const lead = total === 1
    ? 'This email leaves the server.'
    : `These ${total.toLocaleString()} emails leave the server.`;
  return `${lead} ${vaultClause(total, inVault)}`;
}

/**
 * Confirmation body for "Delete everywhere" — server, vault and backup drive.
 * Custody makes no difference here: nothing survives either way.
 */
export function describeDeleteEverywhere(total) {
  return total === 1
    ? 'This email leaves the server, your vault, and your backup drive. No copy will be left anywhere. This cannot be undone.'
    : `These ${total.toLocaleString()} emails leave the server, your vault, and your backup drive. No copy will be left anywhere. This cannot be undone.`;
}
