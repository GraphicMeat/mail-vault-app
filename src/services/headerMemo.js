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

/** key → { emails, stamp: { totalEmails, totalCached, highestModseq } } */
const _memo = new Map();

const _key = (accountId, mailbox) => `${accountId}\x01${mailbox}`;

/**
 * A memo is only usable if the cache on disk still looks exactly as it did when
 * we memoized it. The daemon syncs on its own schedule and writes sidecars
 * behind our back, so an in-memory copy can go stale with nothing to notice it.
 * Reading `_meta.json` (one small file + a readdir) is the cheap way to check.
 */
const _stampOf = (meta) => ({
  totalEmails: meta?.totalEmails ?? null,
  totalCached: meta?.totalCached ?? null,
  highestModseq: meta?.highestModseq ?? null,
});

const _sameStamp = (a, b) =>
  a && b
  && a.totalEmails === b.totalEmails
  && a.totalCached === b.totalCached
  && a.highestModseq === b.highestModseq;

/**
 * Memoize a header set. Ignored unless it covers the whole mailbox — a partial
 * set would later be recalled as if it were complete and the rest would never
 * be loaded.
 */
export function remember(accountId, mailbox, emails, meta) {
  const total = meta?.totalEmails ?? 0;
  if (!emails?.length || !total || emails.length < total) return;

  const k = _key(accountId, mailbox);
  _memo.delete(k); // re-insert so iteration order is least-recently-used first
  _memo.set(k, { emails, stamp: _stampOf(meta) });

  while (_memo.size > MAX_MAILBOXES) {
    _memo.delete(_memo.keys().next().value);
  }
}

/**
 * The memoized header set, or null when absent or stale.
 * `meta` is the caller's already-loaded `_meta.json` view — no extra read.
 */
export function recall(accountId, mailbox, meta) {
  const k = _key(accountId, mailbox);
  const hit = _memo.get(k);
  if (!hit) return null;

  if (!_sameStamp(hit.stamp, _stampOf(meta))) {
    _memo.delete(k); // disk moved on without us
    return null;
  }

  _memo.delete(k);
  _memo.set(k, hit); // touch for LRU
  return hit.emails;
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
