// ── Range merge and eviction logic for loadEmailRange ──

/**
 * Merge overlapping or adjacent ranges into minimal set.
 * Input: array of {start, end} sorted by start.
 * Returns: merged array.
 */
export function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end + 1) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push(sorted[i]);
    }
  }
  return merged;
}

/**
 * Evict entries beyond MAX_LOADED_ENTRIES (keep newest by date).
 */
export function evictExcess(emails, maxEntries = 5000) {
  if (emails.length <= maxEntries) return emails;
  return emails.slice(0, maxEntries);
}
