/**
 * The uids the server is known to hold for the active mailbox, and whether
 * that set is a COMPLETE enumeration of it.
 *
 * These travel together on purpose. They used to be two store fields, and
 * sixteen writers each had to remember to keep them in step — omitting the
 * flag from a setState patch silently preserved the previous mailbox's value,
 * because zustand shallow-merges. Four rounds of fixes each found more missed
 * sites. Binding them means a writer cannot supply uids without stating
 * completeness, and a missed site fails loudly at the first read instead of
 * inheriting a stale claim.
 *
 * `complete: false` is not "the mailbox is empty" — it is "we have not proven
 * what the server holds". The UI must never render its amber
 * "deleted from server" state from an incomplete set.
 */
export function serverUids(uids, { complete } = {}) {
  if (typeof complete !== 'boolean') {
    throw new TypeError('serverUids: `complete` must be an explicit boolean');
  }
  return { uids: uids instanceof Set ? uids : new Set(uids), complete };
}

export const NO_SERVER_UIDS = Object.freeze({ uids: new Set(), complete: false });
