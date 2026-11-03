import { describe, it, expect } from 'vitest';
import { getRowParties, getRowParty, reconcileThreads, rowStamp } from '../emailParser';

const addr = (address, name = '') => ({ address, name });
const mail = (extra = {}) => ({
  uid: 1, from: addr('me@x.test', 'Me'), to: [], cc: [], flags: ['\\Seen'],
  isLocal: false, isArchived: false, source: 'server', ...extra,
});

describe('getRowParties', () => {
  it('names every recipient of an outgoing message, To then Cc', () => {
    const e = mail({ to: [addr('a@x.test'), addr('b@x.test')], cc: [addr('c@x.test')] });
    expect(getRowParties(e, { outgoing: true }).map(p => p.address)).toEqual(['a@x.test', 'b@x.test', 'c@x.test']);
  });

  it('dedupes a recipient listed twice, ignoring case', () => {
    const e = mail({ to: [addr('A@x.test'), addr('a@x.test')], cc: [addr('a@X.test')] });
    expect(getRowParties(e, { outgoing: true })).toHaveLength(1);
  });

  it('falls back to the sender when an outgoing message has no recipient', () => {
    expect(getRowParties(mail(), { outgoing: true }).map(p => p.address)).toEqual(['me@x.test']);
  });

  it('is just the sender everywhere else', () => {
    const e = mail({ to: [addr('a@x.test')] });
    expect(getRowParties(e).map(p => p.address)).toEqual(['me@x.test']);
  });

  it('keeps getRowParty as the first party', () => {
    const e = mail({ to: [addr('a@x.test'), addr('b@x.test')] });
    expect(getRowParty(e, { outgoing: true }).address).toBe('a@x.test');
  });
});

describe('reconcileThreads', () => {
  const thread = (id, emails, extra = {}) => ({
    threadId: id, emails, lastEmail: emails[emails.length - 1],
    unreadCount: 0, messageCount: emails.length, ...extra,
  });

  it('hands back the previous thread object when nothing in it changed', () => {
    const e1 = mail({ uid: 1 });
    const e2 = mail({ uid: 2 });
    const prev = new Map([['a', thread('a', [e1])], ['b', thread('b', [e2])]]);
    const next = new Map([['a', thread('a', [e1])], ['b', thread('b', [e2])]]);
    const out = reconcileThreads(prev, next);
    expect(out.get('a')).toBe(prev.get('a'));
    expect(out.get('b')).toBe(prev.get('b'));
  });

  it('takes the new object only for the thread that changed', () => {
    const e1 = mail({ uid: 1 });
    const e2 = mail({ uid: 2 });
    const e2b = { ...e2, flags: [] };
    const prev = new Map([['a', thread('a', [e1])], ['b', thread('b', [e2])]]);
    const next = new Map([['a', thread('a', [e1])], ['b', thread('b', [e2b], { unreadCount: 1 })]]);
    const out = reconcileThreads(prev, next);
    expect(out.get('a')).toBe(prev.get('a'));
    expect(out.get('b')).toBe(next.get('b'));
  });

  it('takes the new object when a reply joined the thread', () => {
    const e1 = mail({ uid: 1 });
    const prev = new Map([['a', thread('a', [e1])]]);
    const next = new Map([['a', thread('a', [e1, mail({ uid: 2 })])]]);
    expect(reconcileThreads(prev, next).get('a')).toBe(next.get('a'));
  });

  it('drops a thread that is gone and adds one that arrived', () => {
    const e1 = mail({ uid: 1 });
    const e2 = mail({ uid: 2 });
    const prev = new Map([['a', thread('a', [e1])]]);
    const next = new Map([['b', thread('b', [e2])]]);
    const out = reconcileThreads(prev, next);
    expect([...out.keys()]).toEqual(['b']);
    expect(out.get('b')).toBe(next.get('b'));
  });

  it('keeps the new map order', () => {
    const e1 = mail({ uid: 1 });
    const e2 = mail({ uid: 2 });
    const prev = new Map([['a', thread('a', [e1])], ['b', thread('b', [e2])]]);
    const next = new Map([['b', thread('b', [e2])], ['a', thread('a', [e1])]]);
    expect([...reconcileThreads(prev, next).keys()]).toEqual(['b', 'a']);
  });

  it('copes with no previous map', () => {
    const next = new Map([['a', thread('a', [mail()])]]);
    expect(reconcileThreads(null, next)).toBe(next);
  });
});

describe('rowStamp', () => {
  it('is stable while nothing the row paints changed', () => {
    expect(rowStamp(mail())).toBe(rowStamp(mail()));
  });

  it.each([
    ['isArchived', { isArchived: true }],
    ['isLocal', { isLocal: true }],
    ['source', { source: 'local' }],
    ['flags', { flags: [] }],
    ['_linkAlert', { _linkAlert: 'red' }],
    ['_senderAlert', { _senderAlert: { level: 'warn' } }],
    ['_replyToMismatch', { _replyToMismatch: { to: 'z@x.test' } }],
    ['_trackerInfo', { _trackerInfo: { count: 2 } }],
  ])('moves when %s moves', (_name, patch) => {
    expect(rowStamp(mail(patch))).not.toBe(rowStamp(mail()));
  });

  it('covers every member of a thread', () => {
    const a = mail({ uid: 1 });
    const b = mail({ uid: 2 });
    const before = rowStamp({ emails: [a, b] });
    b.isArchived = true;
    expect(rowStamp({ emails: [a, b] })).not.toBe(before);
  });
});
