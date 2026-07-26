/**
 * In-memory memo of COMPLETE header sets, so switching back to an account
 * doesn't re-read its cache off disk.
 *
 * The sidecar cache stores one JSON file per message. Rehydrating a 15,000
 * message mailbox therefore means a readdir plus 15,000 `read_to_string` calls
 * and 15,000 JSON parses — and that ran on every single account switch, which
 * is what made the list restart at "500 of 15,065" and climb every time. The
 * headers are already in memory when you switch away; this keeps them.
 *
 * Bounded to a few mailboxes: ~15k headers is a few MB, so an unbounded map
 * would grow with every folder visited.
 */

const MAX_MAILBOXES = 3;

/**
 * The snapshot is taken from the store, so a sidecar written in the moments
 * around it may or may not be represented. Widening the "changed" window by a
 * few seconds costs a handful of extra reads and removes the race.
 */
const MTIME_SKEW_MS = 5000;

/**
 * Past this fraction of the mailbox, reading sidecars one UID at a time stops
 * being a win over the single bulk read the caller would otherwise do.
 */
const RECONCILE_CEILING = 0.5;

/** key → { emails, stamp: { totalEmails, totalCached, highestModseq }, savedAt } */
const _memo = new Map();

const _key = (accountId, mailbox) => `${accountId}\x01${mailbox}`;

/** Re-insert so Map iteration order stays least-recently-used first. */
function _touch(k, entry) {
  _memo.delete(k);
  _memo.set(k, entry);
}

/**
 * A memo is only usable as-is if the cache on disk still looks exactly as it did
 * when we memoized it. The daemon syncs on its own schedule and writes sidecars
 * behind our back, so an in-memory copy can go stale with nothing to notice it.
 * Reading `_meta.json` (one small file + a readdir) is the cheap way to check.
 */
const _stampOf = (meta) => ({
  totalEmails: meta?.totalEmails ?? null,
  totalCached: meta?.totalCached ?? null,
  highestModseq: meta?.highestModseq ?? null,
  // Reconciling compares UID sets, and after a UIDVALIDITY change the same UID
  // names a different message — so the generation has to be part of the stamp,
  // not left to the other three fields happening to move.
  uidValidity: meta?.uidValidity ?? null,
});

const _sameStamp = (a, b) =>
  a && b
  && a.totalEmails === b.totalEmails
  && a.totalCached === b.totalCached
  && a.highestModseq === b.highestModseq
  && a.uidValidity === b.uidValidity;

/**
 * Memoize a header set. Ignored unless it covers the whole mailbox — a partial
 * set would later be recalled as if it were complete and the rest would never
 * be loaded.
 */
export function remember(accountId, mailbox, emails, meta) {
  const total = meta?.totalEmails ?? 0;
  if (!emails?.length || !total || emails.length < total) return;

  _touch(_key(accountId, mailbox), {
    emails,
    stamp: _stampOf(meta),
    savedAt: Date.now(),
  });

  while (_memo.size > MAX_MAILBOXES) {
    _memo.delete(_memo.keys().next().value);
  }
}

/**
 * The memoized header set with no freshness check at all.
 *
 * For painting only. The restore path needs something on screen before any
 * `await` — it already renders a 50-row window under exactly this contract — and
 * the background refresh that follows immediately reconciles whatever this
 * returned. Anything that has to be correct must use `recall`.
 */
export function peek(accountId, mailbox) {
  return _memo.get(_key(accountId, mailbox))?.emails || null;
}

/**
 * The memoized header set, brought up to date if the cache moved under it.
 * `meta` is the caller's already-loaded `_meta.json` view — no extra read.
 *
 * A stamp mismatch used to drop the memo, which meant one new message cost a
 * full re-read of every sidecar in the mailbox. Instead we re-read only the UIDs
 * that appeared, vanished or changed on disk. `io` supplies
 * `{ listCachedUids, getEmailHeadersByUids }`; omit it to get the old
 * drop-on-mismatch behaviour. Returns null when the memo is unusable and the
 * caller should read the cache itself.
 */
export async function recall(accountId, mailbox, meta, io) {
  const k = _key(accountId, mailbox);
  const hit = _memo.get(k);
  if (!hit) return null;

  const stamp = _stampOf(meta);
  if (_sameStamp(hit.stamp, stamp)) {
    _touch(k, hit);
    return hit.emails;
  }

  // A UIDVALIDITY change (or a vanished `_meta.json`) means the UID space itself
  // was reissued: reconciling by UID set would find the sets equal and restamp a
  // previous generation as current. Only a full reload is safe there.
  const reissued = hit.stamp.uidValidity !== stamp.uidValidity;

  // Timestamped before the listing, not after — a sidecar written while we read
  // must count as changed next time round, not be assumed covered.
  const readAt = Date.now();
  const merged = io && !reissued
    ? await _reconcile(accountId, mailbox, hit, io)
    : null;
  if (!merged) {
    _memo.delete(k); // disk moved on and we couldn't catch up
    return null;
  }

  _touch(k, { emails: merged, stamp, savedAt: readAt });
  return merged;
}

/**
 * Bring a stale memo in line with the sidecar directory, reading only what
 * moved. Returns null when that isn't worth it or can't be done exactly.
 */
async function _reconcile(accountId, mailbox, hit, io) {
  const listing = await io.listCachedUids(accountId, mailbox, hit.savedAt - MTIME_SKEW_MS);
  if (!listing?.uids?.length) return null; // no listing, or the cache was cleared

  const onDisk = new Set(listing.uids);
  const have = new Set(hit.emails.map(e => e.uid));
  const needed = [...new Set([
    ...listing.uids.filter(uid => !have.has(uid)),      // arrived since the snapshot
    ...listing.changed.filter(uid => have.has(uid)),    // rewritten since the snapshot
  ])];

  if (needed.length > onDisk.size * RECONCILE_CEILING) return null;

  const fresh = needed.length
    ? await io.getEmailHeadersByUids(accountId, mailbox, needed)
    : []; // an expunge-only delta needs no reads at all
  const byUid = new Map(fresh.map(e => [e.uid, e]));

  const kept = hit.emails
    .filter(e => onDisk.has(e.uid))       // a sidecar that's gone was expunged
    .map(e => byUid.get(e.uid) || e);
  const added = needed
    .filter(uid => !have.has(uid))
    .map(uid => byUid.get(uid))
    .filter(Boolean);

  // Must end up covering the directory exactly. A short read here would restamp
  // an incomplete set as current, and nothing downstream would ever fetch the
  // remainder. Newest UIDs first — display re-sorts by date anyway.
  const merged = [...added, ...kept];
  if (merged.length !== onDisk.size) return null;
  return merged;
}

/** Drop a mailbox, or every mailbox of an account when `mailbox` is omitted. */
export function forget(accountId, mailbox) {
  if (mailbox) {
    _memo.delete(_key(accountId, mailbox));
    return;
  }
  const prefix = `${accountId}\x01`;
  for (const k of [..._memo.keys()]) {
    if (k.startsWith(prefix)) _memo.delete(k);
  }
}

/** Test/diagnostic helper. */
export function _size() {
  return _memo.size;
}
