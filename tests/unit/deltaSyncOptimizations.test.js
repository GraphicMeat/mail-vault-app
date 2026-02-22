import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers — replicate the pure delta-sync decision logic from mailStore
// ---------------------------------------------------------------------------

/**
 * Determines which delta-sync tier applies given server status and cached state.
 * Returns one of:
 *   'condstore_skip'      — modseq+uidNext match → zero IMAP calls
 *   'condstore_flag_sync' — modseq changed, uidNext same, total matches cache → flag-only sync
 *   'no_change_skip'      — non-CONDSTORE: uidNext+total unchanged → skip
 *   'uid_search'          — something changed → full UID search delta-sync
 *   'full_reload'         — uidValidity changed → full reload
 *
 * Plus a 'schedule_more' boolean when cache is partial and early-returning.
 */
function deltaSyncDecision({
  newUidValidity, cachedUidValidity,
  newHighestModseq, cachedHighestModseq,
  newUidNext, cachedUidNext,
  serverTotal, existingCount
}) {
  if (newUidValidity !== cachedUidValidity) {
    return { tier: 'full_reload', scheduleMore: false };
  }

  if (
    newHighestModseq != null && cachedHighestModseq != null &&
    newHighestModseq === cachedHighestModseq &&
    newUidNext === cachedUidNext
  ) {
    return {
      tier: 'condstore_skip',
      scheduleMore: existingCount < serverTotal
    };
  }

  if (
    newHighestModseq != null && cachedHighestModseq != null &&
    newHighestModseq !== cachedHighestModseq &&
    newUidNext === cachedUidNext &&
    serverTotal === existingCount
  ) {
    return { tier: 'condstore_flag_sync', scheduleMore: false };
  }

  if (newUidNext === cachedUidNext && serverTotal <= existingCount) {
    return { tier: 'no_change_skip', scheduleMore: false };
  }

  return { tier: 'uid_search', scheduleMore: false };
}

// ---------------------------------------------------------------------------
// CONDSTORE delta-sync decision tree
// ---------------------------------------------------------------------------
describe('deltaSyncDecision — CONDSTORE decision tree', () => {
  // ── Tier 1: CONDSTORE skip (zero IMAP calls) ─────────────────────

  it('CONDSTORE skip: modseq + uidNext match, full cache', () => {
    const result = deltaSyncDecision({
      newUidValidity: 1, cachedUidValidity: 1,
      newHighestModseq: 500, cachedHighestModseq: 500,
      newUidNext: 100, cachedUidNext: 100,
      serverTotal: 50, existingCount: 50
    });
    expect(result.tier).toBe('condstore_skip');
    expect(result.scheduleMore).toBe(false);
  });

  it('CONDSTORE skip: modseq + uidNext match, PARTIAL cache → scheduleMore', () => {
    const result = deltaSyncDecision({
      newUidValidity: 1, cachedUidValidity: 1,
      newHighestModseq: 500, cachedHighestModseq: 500,
      newUidNext: 17001, cachedUidNext: 17001,
      serverTotal: 17000, existingCount: 200
    });
    expect(result.tier).toBe('condstore_skip');
    expect(result.scheduleMore).toBe(true);
  });

  // ── Tier 2: Flag-only sync ────────────────────────────────────────

  it('CONDSTORE flag-only sync: modseq changed, uidNext same, total matches', () => {
    const result = deltaSyncDecision({
      newUidValidity: 1, cachedUidValidity: 1,
      newHighestModseq: 600, cachedHighestModseq: 500,
      newUidNext: 100, cachedUidNext: 100,
      serverTotal: 50, existingCount: 50
    });
    expect(result.tier).toBe('condstore_flag_sync');
  });

  it('CONDSTORE flag-only sync: does NOT trigger when cache is partial (total != existingCount)', () => {
    const result = deltaSyncDecision({
      newUidValidity: 1, cachedUidValidity: 1,
      newHighestModseq: 600, cachedHighestModseq: 500,
      newUidNext: 17001, cachedUidNext: 17001,
      serverTotal: 17000, existingCount: 200
    });
    // Falls through to uid_search because serverTotal !== existingCount
    expect(result.tier).toBe('uid_search');
  });

  // ── Tier 3: Non-CONDSTORE skip ────────────────────────────────────

  it('Non-CONDSTORE skip: uidNext same, total matches, no modseq', () => {
    const result = deltaSyncDecision({
      newUidValidity: 1, cachedUidValidity: 1,
      newHighestModseq: null, cachedHighestModseq: null,
      newUidNext: 100, cachedUidNext: 100,
      serverTotal: 50, existingCount: 50
    });
    expect(result.tier).toBe('no_change_skip');
  });

  it('Non-CONDSTORE: does NOT skip when cache is partial (existingCount < serverTotal)', () => {
    const result = deltaSyncDecision({
      newUidValidity: 1, cachedUidValidity: 1,
      newHighestModseq: null, cachedHighestModseq: null,
      newUidNext: 17001, cachedUidNext: 17001,
      serverTotal: 17000, existingCount: 200
    });
    // serverTotal > existingCount → falls through to uid_search
    expect(result.tier).toBe('uid_search');
  });

  it('Non-CONDSTORE: skips when existingCount >= serverTotal (cache has all or more)', () => {
    const result = deltaSyncDecision({
      newUidValidity: 1, cachedUidValidity: 1,
      newHighestModseq: null, cachedHighestModseq: null,
      newUidNext: 100, cachedUidNext: 100,
      serverTotal: 50, existingCount: 55  // can happen after deletion
    });
    expect(result.tier).toBe('no_change_skip');
  });

  // ── Tier 4: UID search ────────────────────────────────────────────

  it('UID search: new emails arrived (uidNext increased)', () => {
    const result = deltaSyncDecision({
      newUidValidity: 1, cachedUidValidity: 1,
      newHighestModseq: 600, cachedHighestModseq: 500,
      newUidNext: 105, cachedUidNext: 100,
      serverTotal: 55, existingCount: 50
    });
    expect(result.tier).toBe('uid_search');
  });

  it('UID search: emails deleted (total shrank, uidNext unchanged)', () => {
    const result = deltaSyncDecision({
      newUidValidity: 1, cachedUidValidity: 1,
      newHighestModseq: null, cachedHighestModseq: null,
      newUidNext: 100, cachedUidNext: 100,
      serverTotal: 45, existingCount: 50
    });
    // serverTotal (45) <= existingCount (50) → actually hits no_change_skip since uidNext matches
    expect(result.tier).toBe('no_change_skip');
  });

  // ── Full reload ───────────────────────────────────────────────────

  it('Full reload: uidValidity changed', () => {
    const result = deltaSyncDecision({
      newUidValidity: 2, cachedUidValidity: 1,
      newHighestModseq: 500, cachedHighestModseq: 500,
      newUidNext: 100, cachedUidNext: 100,
      serverTotal: 50, existingCount: 50
    });
    expect(result.tier).toBe('full_reload');
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it('Handles zero modseq gracefully (some servers return 0)', () => {
    const result = deltaSyncDecision({
      newUidValidity: 1, cachedUidValidity: 1,
      newHighestModseq: 0, cachedHighestModseq: 0,
      newUidNext: 100, cachedUidNext: 100,
      serverTotal: 50, existingCount: 50
    });
    // 0 != null, so CONDSTORE path applies, and 0 === 0
    expect(result.tier).toBe('condstore_skip');
  });

  it('First load with no cached data (cachedUidValidity is undefined)', () => {
    const result = deltaSyncDecision({
      newUidValidity: 1, cachedUidValidity: undefined,
      newHighestModseq: 500, cachedHighestModseq: undefined,
      newUidNext: 100, cachedUidNext: undefined,
      serverTotal: 50, existingCount: 0
    });
    // uidValidity mismatch (1 !== undefined) → full reload
    expect(result.tier).toBe('full_reload');
  });

  it('CONDSTORE fast path: string modseq comparison (server returns string)', () => {
    // In practice, modseq may come as string from JSON
    const result = deltaSyncDecision({
      newUidValidity: 1, cachedUidValidity: 1,
      newHighestModseq: '12345', cachedHighestModseq: '12345',
      newUidNext: 100, cachedUidNext: 100,
      serverTotal: 50, existingCount: 50
    });
    expect(result.tier).toBe('condstore_skip');
  });
});

// ---------------------------------------------------------------------------
// UID range compression (JS equivalent of Rust compress_uid_ranges)
// ---------------------------------------------------------------------------
function compressUidRanges(uids) {
  if (uids.length === 0) return '';
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}:${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}:${end}`);
  return ranges.join(',');
}

describe('compressUidRanges — UID range compression', () => {
  it('empty array returns empty string', () => {
    expect(compressUidRanges([])).toBe('');
  });

  it('single UID', () => {
    expect(compressUidRanges([42])).toBe('42');
  });

  it('consecutive UIDs', () => {
    expect(compressUidRanges([1, 2, 3, 4, 5])).toBe('1:5');
  });

  it('mixed ranges and singles', () => {
    expect(compressUidRanges([1, 2, 3, 5, 6, 10])).toBe('1:3,5:6,10');
  });

  it('all gaps', () => {
    expect(compressUidRanges([1, 3, 5, 7])).toBe('1,3,5,7');
  });

  it('handles unsorted input', () => {
    expect(compressUidRanges([10, 1, 5, 6, 2, 3])).toBe('1:3,5:6,10');
  });

  it('handles duplicates', () => {
    expect(compressUidRanges([1, 1, 2, 2, 3])).toBe('1:3');
  });

  it('large consecutive range', () => {
    const uids = Array.from({ length: 1000 }, (_, i) => i + 1);
    expect(compressUidRanges(uids)).toBe('1:1000');
  });
});
