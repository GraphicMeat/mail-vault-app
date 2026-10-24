/** Native fetch/cache provenance, carried by its original row through UI merges. */
export function nativeIdentityOf(value, accountId, mailbox) {
  if (!value || value.accountId !== accountId || value.mailbox !== mailbox
      || typeof value.originHash !== 'string' || !value.originHash) return null;
  return Object.freeze({ accountId, mailbox, uidValidity: value.uidValidity ?? null, originHash: value.originHash });
}

export function bindNativeRows(rows, identity, accountId, mailbox) {
  const proof = nativeIdentityOf(identity, accountId, mailbox);
  return (rows || []).map(row => {
    // A retained row already has its own association. A fresh batch cannot adopt it.
    const original = row._nativeIdentity
      ? nativeIdentityOf(row._nativeIdentity, accountId, mailbox) : proof;
    return original ? { ...row, _nativeIdentity: original } : row;
  });
}

export function bindNativeBatch(batch, accountId, mailbox) {
  if (!batch) return batch;
  const nativeIdentity = nativeIdentityOf(batch.nativeIdentity, accountId, mailbox);
  return { ...batch, nativeIdentity, emails: bindNativeRows(batch.emails, nativeIdentity, accountId, mailbox) };
}

export function coherentNativeIdentity(rows, accountId, mailbox) {
  if (!rows?.length) return null;
  const proof = nativeIdentityOf(rows[0]._nativeIdentity, accountId, mailbox);
  if (!proof) return null;
  return rows.every(row => {
    const own = nativeIdentityOf(row._nativeIdentity, accountId, mailbox);
    return own && own.originHash === proof.originHash && own.uidValidity === proof.uidValidity;
  }) ? proof : null;
}
