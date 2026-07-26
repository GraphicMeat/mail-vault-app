import { describe, it, expect, beforeEach } from 'vitest';

const { remember, recall, forget, _size } = await import('../headerMemo.js');

const META = { totalEmails: 3, totalCached: 3, highestModseq: 900 };
const EMAILS = [{ uid: 3 }, { uid: 2 }, { uid: 1 }];

let n = 0;
const nextId = () => `acc${++n}`;

beforeEach(() => {
  for (let i = 0; i <= n; i++) forget(`acc${i}`);
});

describe('headerMemo', () => {
  it('returns a complete set back', () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS, META);
    expect(recall(id, 'INBOX', META)).toEqual(EMAILS);
  });

  // A partial set recalled as if complete would leave the rest never loaded.
  it('refuses to memoize a partial set', () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS.slice(0, 2), { ...META, totalEmails: 3 });
    expect(recall(id, 'INBOX', META)).toBeNull();
  });

  // The daemon writes sidecars on its own schedule; an in-memory copy must not
  // outlive the disk state it was taken from.
  it('invalidates when the cache changed underneath it', () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS, META);
    expect(recall(id, 'INBOX', { ...META, highestModseq: 901 })).toBeNull();
    expect(recall(id, 'INBOX', META)).toBeNull(); // and the entry is gone
  });

  it('invalidates on a new message even at the same modseq', () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS, META);
    expect(recall(id, 'INBOX', { ...META, totalCached: 4, totalEmails: 4 })).toBeNull();
  });

  it('invalidates when the cache was cleared out from under it', () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS, META);
    expect(recall(id, 'INBOX', null)).toBeNull();
  });

  it('keeps mailboxes of one account separate', () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS, META);
    expect(recall(id, 'Sent', META)).toBeNull();
    expect(recall(id, 'INBOX', META)).toEqual(EMAILS);
  });

  it('evicts least-recently-used past the cap, keeping the touched one', () => {
    const ids = [nextId(), nextId(), nextId(), nextId()];
    for (const id of ids.slice(0, 3)) remember(id, 'INBOX', EMAILS, META);
    expect(_size()).toBe(3);

    // Touch the oldest so it is no longer the eviction candidate.
    expect(recall(ids[0], 'INBOX', META)).toEqual(EMAILS);

    remember(ids[3], 'INBOX', EMAILS, META);
    expect(_size()).toBe(3);
    expect(recall(ids[0], 'INBOX', META)).toEqual(EMAILS); // survived
    expect(recall(ids[1], 'INBOX', META)).toBeNull();      // evicted
  });

  // The stamp CANNOT see a local flag change: save_email_cache preserves
  // highestModseq and the sidecar count doesn't move, so marking a message read
  // leaves all three fields identical. That's why the caller must snapshot the
  // store on switch-away rather than the disk read that seeded it — this test
  // pins the limitation so nobody "fixes" it by memoizing off disk again.
  it('cannot detect a local flag change — stamp is blind to it', () => {
    const id = nextId();
    const read = EMAILS.map(e => ({ ...e, flags: ['\\Seen'] }));
    remember(id, 'INBOX', read, META);
    // Same stamp, even though flags on disk changed.
    expect(recall(id, 'INBOX', META)).toBe(read);
  });

  it('forgets a whole account', () => {
    const id = nextId();
    remember(id, 'INBOX', EMAILS, META);
    remember(id, 'Sent', EMAILS, META);
    forget(id);
    expect(recall(id, 'INBOX', META)).toBeNull();
    expect(recall(id, 'Sent', META)).toBeNull();
  });
});
