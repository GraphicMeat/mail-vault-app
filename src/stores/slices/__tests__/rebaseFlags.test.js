// A loader that reads a list, awaits the network and then commits what it read
// puts back every flag the user changed in between. rebaseFlags is the
// three-way merge that stops it: `base` is the rows the loader started from,
// `live` the rows in the store at commit time, `incoming` what it is about to
// commit. A row whose flags moved between base and live was written locally
// since the snapshot, and that change (per flag) is laid over the incoming row.
import { describe, it, expect } from 'vitest';
import { rebaseFlags } from '../unifiedHelpers';

const A = 'acctA';
const B = 'acctB';
const view = { activeAccountId: A, activeMailbox: 'INBOX', getSentMailboxPath: () => 'Sent' };
const unifiedView = { ...view, activeMailbox: 'UNIFIED' };

const row = (uid, flags = [], extra = {}) => ({ uid, subject: `m${uid}`, flags, ...extra });
const flagsOf = (rows, uid) => rows.find(r => r.uid === uid)?.flags;
const sorted = (f) => [...f].sort();

describe('rebaseFlags', () => {
  it('returns the incoming array itself when nothing was written locally (live is the base)', () => {
    const base = [row(1), row(2)];
    const incoming = [row(1, ['\\Seen']), row(2)];
    expect(rebaseFlags(base, base, incoming, view)).toBe(incoming);
  });

  it('takes the incoming flags when the live row still carries the base flags', () => {
    const base = [row(1, [])];
    const live = [row(1, [])]; // a different array, but no flag moved
    const incoming = [row(1, ['\\Seen'])];
    expect(flagsOf(rebaseFlags(base, live, incoming, view), 1)).toEqual(['\\Seen']);
  });

  it('keeps a local mark-read the incoming (stale) row does not have', () => {
    const base = [row(1, []), row(2, [])];
    const live = [row(1, ['\\Seen']), row(2, [])];
    const incoming = [row(1, []), row(2, [])];
    const out = rebaseFlags(base, live, incoming, view);
    expect(flagsOf(out, 1)).toEqual(['\\Seen']);
    expect(flagsOf(out, 2)).toEqual([]);
  });

  it('keeps a local mark-unread over an incoming row that still says read', () => {
    const base = [row(1, ['\\Seen'])];
    const live = [row(1, [])];
    const incoming = [row(1, ['\\Seen'])];
    expect(flagsOf(rebaseFlags(base, live, incoming, view), 1)).toEqual([]);
  });

  it('lays the local change over a remote change to ANOTHER flag instead of dropping it', () => {
    // The user marks it read while the server reports a new star. CONDSTORE
    // never reports that star again, so discarding it here would lose it.
    const base = [row(1, [])];
    const live = [row(1, ['\\Seen'])];
    const incoming = [row(1, ['\\Flagged'])];
    expect(sorted(flagsOf(rebaseFlags(base, live, incoming, view), 1))).toEqual(['\\Flagged', '\\Seen']);
  });

  it('is order-insensitive: reordered flags are not a local write', () => {
    const base = [row(1, ['\\Seen', '\\Flagged'])];
    const live = [row(1, ['\\Flagged', '\\Seen'])];
    const incoming = [row(1, ['\\Seen'])]; // the server dropped the star
    expect(flagsOf(rebaseFlags(base, live, incoming, view), 1)).toEqual(['\\Seen']);
  });

  it('takes the incoming row whole when it was not in the base', () => {
    const base = [row(1, [])];
    const live = [row(1, ['\\Seen']), row(9, ['\\Seen'])];
    const incoming = [row(1, []), row(9, [])];
    const out = rebaseFlags(base, live, incoming, view);
    expect(flagsOf(out, 1)).toEqual(['\\Seen']);
    expect(flagsOf(out, 9)).toEqual([]);
  });

  it('leaves every other field of the incoming row alone', () => {
    const base = [row(1, [])];
    const live = [row(1, ['\\Seen'])];
    const incoming = [row(1, [], { subject: 'fresh from the server', hasAttachments: true })];
    const out = rebaseFlags(base, live, incoming, view);
    expect(out[0]).toMatchObject({ subject: 'fresh from the server', hasAttachments: true, flags: ['\\Seen'] });
  });

  it('matches by message identity, never by bare uid (unified list, same uid in two accounts)', () => {
    const rowA = (flags) => row(5, flags, { _accountId: A, _mailbox: 'INBOX' });
    const rowB = (flags) => row(5, flags, { _accountId: B, _mailbox: 'INBOX' });
    const base = [rowA([]), rowB([])];
    const live = [rowA(['\\Seen']), rowB([])]; // only account A's uid 5 was read
    const incoming = [rowA([]), rowB([])];
    const out = rebaseFlags(base, live, incoming, unifiedView);
    expect(out.find(r => r._accountId === A).flags).toEqual(['\\Seen']);
    expect(out.find(r => r._accountId === B).flags).toEqual([]);
  });

  it('matches by message identity across folders (a merged Sent copy shares the uid)', () => {
    const inboxRow = (flags) => row(5, flags, { _accountId: A, _mailbox: 'INBOX' });
    const sentRow = (flags) => row(5, flags, { _accountId: A, _mailbox: 'Sent', _fromSentFolder: true });
    const base = [inboxRow([]), sentRow([])];
    const live = [inboxRow([]), sentRow(['\\Seen'])];
    const incoming = [inboxRow([]), sentRow([])];
    const out = rebaseFlags(base, live, incoming, view);
    expect(out[0].flags).toEqual([]);
    expect(out[1].flags).toEqual(['\\Seen']);
  });

  it('never rebases a row whose location cannot be resolved', () => {
    // A foreign account's untagged row: matches nothing, so nothing is carried.
    const foreign = (flags) => row(5, flags, { _accountId: B });
    const base = [foreign([])];
    const live = [foreign(['\\Seen'])];
    const incoming = [foreign([])];
    expect(flagsOf(rebaseFlags(base, live, incoming, view), 5)).toEqual([]);
  });

  it('returns the incoming array itself when the live rows changed but no flag did', () => {
    const base = [row(1, [])];
    const live = [row(1, []), row(2, [])]; // loadMore appended a row
    const incoming = [row(1, ['\\Seen'])];
    expect(rebaseFlags(base, live, incoming, view)).toBe(incoming);
  });

  it('tolerates empty and missing inputs', () => {
    const incoming = [row(1, [])];
    expect(rebaseFlags([], [], incoming, view)).toBe(incoming);
    expect(rebaseFlags(undefined, undefined, incoming, view)).toBe(incoming);
    expect(rebaseFlags([row(1)], [row(1, ['\\Seen'])], [], view)).toEqual([]);
  });
});
