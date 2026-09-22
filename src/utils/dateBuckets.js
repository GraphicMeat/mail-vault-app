// Month buckets over the email list rows, for the date scrubber.
// Pure: rows in (threadedDisplay shape), plain data out.

const pad = (m) => String(m).padStart(2, '0');

/** A top-level row's date, or null (thread members and undated rows). */
export function rowDate(row) {
  if (!row || row.type === 'thread-member') return null;
  const raw = row.type === 'thread' ? row.thread?.lastDate : (row.email?.date || row.email?.internalDate);
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  const t = d.getTime();
  // buildThreads writes new Date(0) for an undated thread.
  return Number.isFinite(t) && t > 0 ? d : null;
}

/**
 * `[{ key:'2021-03', y, m, firstIndex, rows }]` in list order (newest first),
 * local months. A new bucket starts only at an OLDER month than the current
 * one: undated or out-of-order rows join the bucket they sit in, so keys stay
 * unique and descending. Leading undated rows join the first bucket.
 */
export function monthBuckets(rows) {
  const buckets = [];
  let cur = null;
  let leading = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row?.type === 'thread-member') continue;
    const d = rowDate(row);
    if (d) {
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      if (!cur || y * 12 + m < cur.y * 12 + cur.m) {
        cur = { key: `${y}-${pad(m)}`, y, m, firstIndex: cur ? i : 0, rows: cur ? 0 : leading };
        buckets.push(cur);
      }
    }
    if (cur) cur.rows++;
    else leading++;
  }
  return buckets;
}

/** Indices that open a month (they carry the header band). */
export function firstRowOfMonth(buckets) {
  return new Set(buckets.map(b => b.firstIndex));
}

/** The bucket holding row `index` (last bucket starting at or before it). */
export function bucketAtIndex(buckets, index) {
  let lo = 0;
  let hi = buckets.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (buckets[mid].firstIndex <= index) { found = buckets[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * Rail segments top to bottom, each with `start`/`size` as fractions of the
 * rail: loaded months (weight = rows), histogram months older than the oldest
 * loaded one (weight = messages), and one `older` tail for what the cache does
 * not hold yet (totalEmails - totalCached).
 */
export function railSegments(buckets, histogram, { totalEmails = 0, totalCached = 0 } = {}) {
  const segs = buckets.map(b => ({ kind: 'loaded', key: b.key, y: b.y, m: b.m, weight: b.rows, bucket: b }));
  const oldest = buckets[buckets.length - 1]?.key;
  if (histogram) {
    for (const { ym, count } of histogram) {
      if (oldest && ym >= oldest) continue;
      const [y, m] = ym.split('-').map(Number);
      if (!y || !m || !(count > 0)) continue;
      segs.push({ kind: 'unloaded', key: ym, y, m, weight: count });
    }
    const tail = totalEmails - totalCached;
    if (tail > 0) segs.push({ kind: 'older', weight: tail });
  }
  const total = segs.reduce((sum, s) => sum + s.weight, 0) || 1;
  let acc = 0;
  for (const s of segs) {
    s.start = acc / total;
    s.size = s.weight / total;
    acc += s.weight;
  }
  return segs;
}

/** Has loading reached the target month: oldest loaded date is before its start. */
export function reachedMonth(oldestLoadedDate, target) {
  if (!oldestLoadedDate) return false;
  return oldestLoadedDate.getTime() < new Date(target.y, target.m - 1, 1).getTime();
}
