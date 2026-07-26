/**
 * Cheap "did anything actually change?" probe for a mailbox.
 *
 * Switching accounts used to fire a full daemon sync every time — `sync.now`
 * plus a blocking `waitForSync(30s)` — even when the user had looked at that
 * account ten seconds earlier. This answers the same question with one SELECT
 * round-trip and no message data, so the common case (nothing changed) costs
 * ~100ms instead of a full sync.
 */

import * as api from './api';
import * as db from './db';

/** Skip even the probe if we checked this mailbox this recently. */
const PROBE_TTL_MS = 10_000;

/** `accountId\x01mailbox` → ms of the last probe/sync that found it current. */
const _lastVerified = new Map();

const _key = (accountId, mailbox) => `${accountId}\x01${mailbox}`;

/** Record that this mailbox is known current as of now. */
export function markVerified(accountId, mailbox) {
  _lastVerified.set(_key(accountId, mailbox), Date.now());
}

/** Forget a mailbox — forces the next probe to hit the server. */
export function invalidate(accountId, mailbox) {
  if (mailbox) {
    _lastVerified.delete(_key(accountId, mailbox));
    return;
  }
  const prefix = `${accountId}\x01`;
  for (const k of _lastVerified.keys()) {
    if (k.startsWith(prefix)) _lastVerified.delete(k);
  }
}

/**
 * Is the local cache already identical to what the server holds?
 *
 * Returns `{ unchanged, reason }`. Callers treat anything other than
 * `unchanged === true` as "run the sync" — including errors, so a probe that
 * fails can only cost an unnecessary sync, never a missed one.
 */
export async function mailboxIsUnchanged(account, accountId, mailbox) {
  const key = _key(accountId, mailbox);
  const since = Date.now() - (_lastVerified.get(key) ?? 0);
  if (since < PROBE_TTL_MS) {
    return { unchanged: true, reason: 'probed-recently' };
  }

  let meta;
  try {
    meta = await db.getEmailHeadersMeta(accountId, mailbox);
  } catch {
    return { unchanged: false, reason: 'meta-read-failed' };
  }

  // Nothing cached yet — there is no "unchanged" to speak of.
  if (!meta?.totalEmails) return { unchanged: false, reason: 'no-cache' };

  // The cache holds fewer messages than the mailbox has. The server may not
  // have changed at all, but WE are still short — a restored or migrated
  // mailbox sits here — so the sync (and the daemon backfill behind it) must
  // still run.
  if ((meta.totalCached ?? 0) < meta.totalEmails) {
    return { unchanged: false, reason: 'partial-cache' };
  }

  let status;
  try {
    status = await api.checkMailboxStatus(account, mailbox);
  } catch (e) {
    console.warn('[syncProbe] Status check failed, falling back to full sync:', e?.message || e);
    return { unchanged: false, reason: 'probe-failed' };
  }
  if (!status) return { unchanged: false, reason: 'probe-empty' };

  // The server re-issued its UID space; every cached UID means something else.
  if (status.uidValidity != null && meta.uidValidity != null
      && status.uidValidity !== meta.uidValidity) {
    return { unchanged: false, reason: 'uidvalidity-changed' };
  }

  // CONDSTORE: HIGHESTMODSEQ advances on ANY change — arrival, expunge, or a
  // bare flag edit. An unchanged value is proof nothing happened, which no
  // count comparison can give you: one arrival plus one expunge leaves the
  // message count identical (the blind spot documented in sync_engine.rs).
  if (status.highestModseq != null && meta.highestModseq != null) {
    return status.highestModseq === meta.highestModseq
      ? { unchanged: true, reason: 'modseq-match' }
      : { unchanged: false, reason: 'modseq-advanced' };
  }

  // No CONDSTORE. UIDNEXT is monotonic, so any arrival moves it — that closes
  // the +1/-1 hole, because an arrival paired with an expunge still bumps
  // UIDNEXT even though the count comes back level. EXISTS then covers the
  // expunge-without-arrival case. Both must match.
  //
  // Flag-only changes are invisible here. That is inherent to a server without
  // CONDSTORE, and matches what the delta sync itself can see.
  const uidNextSame = status.uidNext != null && meta.uidNext != null
    && status.uidNext === meta.uidNext;
  const existsSame = Number(status.exists) === Number(meta.totalEmails);

  if (uidNextSame && existsSame) return { unchanged: true, reason: 'uidnext-exists-match' };
  if (!uidNextSame) return { unchanged: false, reason: 'uidnext-advanced' };
  return { unchanged: false, reason: 'exists-changed' };
}
