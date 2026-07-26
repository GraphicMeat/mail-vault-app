import { describe, it, expect, beforeEach, vi } from 'vitest';

const { remember, recall, peek, forget, _size } = await import('../headerMemo.js');

const META = { totalEmails: 3, totalCached: 3, highestModseq: 900 };
const EMAILS = [{ uid: 3 }, { uid: 2 }, { uid: 1 }];

let n = 0;
const nextId = () => `acc${++n}`;

/**
 * Fake sidecar directory. `changed` is what a readdir+mtime scan would report as
 * written since the memo snapshot.
 */
function fakeIo({ uids, changed = [], rows = [] }) {
  return {
    listCachedUids: vi.fn(async () => ({ uids, changed })),
    getEmailHeadersByUids: vi.fn(async (_a, _m, wanted) =>
      rows.filter(r => wanted.includes(r.uid))
    ),
  };
}

beforeEach(() => {
  for (let i = 0; i <= n; i++) forget(`acc${i}`);
});

describe('headerMemo', () => {
  it('returns a complete set back', async () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS, META);
    expect(await recall(id, 'INBOX', META)).toEqual(EMAILS);
  });

  // A partial set recalled as if complete would leave the rest never loaded.
  it('refuses to memoize a partial set', async () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS.slice(0, 2), { ...META, totalEmails: 3 });
    expect(await recall(id, 'INBOX', META)).toBeNull();
  });

  // The daemon writes sidecars on its own schedule; an in-memory copy must not
  // outlive the disk state it was taken from.
  it('drops the memo on a stamp mismatch when it cannot reconcile', async () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS, META);
    expect(await recall(id, 'INBOX', { ...META, highestModseq: 901 })).toBeNull();
    expect(await recall(id, 'INBOX', META)).toBeNull(); // and the entry is gone
  });

  it('invalidates when the cache was cleared out from under it', async () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS, META);
    expect(await recall(id, 'INBOX', null)).toBeNull();
  });

  it('keeps mailboxes of one account separate', async () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS, META);
    expect(await recall(id, 'Sent', META)).toBeNull();
    expect(await recall(id, 'INBOX', META)).toEqual(EMAILS);
  });

  it('evicts least-recently-used past the cap, keeping the touched one', async () => {
    const ids = [nextId(), nextId(), nextId(), nextId()];
    for (const id of ids.slice(0, 3)) remember(id, 'INBOX', EMAILS, META);
    expect(_size()).toBe(3);

    // Touch the oldest so it is no longer the eviction candidate.
    expect(await recall(ids[0], 'INBOX', META)).toEqual(EMAILS);

    remember(ids[3], 'INBOX', EMAILS, META);
    expect(_size()).toBe(3);
    expect(await recall(ids[0], 'INBOX', META)).toEqual(EMAILS); // survived
    expect(await recall(ids[1], 'INBOX', META)).toBeNull();      // evicted
  });

  // The stamp CANNOT see a local flag change: save_email_cache preserves
  // highestModseq and the sidecar count doesn't move, so marking a message read
  // leaves all three fields identical. That's why the caller must snapshot the
  // store on switch-away rather than the disk read that seeded it — this test
  // pins the limitation so nobody "fixes" it by memoizing off disk again.
  it('cannot detect a local flag change — stamp is blind to it', async () => {
    const id = nextId();
    const read = EMAILS.map(e => ({ ...e, flags: ['\\Seen'] }));
    remember(id, 'INBOX', read, META);
    // Same stamp, even though flags on disk changed.
    expect(await recall(id, 'INBOX', META)).toBe(read);
  });

  it('forgets a whole account', async () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS, META);
    remember(id, 'Sent', EMAILS, META);
    forget(id);
    expect(await recall(id, 'INBOX', META)).toBeNull();
    expect(await recall(id, 'Sent', META)).toBeNull();
  });

  describe('peek', () => {
    it('returns the set without any freshness check', () => {
      const id = nextId();
      remember(id, 'INBOX', EMAILS, META);
      expect(peek(id, 'INBOX')).toBe(EMAILS);
    });

    it('returns null when nothing is memoized', () => {
      expect(peek(nextId(), 'INBOX')).toBeNull();
    });
  });

  describe('reconcile on stamp mismatch', () => {
    const GREW = { totalEmails: 4, totalCached: 4, highestModseq: 901 };

    // The whole point: one new message must cost one sidecar read, not a full
    // re-read of the mailbox. This is the regression that made switching back to
    // a 9k account restart the list at 500.
    it('reads only the arrived UID, not the whole mailbox', async () => {
      const id = nextId();
      remember(id, 'INBOX', EMAILS, META);
      const io = fakeIo({ uids: [4, 3, 2, 1], changed: [4], rows: [{ uid: 4 }] });

      expect(await recall(id, 'INBOX', GREW, io)).toEqual([
        { uid: 4 }, { uid: 3 }, { uid: 2 }, { uid: 1 },
      ]);
      expect(io.getEmailHeadersByUids).toHaveBeenCalledTimes(1);
      expect(io.getEmailHeadersByUids.mock.calls[0][2]).toEqual([4]);
    });

    it('asks only for sidecars written since the snapshot', async () => {
      const id = nextId();
      remember(id, 'INBOX', EMAILS, META);
      const io = fakeIo({ uids: [4, 3, 2, 1], changed: [4], rows: [{ uid: 4 }] });

      await recall(id, 'INBOX', GREW, io);
      const since = io.listCachedUids.mock.calls[0][2];
      expect(since).toBeLessThan(Date.now());
      expect(since).toBeGreaterThan(0);
    });

    it('re-reads a row the daemon rewrote', async () => {
      const id = nextId();
      remember(id, 'INBOX', EMAILS, META);
      const io = fakeIo({
        uids: [3, 2, 1],
        changed: [2],
        rows: [{ uid: 2, flags: ['\\Seen'] }],
      });

      const out = await recall(id, 'INBOX', { ...META, highestModseq: 901 }, io);
      expect(out).toEqual([{ uid: 3 }, { uid: 2, flags: ['\\Seen'] }, { uid: 1 }]);
    });

    it('drops a row whose sidecar was expunged', async () => {
      const id = nextId();
      remember(id, 'INBOX', EMAILS, META);
      const io = fakeIo({ uids: [3, 1], changed: [] });

      const out = await recall(id, 'INBOX', { totalEmails: 2, totalCached: 2, highestModseq: 901 }, io);
      expect(out).toEqual([{ uid: 3 }, { uid: 1 }]);
      expect(io.getEmailHeadersByUids).not.toHaveBeenCalled();
    });

    // Reconciled sets are restamped, so the next switch back is a plain hit.
    it('restamps, so the next recall touches no io at all', async () => {
      const id = nextId();
      remember(id, 'INBOX', EMAILS, META);
      const io = fakeIo({ uids: [4, 3, 2, 1], changed: [4], rows: [{ uid: 4 }] });
      await recall(id, 'INBOX', GREW, io);

      const io2 = fakeIo({ uids: [4, 3, 2, 1] });
      expect(await recall(id, 'INBOX', GREW, io2)).toHaveLength(4);
      expect(io2.listCachedUids).not.toHaveBeenCalled();
    });

    // Past half the mailbox, N single reads lose to the one bulk read the caller
    // does on a miss.
    it('gives up when too much of the mailbox moved', async () => {
      const id = nextId();
      remember(id, 'INBOX', EMAILS, META);
      const io = fakeIo({ uids: [4, 3, 2, 1], changed: [4, 3, 2] });

      expect(await recall(id, 'INBOX', GREW, io)).toBeNull();
      expect(io.getEmailHeadersByUids).not.toHaveBeenCalled();
    });

    // A short read must never be restamped as current — the missing rows would
    // never be fetched by anything.
    it('gives up when a sidecar read comes back short', async () => {
      const id = nextId();
      remember(id, 'INBOX', EMAILS, META);
      const io = fakeIo({ uids: [4, 3, 2, 1], changed: [4], rows: [] });

      expect(await recall(id, 'INBOX', GREW, io)).toBeNull();
      expect(await recall(id, 'INBOX', META)).toBeNull(); // entry dropped
    });

    // Reconciling compares UID sets, and after a UIDVALIDITY change the same UID
    // names a different message — the sets would look equal and an old
    // generation would be restamped as current.
    it('refuses to reconcile across a UIDVALIDITY change', async () => {
      const id = nextId();
      remember(id, 'INBOX', EMAILS, { ...META, uidValidity: 1 });
      const io = fakeIo({ uids: [3, 2, 1], changed: [] });

      expect(await recall(id, 'INBOX', { ...META, uidValidity: 2 }, io)).toBeNull();
      expect(io.listCachedUids).not.toHaveBeenCalled();
    });

    it('gives up when the directory listing is unavailable', async () => {
      const id = nextId();
      remember(id, 'INBOX', EMAILS, META);
      const io = {
        listCachedUids: vi.fn(async () => null),
        getEmailHeadersByUids: vi.fn(),
      };
      expect(await recall(id, 'INBOX', GREW, io)).toBeNull();
    });
  });
});
