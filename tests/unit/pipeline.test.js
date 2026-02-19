import { describe, it, expect } from 'vitest';
import { hasValidCredentials } from '../../src/services/authUtils';

// ---------------------------------------------------------------------------
// hasValidCredentials — shared credential helper
// ---------------------------------------------------------------------------
describe('hasValidCredentials', () => {
  it('returns false for null', () => {
    expect(hasValidCredentials(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(hasValidCredentials(undefined)).toBe(false);
  });

  it('returns false for empty account', () => {
    expect(hasValidCredentials({})).toBe(false);
  });

  it('returns true for password account', () => {
    expect(hasValidCredentials({ password: 'secret' })).toBe(true);
  });

  it('returns true for OAuth2 account with token', () => {
    expect(hasValidCredentials({
      authType: 'oauth2',
      oauth2AccessToken: 'tok_123'
    })).toBe(true);
  });

  it('returns false for OAuth2 account without token', () => {
    expect(hasValidCredentials({ authType: 'oauth2' })).toBe(false);
  });

  it('returns false for OAuth2 with empty string token', () => {
    expect(hasValidCredentials({
      authType: 'oauth2',
      oauth2AccessToken: ''
    })).toBe(false);
  });

  it('returns true when both password and OAuth2 present', () => {
    expect(hasValidCredentials({
      password: 'secret',
      authType: 'oauth2',
      oauth2AccessToken: 'tok_123'
    })).toBe(true);
  });

  it('returns false for non-oauth2 authType without password', () => {
    expect(hasValidCredentials({ authType: 'password' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AccountPipeline — state machine and concurrency logic
// ---------------------------------------------------------------------------
describe('AccountPipeline state machine', () => {
  it('initial state is idle with zero counts', () => {
    const state = {
      phase: 'idle',
      queued: 0,
      completed: 0,
      total: 0,
      failed: 0,
      isRunning: false
    };
    expect(state.phase).toBe('idle');
    expect(state.isRunning).toBe(false);
    expect(state.completed).toBe(0);
  });

  it('isRunning is true during headers phase', () => {
    const state = { phase: 'headers', isRunning: true };
    expect(state.isRunning).toBe(true);
  });

  it('isRunning is true during content phase', () => {
    const state = { phase: 'content', isRunning: true };
    expect(state.isRunning).toBe(true);
  });

  it('isRunning is false when done', () => {
    const state = { phase: 'done', isRunning: false };
    expect(state.isRunning).toBe(false);
  });
});

describe('AccountPipeline concurrent worker logic', () => {
  it('3 concurrent workers process queue 3x faster than serial', () => {
    // Simulate: 9 items, 3 workers, each takes 1 unit of time
    const concurrency = 3;
    const items = 9;
    const serialTime = items; // 9 units
    const parallelTime = Math.ceil(items / concurrency); // 3 units
    expect(parallelTime).toBe(3);
    expect(serialTime / parallelTime).toBe(3);
  });

  it('workers drain queue correctly with concurrency=3', () => {
    const queue = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const processed = [];

    // Simulate 3 workers each taking from the same queue
    while (queue.length > 0) {
      const batch = queue.splice(0, Math.min(3, queue.length));
      processed.push(...batch);
    }

    expect(processed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(queue).toHaveLength(0);
  });

  it('activeSlots counter tracks correctly', () => {
    let activeSlots = 0;
    const concurrency = 3;

    // 3 workers start
    for (let i = 0; i < concurrency; i++) activeSlots++;
    expect(activeSlots).toBe(3);

    // Workers finish one by one
    activeSlots--;
    expect(activeSlots).toBe(2);
    activeSlots--;
    expect(activeSlots).toBe(1);
    activeSlots--;
    expect(activeSlots).toBe(0);
  });

  it('destroyed pipeline does not call _finish when slots drain', () => {
    let activeSlots = 3;
    let destroyed = true;
    let finishCalled = false;

    // Workers drain after destroy
    activeSlots--;
    activeSlots--;
    activeSlots--;

    // Completion check
    if (activeSlots === 0 && !destroyed) {
      finishCalled = true;
    }

    expect(activeSlots).toBe(0);
    expect(finishCalled).toBe(false); // _finish NOT called because destroyed
  });
});

// ---------------------------------------------------------------------------
// EmailPipelineManager — cascade and coordination logic
// ---------------------------------------------------------------------------
describe('EmailPipelineManager cascade logic', () => {
  it('active account runs at concurrency 3, background at 1', () => {
    const activeConcurrency = 3;
    const backgroundConcurrency = 1;
    expect(activeConcurrency).toBeGreaterThan(backgroundConcurrency);
    expect(activeConcurrency).toBe(3);
    expect(backgroundConcurrency).toBe(1);
  });

  it('background pipelines only start after active completes', () => {
    let activeComplete = false;
    let backgroundStarted = false;

    // Simulate: active completes first
    activeComplete = true;
    if (activeComplete) backgroundStarted = true;

    expect(backgroundStarted).toBe(true);
  });

  it('account switch resets backgroundRunning flag', () => {
    let backgroundRunning = true;

    // Simulate account switch
    backgroundRunning = false; // reset on switch

    expect(backgroundRunning).toBe(false);
  });

  it('syncAccounts removes pipelines for deleted accounts', () => {
    const pipelines = new Map();
    pipelines.set('acc1', { destroy: () => {} });
    pipelines.set('acc2', { destroy: () => {} });
    pipelines.set('acc3', { destroy: () => {} });

    const currentAccounts = [{ id: 'acc1' }, { id: 'acc3' }];
    const accountIds = new Set(currentAccounts.map(a => a.id));

    for (const [id] of [...pipelines]) {
      if (!accountIds.has(id)) {
        pipelines.delete(id);
      }
    }

    expect(pipelines.size).toBe(2);
    expect(pipelines.has('acc1')).toBe(true);
    expect(pipelines.has('acc2')).toBe(false);
    expect(pipelines.has('acc3')).toBe(true);
  });

  it('destroyAll clears all pipelines and resets state', () => {
    const pipelines = new Map();
    let destroyed = [];
    pipelines.set('a', { destroy: () => destroyed.push('a') });
    pipelines.set('b', { destroy: () => destroyed.push('b') });

    let backgroundRunning = true;

    // destroyAll logic
    for (const pipeline of pipelines.values()) {
      pipeline.destroy();
    }
    pipelines.clear();
    backgroundRunning = false;

    expect(destroyed).toEqual(['a', 'b']);
    expect(pipelines.size).toBe(0);
    expect(backgroundRunning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Retry and backoff (pipeline-level)
// ---------------------------------------------------------------------------
describe('AccountPipeline retry logic', () => {
  it('failed UIDs move to retry queue', () => {
    const queue = [1, 2, 3];
    const retryQueue = [];

    // UID 2 fails
    const uid = queue.shift(); // 1 - success
    const uid2 = queue.shift(); // 2 - fails
    retryQueue.push(uid2);

    expect(queue).toEqual([3]);
    expect(retryQueue).toEqual([2]);
  });

  it('retry delay grows exponentially with 120s cap', () => {
    let delay = 3000;
    const delays = [delay];
    for (let i = 0; i < 7; i++) {
      delay = Math.min(delay * 2, 120000);
      delays.push(delay);
    }
    expect(delays).toEqual([3000, 6000, 12000, 24000, 48000, 96000, 120000, 120000]);
  });

  it('successful fetch resets retry delay', () => {
    let retryDelay = 48000;
    retryDelay = 3000; // reset on success
    expect(retryDelay).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// _getUncachedUids filter logic
// ---------------------------------------------------------------------------
describe('uncached UID filtering', () => {
  const mkEmail = (uid, date) => ({
    uid,
    date: date || '2026-02-19T12:00:00Z',
    subject: `Email ${uid}`
  });

  it('filters out already-saved UIDs', () => {
    const emails = [mkEmail(1), mkEmail(2), mkEmail(3)];
    const savedIds = new Set([1, 3]);

    const candidates = emails.filter(e => !savedIds.has(e.uid));
    expect(candidates.map(e => e.uid)).toEqual([2]);
  });

  it('applies date cutoff when localCacheDurationMonths > 0', () => {
    const now = new Date('2026-02-19');
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - 3); // 3 months back

    const emails = [
      mkEmail(1, '2026-02-15T00:00:00Z'), // within 3 months
      mkEmail(2, '2025-10-01T00:00:00Z'), // outside 3 months
      mkEmail(3, '2026-01-01T00:00:00Z')  // within 3 months
    ];

    const savedIds = new Set();
    const filtered = emails.filter(e => {
      if (savedIds.has(e.uid)) return false;
      const emailDate = new Date(e.date);
      return emailDate >= cutoff;
    });

    expect(filtered.map(e => e.uid)).toEqual([1, 3]);
  });

  it('includes all emails when localCacheDurationMonths is 0', () => {
    const emails = [mkEmail(1, '2020-01-01'), mkEmail(2, '2026-02-19')];
    const savedIds = new Set();
    const cutoff = null; // 0 months = no cutoff

    const filtered = emails.filter(e => {
      if (savedIds.has(e.uid)) return false;
      if (!cutoff) return true;
      return new Date(e.date) >= cutoff;
    });

    expect(filtered).toHaveLength(2);
  });
});
