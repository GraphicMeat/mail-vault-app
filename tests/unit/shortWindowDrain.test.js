import { describe, it, expect } from 'vitest';
import { shortWindowPatch } from '../../src/stores/slices/syncSlice.js';

// Field case (2026-08-17): the daemon had written all 11 headers to disk while
// the store window still held 3. `mailboxIsUnchanged` compares the CACHE to the
// SERVER, so it answered "unchanged" and `loadServerEmails` returned without
// touching the list — every later activation did the same, and the header sat
// at "3 of 11 emails" with a reload button that looked dead.
const meta = (over = {}) => ({ totalEmails: 11, totalCached: 11, ...over });

describe('shortWindowPatch', () => {
  it('re-arms the drain when the window is short of the cache', () => {
    expect(shortWindowPatch(3, meta())).toEqual({ hasMoreEmails: true, totalEmails: 11 });
  });

  it('leaves a complete window alone — arming it would re-page the server forever', () => {
    expect(shortWindowPatch(11, meta())).toBeNull();
    expect(shortWindowPatch(12, meta())).toBeNull(); // optimistic rows can overshoot
  });

  it('counts the server total when the cache is short of it too', () => {
    // Cache wiped by the UIDVALIDITY branch: nothing on disk, 11 on the server.
    // The drain finds nothing to drain and falls through to server pagination.
    expect(shortWindowPatch(0, meta({ totalCached: 0 }))).toEqual({
      hasMoreEmails: true,
      totalEmails: 11,
    });
  });

  it('counts the cache when it is ahead of a stale server total', () => {
    expect(shortWindowPatch(3, meta({ totalEmails: 4, totalCached: 11 }))).toEqual({
      hasMoreEmails: true,
      totalEmails: 11,
    });
  });

  it('stays silent when there is nothing to know', () => {
    expect(shortWindowPatch(0, null)).toBeNull();
    expect(shortWindowPatch(0, meta({ totalEmails: 0, totalCached: 0 }))).toBeNull();
    expect(shortWindowPatch(0, {})).toBeNull();
  });
});
