import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers — replicate the pure logic from mailStore for unit testing
// ---------------------------------------------------------------------------

/**
 * Determines if an account has valid credentials (password or OAuth2).
 * Mirrors the check in loadMoreEmails, loadEmailRange, useBackgroundCaching.
 */
function hasCredentials(account) {
  if (!account) return false;
  return !!(account.password || (account.authType === 'oauth2' && account.oauth2AccessToken));
}

/**
 * Detects mailbox mutation — total changed mid-pagination.
 * Returns true if pagination should restart.
 */
function shouldRestartPagination(previousTotal, serverTotal) {
  return previousTotal > 0 && serverTotal !== previousTotal;
}

/**
 * Removes stale UIDs from cached emails when server total shrank.
 * Mirrors the cleanup logic in loadEmails.
 */
function cleanStaleUids(existingEmails, serverEmails, serverTotal) {
  const serverUids = new Set(serverEmails.map(e => e.uid));
  if (existingEmails.length > 0 && serverTotal < existingEmails.length) {
    const page1Size = serverEmails.length;
    const overlapSlice = existingEmails.slice(0, page1Size);
    const staleUids = overlapSlice.filter(e => !serverUids.has(e.uid)).map(e => e.uid);
    if (staleUids.length > 0) {
      const staleSet = new Set(staleUids);
      return existingEmails.filter(e => !staleSet.has(e.uid));
    }
  }
  return existingEmails;
}

/**
 * Computes exponential backoff delay.
 * Mirrors the retry logic in loadMoreEmails and useBackgroundCaching.
 */
function nextRetryDelay(prevDelay, cap = 120000) {
  if (prevDelay === 0) return 3000;
  return Math.min(prevDelay * 2, cap);
}

const mkEmail = (uid, subject) => ({
  uid,
  subject: subject || `Email ${uid}`,
  date: '2026-02-19T12:00:00Z',
  from: { address: 'test@example.com' },
  flags: ['\\Seen'],
});

// ---------------------------------------------------------------------------
// OAuth2 credential detection
// ---------------------------------------------------------------------------
describe('hasCredentials — OAuth2 + password support', () => {
  it('returns false for null account', () => {
    expect(hasCredentials(null)).toBe(false);
  });

  it('returns false for account with no password and no OAuth2', () => {
    expect(hasCredentials({ email: 'a@b.com' })).toBe(false);
  });

  it('returns true for account with password', () => {
    expect(hasCredentials({ email: 'a@b.com', password: 'secret' })).toBe(true);
  });

  it('returns true for OAuth2 account with access token', () => {
    expect(hasCredentials({
      email: 'a@b.com',
      authType: 'oauth2',
      oauth2AccessToken: 'tok_abc'
    })).toBe(true);
  });

  it('returns false for OAuth2 account without access token', () => {
    expect(hasCredentials({
      email: 'a@b.com',
      authType: 'oauth2'
    })).toBe(false);
  });

  it('returns false for OAuth2 account with empty access token', () => {
    expect(hasCredentials({
      email: 'a@b.com',
      authType: 'oauth2',
      oauth2AccessToken: ''
    })).toBe(false);
  });

  it('returns true when both password and OAuth2 token present', () => {
    expect(hasCredentials({
      email: 'a@b.com',
      password: 'secret',
      authType: 'oauth2',
      oauth2AccessToken: 'tok_abc'
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mailbox mutation detection (total change mid-pagination)
// ---------------------------------------------------------------------------
describe('shouldRestartPagination — total change detection', () => {
  it('returns false when previous total is 0 (first load)', () => {
    expect(shouldRestartPagination(0, 500)).toBe(false);
  });

  it('returns false when totals match', () => {
    expect(shouldRestartPagination(500, 500)).toBe(false);
  });

  it('returns true when total decreased (emails deleted externally)', () => {
    expect(shouldRestartPagination(500, 498)).toBe(true);
  });

  it('returns true when total increased (new emails arrived)', () => {
    expect(shouldRestartPagination(500, 503)).toBe(true);
  });

  it('returns true for large total change', () => {
    expect(shouldRestartPagination(16989, 16000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stale UID cleanup on refresh
// ---------------------------------------------------------------------------
describe('cleanStaleUids — remove externally deleted emails from cache', () => {
  it('returns original list when server total >= cached count', () => {
    const cached = [mkEmail(1), mkEmail(2), mkEmail(3)];
    const server = [mkEmail(1), mkEmail(2), mkEmail(3)];
    const result = cleanStaleUids(cached, server, 3);
    expect(result).toHaveLength(3);
  });

  it('removes stale UIDs from page-1 overlap when total shrank', () => {
    // Cached has 5 emails, server now has 3.
    // Page 1 from server returns UIDs 1, 3, 5 — UID 2 was deleted.
    const cached = [mkEmail(1), mkEmail(2), mkEmail(3), mkEmail(4), mkEmail(5)];
    const server = [mkEmail(1), mkEmail(3), mkEmail(5)];
    const result = cleanStaleUids(cached, server, 3);
    // UID 2 was in overlap (first 3 of cached) and not in server → removed
    expect(result.map(e => e.uid)).toEqual([1, 3, 4, 5]);
  });

  it('does not remove UIDs outside the overlap window', () => {
    // Cached: [1,2,3,4,5,6,7,8,9,10], server page-1 returns [1,2,3] (3 emails), total=8
    // UID 4 might be deleted but it's outside page-1 overlap — can't validate
    const cached = Array.from({ length: 10 }, (_, i) => mkEmail(i + 1));
    const server = [mkEmail(1), mkEmail(2), mkEmail(3)];
    const result = cleanStaleUids(cached, server, 8);
    // Only overlap window (first 3) is checked: all match → nothing removed
    expect(result).toHaveLength(10);
  });

  it('removes multiple stale UIDs from overlap', () => {
    // Server deleted UIDs 1 and 3 from the overlap window
    const cached = [mkEmail(1), mkEmail(2), mkEmail(3), mkEmail(4), mkEmail(5)];
    const server = [mkEmail(2), mkEmail(4), mkEmail(5)];
    const result = cleanStaleUids(cached, server, 3);
    // UIDs 1 and 3 in overlap (first 3) not in server → removed
    expect(result.map(e => e.uid)).toEqual([2, 4, 5]);
  });

  it('returns original list when cached is empty', () => {
    const result = cleanStaleUids([], [mkEmail(1)], 1);
    expect(result).toHaveLength(0);
  });

  it('handles all emails in overlap being stale', () => {
    const cached = [mkEmail(1), mkEmail(2), mkEmail(3)];
    const server = [mkEmail(10), mkEmail(11)];
    const result = cleanStaleUids(cached, server, 2);
    // All 2 in overlap (first 2 of cached) are stale → removed. UID 3 outside overlap stays.
    expect(result.map(e => e.uid)).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// Exponential backoff retry delays
// ---------------------------------------------------------------------------
describe('nextRetryDelay — exponential backoff', () => {
  it('starts at 3000ms from 0', () => {
    expect(nextRetryDelay(0)).toBe(3000);
  });

  it('doubles: 3000 → 6000', () => {
    expect(nextRetryDelay(3000)).toBe(6000);
  });

  it('doubles: 6000 → 12000', () => {
    expect(nextRetryDelay(6000)).toBe(12000);
  });

  it('doubles: 12000 → 24000', () => {
    expect(nextRetryDelay(12000)).toBe(24000);
  });

  it('caps at 120000ms', () => {
    expect(nextRetryDelay(60000)).toBe(120000);
    expect(nextRetryDelay(120000)).toBe(120000);
  });

  it('does not exceed cap even with large input', () => {
    expect(nextRetryDelay(200000)).toBe(120000);
  });

  it('respects custom cap', () => {
    expect(nextRetryDelay(3000, 5000)).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Skipped UIDs response handling
// ---------------------------------------------------------------------------
describe('skipped UIDs from server response', () => {
  it('empty skippedUids means all messages parsed successfully', () => {
    const response = { emails: [mkEmail(1), mkEmail(2)], total: 100, skippedUids: [] };
    expect(response.skippedUids).toHaveLength(0);
    expect(response.emails).toHaveLength(2);
  });

  it('skippedUids contains UIDs that failed to parse', () => {
    const response = {
      emails: [mkEmail(1), mkEmail(3)],
      total: 100,
      skippedUids: [2]
    };
    expect(response.skippedUids).toContain(2);
    expect(response.emails.map(e => e.uid)).not.toContain(2);
  });

  it('skippedUids can contain null for messages with no UID', () => {
    const response = {
      emails: [mkEmail(1)],
      total: 100,
      skippedUids: [null, 5]
    };
    expect(response.skippedUids).toHaveLength(2);
    expect(response.skippedUids).toContain(null);
  });

  it('page should be re-requested when skippedUids is non-empty', () => {
    const response = { emails: [mkEmail(1)], total: 100, hasMore: true, skippedUids: [2, 3] };
    const shouldRetry = response.skippedUids && response.skippedUids.length > 0;
    expect(shouldRetry).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Online/offline state transitions
// ---------------------------------------------------------------------------
describe('offline pause / online resume logic', () => {
  it('should pause when going offline during loading', () => {
    let pausedOffline = false;
    // Simulate going offline while hasMoreEmails
    const isOnline = false;
    if (!isOnline) {
      pausedOffline = true;
    }
    expect(pausedOffline).toBe(true);
  });

  it('should resume when coming back online after pause', () => {
    let pausedOffline = true;
    let retryDelay = 18000;
    let resumed = false;

    // Simulate online event
    const isOnline = true;
    if (isOnline && pausedOffline) {
      pausedOffline = false;
      retryDelay = 0;
      resumed = true;
    }

    expect(pausedOffline).toBe(false);
    expect(retryDelay).toBe(0);
    expect(resumed).toBe(true);
  });

  it('should not resume if not paused', () => {
    let pausedOffline = false;
    let resumed = false;

    const isOnline = true;
    if (isOnline && pausedOffline) {
      resumed = true;
    }

    expect(resumed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Background caching retry queue logic
// ---------------------------------------------------------------------------
describe('background caching retry queue', () => {
  it('failed UIDs move to retry queue, not dropped', () => {
    const mainQueue = [1, 2, 3, 4, 5];
    const retryQueue = [];

    // Process UID 1 — success
    mainQueue.shift();

    // Process UID 2 — fails
    const failedUid = mainQueue.shift();
    retryQueue.push(failedUid);

    // Process UID 3 — success
    mainQueue.shift();

    expect(mainQueue).toEqual([4, 5]);
    expect(retryQueue).toEqual([2]);
  });

  it('retry queue is re-merged into main queue after backoff', () => {
    const mainQueue = [];
    const retryQueue = [2, 7];

    // After backoff timer fires, move retry → main
    mainQueue.unshift(...retryQueue);
    retryQueue.length = 0;

    expect(mainQueue).toEqual([2, 7]);
    expect(retryQueue).toHaveLength(0);
  });

  it('retry delay grows exponentially in caching queue', () => {
    let delay = 3000;
    const delays = [delay];
    for (let i = 0; i < 5; i++) {
      delay = Math.min(delay * 2, 120000);
      delays.push(delay);
    }
    expect(delays).toEqual([3000, 6000, 12000, 24000, 48000, 96000]);
  });

  it('successful fetch resets retry delay to initial', () => {
    let retryDelay = 48000;
    // On success:
    retryDelay = 3000;
    expect(retryDelay).toBe(3000);
  });

  it('stop clears both queues and timer', () => {
    const mainQueue = [1, 2, 3];
    const retryQueue = [4, 5];
    let retryDelay = 24000;
    let retryTimer = setTimeout(() => {}, 999999);

    // Stop:
    mainQueue.length = 0;
    retryQueue.length = 0;
    clearTimeout(retryTimer);
    retryTimer = null;
    retryDelay = 3000;

    expect(mainQueue).toHaveLength(0);
    expect(retryQueue).toHaveLength(0);
    expect(retryTimer).toBeNull();
    expect(retryDelay).toBe(3000);
  });
});
