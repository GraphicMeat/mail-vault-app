import { describe, it, expect } from 'vitest';
import { createSyncSlice, serverVerifiedPatch, refuseEmptyOnce, clearEmptyRefusals } from '../../src/stores/slices/syncSlice.js';

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

describe('empty-mailbox refusals', () => {
  it('refuses the first empty answer and believes the second', () => {
    const key = 'acc-1:INBOX';
    clearEmptyRefusals(key);
    expect(refuseEmptyOnce(key)).toBe(true);
    expect(refuseEmptyOnce(key)).toBe(false);
  });

  it('stays believed for the rest of the session - the suspicion inputs never clear', () => {
    // Regression: a counter reset on acceptance would re-verify the same empty
    // folder on every load for ever, because `lastKnownGoodTotalEmails` and the
    // vault copies that make it look suspicious are preserved deliberately.
    const key = 'acc-1:Archive';
    clearEmptyRefusals(key);
    refuseEmptyOnce(key);
    expect(refuseEmptyOnce(key)).toBe(false);
    expect(refuseEmptyOnce(key)).toBe(false);
  });

  it('a real answer re-arms the free look for a mailbox that empties later', () => {
    const key = 'acc-2:INBOX';
    clearEmptyRefusals(key);
    refuseEmptyOnce(key);
    clearEmptyRefusals(key); // loadEmails does this whenever serverTotal > 0
    expect(refuseEmptyOnce(key)).toBe(true);
  });

  it('tracks mailboxes independently', () => {
    clearEmptyRefusals('acc-3:INBOX');
    clearEmptyRefusals('acc-3:Sent');
    refuseEmptyOnce('acc-3:INBOX');
    expect(refuseEmptyOnce('acc-3:Sent')).toBe(true);
  });
});
