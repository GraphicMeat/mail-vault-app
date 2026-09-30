/**
 * UidMap — UID-keyed Map that serves as the single source of truth for email merging.
 *
 * During account activation, both local (cache/disk) and server (IMAP/Graph) streams
 * merge headers into this map. Server data wins over cache data on conflict.
 * toSortedArray() returns emails sorted by UID descending (newest first).
 */
export class UidMap {
  constructor(uidValidity) {
    this._uidValidity = uidValidity ?? null;
    this._map = new Map(); // uid → email header object
    this._sorted = null;   // invalidated on mutation
    // The rows this activation last put in the store (or found there when it
    // began): the snapshot every later commit merges local flag writes against.
    this.committed = null;
  }

  get uidValidity() {
    return this._uidValidity;
  }

  get size() {
    return this._map.size;
  }

  /**
   * Insert or merge a single header. Server-sourced headers overwrite cache-sourced ones.
   * If the UID already exists and the new header has source='server', it wins.
   * Otherwise the existing entry is kept (first-write wins for same source).
   */
  set(uid, header) {
    const existing = this._map.get(uid);
    if (!existing || header.source === 'server') {
      this._map.set(uid, header);
      this._sorted = null;
    }
  }

  /**
   * Bulk insert from either stream. Calls set() for each header.
   */
  merge(headers) {
    for (const header of headers) {
      this.set(header.uid, header);
    }
    this._sorted = null;
  }

  /**
   * Swap in rows that are already held under their own uid, whatever their
   * source: the flag merge at commit time carries a local write into the row a
   * server stream would otherwise keep re-committing with the old flags.
   */
  replaceRows(rows) {
    for (const row of rows) {
      if (this._map.has(row.uid) && this._map.get(row.uid) !== row) {
        this._map.set(row.uid, row);
        this._sorted = null;
      }
    }
  }

  delete(uid) {
    if (this._map.delete(uid)) {
      this._sorted = null;
    }
  }

  has(uid) {
    return this._map.has(uid);
  }

  get(uid) {
    return this._map.get(uid) ?? null;
  }

  /**
   * Returns emails sorted by UID descending (newest first).
   * Cached until the next mutation.
   */
  toSortedArray() {
    if (!this._sorted) {
      this._sorted = [...this._map.values()].sort((a, b) => b.uid - a.uid);
    }
    return this._sorted;
  }

  /**
   * Called when UIDVALIDITY changes — all cached UIDs are meaningless.
   */
  invalidate() {
    this._map.clear();
    this._sorted = null;
    // The old uids name other messages now: nothing local to merge against.
    this.committed = null;
  }

  /**
   * Update UIDVALIDITY. If it differs from the stored value, invalidate all entries.
   * Returns true if invalidation occurred.
   */
  checkUidValidity(newUidValidity) {
    if (this._uidValidity != null && newUidValidity != null && newUidValidity !== this._uidValidity) {
      this.invalidate();
      this._uidValidity = newUidValidity;
      return true;
    }
    this._uidValidity = newUidValidity;
    return false;
  }
}
