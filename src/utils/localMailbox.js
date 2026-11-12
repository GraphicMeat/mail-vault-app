// Vault-only (local) folder check, shared by the stores and the workflows.

/**
 * Is `path` one of `accountId`'s vault-only folders? No server holds one, so
 * every workflow that would ask a server about it asks this first.
 * `localFolders` is the store's `{ [accountId]: [{ name, dir, ... }] }`.
 *
 * By display name (the sidebar's rows) OR directory: a search or saved-view
 * hit from one names its folder by the vault directory, since the daemon only
 * knows the server's names. The daemon maps both to the same directory.
 */
export function isLocalMailbox(localFolders, accountId, path) {
  return !!path && !!localFolders?.[accountId]?.some(f => f.name === path || f.dir === path);
}
