import { describe, it, expect } from 'vitest';
import { createSyncSlice, serverVerifiedPatch } from '../../src/stores/slices/syncSlice.js';

const suspect = (over = {}) => ({
  accountId: 'acc-1',
  type: 'emails',
  message: 'Email cache was empty but local data exists. Rebuilding from local copies while syncing with server.',
  timestamp: 1754600000000,
  ...over,
});

describe('serverVerifiedPatch', () => {
  it('clears the cached-data warning', () => {
    expect(serverVerifiedPatch().suspectEmptyServerData).toBeNull();
  });

  it('marks the connection healthy and stops loading', () => {
    const p = serverVerifiedPatch();
    expect(p.connectionStatus).toBe('connected');
    expect(p.connectionError).toBeNull();
    expect(p.connectionErrorType).toBeNull();
    expect(p.loading).toBe(false);
    expect(p.loadingMore).toBe(false);
  });

  it('carries extras without losing the warning clear', () => {
    const p = serverVerifiedPatch({ totalEmails: 7, hasMoreEmails: false });
    expect(p.totalEmails).toBe(7);
    expect(p.hasMoreEmails).toBe(false);
    expect(p.suspectEmptyServerData).toBeNull();
  });

  it('regression: a fast-path verify drops a banner raised before it', () => {
    // probe-unchanged / delta-noop used to setState without touching
    // suspectEmptyServerData, so a banner raised earlier survived every later
    // activation — and the banner's reload button (which re-runs
    // activateAccount into those same fast paths) looked dead.
    const state = { ...createSyncSlice(() => {}, () => state), suspectEmptyServerData: suspect() };
    Object.assign(state, serverVerifiedPatch());
    expect(state.suspectEmptyServerData).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.loadingMore).toBe(false);
  });
});
