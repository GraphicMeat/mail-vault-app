/**
 * In-memory memo of the header set of the mailbox you just left, so switching
 * straight back paints the whole list at once.
 *
 * The header cache is SQLite now, so a miss is one query, not a file per
 * message. What a miss still costs is the list: it repaints from a 500-row
 * partial read and drains the rest behind it, which is the "500 of 15,065" that
 * climbs on every switch. The headers are already in memory when you switch
 * away; this keeps them.
 *
 * Expensive to hold: a header row costs ~3.4 KB in the webview, so a 15k
 * mailbox is ~50 MB per entry. So at rest it holds one: the caller drops an
 * entry once the store adopts it (the store then holds the same rows) and
 * trims to the most recent one once a load settles. The cap is 2, not 1: on a
 * switch back, the outgoing mailbox is memoized BEFORE the incoming one is
 * recalled, and a cap of 1 would evict the very entry the switch back is about
 * to read.
 */

const MAX_MAILBOXES = 2;

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
 * Memoize a header set — the top N UIDs of the mailbox, complete or not.
 *
 * Partial sets used to be refused, on the grounds that one recalled as complete
 * would leave the rest unloaded. But completeness is decided by the CALLER, from
 * `_meta.json`, not from the memo's length: a short set still yields
 * `hasMoreEmails` and the drain carries on from where it stops. Refusing them
 * meant a mailbox that never finished loading could never be memoized at all —
 * so every switch back rebuilt it from disk, which is the case this whole module
 * exists for.
 */
export function remember(accountId, mailbox, emails, meta) {
  if (!emails?.length || !meta) return;

  // A smaller snapshot of the same disk state is a downgrade — that's the store
  // mid-paint, not new information.
  const prev = _memo.get(_key(accountId, mailbox));
  if (prev && prev.emails.length > emails.length && _sameStamp(prev.stamp, _stampOf(meta))) return;

  _touch(_key(accountId, mailbox), {
    emails,
    stamp: _stampOf(meta),
    savedAt: Date.now(),
  });

  trim(MAX_MAILBOXES);
}

/** Evict least-recently-used entries until at most `n` remain. */
export function trim(n) {
  while (_memo.size > n) {
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

  const fresh = await _freshen(accountId, mailbox, hit, meta, io);
  if (!fresh) {
    _memo.delete(k); // disk moved on and we couldn't catch up
    return null;
  }
  _touch(k, fresh);
  return fresh.emails;
}

/** `hit` brought up to `meta`: `{ emails, stamp, savedAt }`, or null. */
async function _freshen(accountId, mailbox, hit, meta, io, ceiling = RECONCILE_CEILING) {
  const stamp = _stampOf(meta);
  if (_sameStamp(hit.stamp, stamp)) return hit;

  // A UIDVALIDITY change (or a vanished `_meta.json`) means the UID space itself
  // was reissued: reconciling by UID set would find the sets equal and restamp a
  // previous generation as current. Only a full reload is safe there.
  const reissued = hit.stamp.uidValidity !== stamp.uidValidity;

  // Timestamped before the listing, not after — a sidecar written while we read
  // must count as changed next time round, not be assumed covered.
  const readAt = Date.now();
  const merged = io && !reissued
    ? await _reconcile(accountId, mailbox, hit, io, ceiling)
    : null;
  return merged ? { emails: merged, stamp, savedAt: readAt } : null;
}

/**
 * The stamp of the set the store holds for the view on screen — no rows, so it
 * pins no memory. Re-activating that view (Refresh, a retry) brings the
 * store's own rows up to date the way `recall` does a memo entry, instead of
 * repainting from a 500-row read and draining the rest again.
 */
let _onScreen = null;

/**
 * The store adopted a set for this view. A memo entry for it is dropped — the
 * store holds those rows now, and the next refresh replaces them with copies,
 * so a kept entry would be a second, staler copy of the mailbox on screen —
 * and its stamp becomes the view's. Otherwise the set was read as of `readAt`.
 * A mark `recallOnScreen` already brought up to date is kept: re-marking would
 * move `savedAt` past changes the stamp cannot see (flags).
 */
export function adopt(accountId, mailbox, meta, readAt) {
  const k = _key(accountId, mailbox);
  const hit = _memo.get(k);
  _memo.delete(k);
  if (_onScreen?.key === k) return;
  _onScreen = hit
    ? { key: k, stamp: hit.stamp, savedAt: hit.savedAt }
    : meta ? { key: k, stamp: _stampOf(meta), savedAt: readAt } : null;
}

/** The view is being left; its stamp says nothing about what gets painted next. */
export function clearOnScreen() {
  _onScreen = null;
}

/** Whether the store's set for this view carries a stamp `recallOnScreen` can use. */
export function isOnScreen(accountId, mailbox) {
  return _onScreen?.key === _key(accountId, mailbox);
}

/**
 * `emails` (the store's rows for this view) brought up to `meta`, or null.
 *
 * No ceiling here. It weighs a memo against the caller's bulk read, but for the
 * view on screen that read is the 500-row repaint plus a drain that fetches
 * every other row in one by-uid call anyway — and a refresh of the open list
 * rewrites every row it holds, so nearly all of them always count as moved.
 */
export async function recallOnScreen(accountId, mailbox, emails, meta, io) {
  const k = _key(accountId, mailbox);
  const mark = _onScreen;
  if (!mark || mark.key !== k || !emails?.length) return null;
  const fresh = await _freshen(accountId, mailbox, { ...mark, emails }, meta, io, Infinity);
  _onScreen = fresh ? { key: k, stamp: fresh.stamp, savedAt: fresh.savedAt } : null;
  return fresh?.emails ?? null;
}

/**
 * Bring a stale memo in line with the sidecar directory, reading only what
 * moved. Returns null when that isn't worth it or can't be done exactly.
 */
async function _reconcile(accountId, mailbox, hit, io, ceiling) {
  const listing = await io.listCachedUids(accountId, mailbox, hit.savedAt - MTIME_SKEW_MS);
  if (!listing?.uids?.length) return null; // no listing, or the cache was cleared

  const onDisk = new Set(listing.uids);
  const have = new Set(hit.emails.map(e => e.uid));

  // The memo is the top N UIDs of the mailbox and N may be short of the cache.
  // Everything below its highest-held UID that we don't already have is the
  // pagination drain's job, so only mail that arrived ABOVE it counts as new
  // here — pulling in the rest would be the full re-read this exists to avoid.
  const highestHeld = hit.emails.reduce((max, e) => Math.max(max, e.uid), 0);
  const arrivals = listing.uids.filter(uid => uid > highestHeld && !have.has(uid));
  const rewritten = listing.changed.filter(uid => have.has(uid));
  const needed = [...new Set([...arrivals, ...rewritten])];

  if (needed.length > have.size * ceiling) return null;

  const fresh = needed.length
    ? await io.getEmailHeadersByUids(accountId, mailbox, needed)
    : []; // an expunge-only delta needs no reads at all
  const byUid = new Map(fresh.map(e => [e.uid, e]));

  const kept = hit.emails
    .filter(e => onDisk.has(e.uid))       // a sidecar that's gone was expunged
    .map(e => byUid.get(e.uid) || e);
  const added = arrivals.map(uid => byUid.get(uid)).filter(Boolean);

  // Every arrival must have actually been read. A short read would restamp a set
  // with a hole in it as current, and nothing downstream fetches above the
  // memo's own ceiling. `kept` shrinking is fine — that's an expunge.
  if (added.length !== arrivals.length) return null;
  return [...added, ...kept]; // newest first; display re-sorts by date anyway
}

/**
 * Drop a mailbox, or every mailbox of an account when `mailbox` is omitted —
 * the on-screen stamp included.
 */
export function forget(accountId, mailbox) {
  if (mailbox) {
    _memo.delete(_key(accountId, mailbox));
    if (_onScreen?.key === _key(accountId, mailbox)) _onScreen = null;
    return;
  }
  const prefix = `${accountId}\x01`;
  for (const k of [..._memo.keys()]) {
    if (k.startsWith(prefix)) _memo.delete(k);
  }
  if (_onScreen?.key.startsWith(prefix)) _onScreen = null;
}

/** Test/diagnostic helper. */
export function _size() {
  return _memo.size;
}
