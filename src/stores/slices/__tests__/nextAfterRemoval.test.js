// What a delete leaves open (settings.behavior.afterDeleting): the direction,
// and the wishes (unread, same account) it gives up one at a time rather than
// close the reader.
import { describe, it, expect } from 'vitest';
import { nextAfterRemoval, afterDeleteRule } from '../unifiedHelpers';

const row = (uid, extra = {}) => ({ uid, flags: ['\\Seen'], _accountId: 'a', ...extra });
const rows = [row(1), row(2, { _accountId: 'b' }), row(3), row(4, { flags: [] }), row(5, { _accountId: 'b', flags: [] })];
const open = (uid) => (e) => e.uid === uid;
const none = () => false;
const unread = (e) => !e.flags.includes('\\Seen');
const sameAs = (uid) => (e) => e._accountId === rows.find(open(uid))._accountId;

describe('nextAfterRemoval', () => {
  it('takes the row below by default, the row above when the deleted one was last', () => {
    expect(nextAfterRemoval(rows, open(3), none).uid).toBe(4);
    expect(nextAfterRemoval(rows, open(5), none).uid).toBe(4);
  });

  it('backward: takes the row above, the row below when the deleted one was first', () => {
    expect(nextAfterRemoval(rows, open(3), none, { backward: true }).uid).toBe(2);
    expect(nextAfterRemoval(rows, open(1), none, { backward: true }).uid).toBe(2);
  });

  it('skips rows the same delete is taking, in either direction', () => {
    expect(nextAfterRemoval(rows, open(3), open(2), { backward: true }).uid).toBe(1);
  });

  it('prefers a row every wish holds for, in the chosen direction first', () => {
    expect(nextAfterRemoval(rows, open(1), none, { prefer: [unread] }).uid).toBe(4);
    expect(nextAfterRemoval(rows, open(5), none, { backward: true, prefer: [unread] }).uid).toBe(4);
  });

  it('looks the other way for a wished row before giving the wish up', () => {
    expect(nextAfterRemoval(rows, open(5), none, { prefer: [unread] }).uid).toBe(4);
  });

  it('gives up the last wish first: same account outlives unread', () => {
    // Account a has one unread row (4) and it is the one going.
    expect(nextAfterRemoval(rows, open(4), none, { prefer: [sameAs(4), unread] }).uid).toBe(3);
  });

  it('with no wished row anywhere, falls back to the plain neighbour', () => {
    const read = [row(1), row(2), row(3)];
    expect(nextAfterRemoval(read, open(2), none, { prefer: [unread] }).uid).toBe(3);
  });

  it('answers nothing when the open row is not in the list or nothing survives', () => {
    expect(nextAfterRemoval(rows, open(99), none)).toBeNull();
    expect(nextAfterRemoval([row(1)], open(1), none)).toBeNull();
  });
});

describe('afterDeleteRule', () => {
  it('reads each setting value as a direction and an unread wish', () => {
    expect(afterDeleteRule('none')).toBeNull();
    expect(afterDeleteRule('next')).toEqual({ backward: false, unread: false });
    expect(afterDeleteRule('previous')).toEqual({ backward: true, unread: false });
    expect(afterDeleteRule('nextUnread')).toEqual({ backward: false, unread: true });
    expect(afterDeleteRule('previousUnread')).toEqual({ backward: true, unread: true });
  });

  it('reads a value it does not know as nothing', () => {
    expect(afterDeleteRule('sideways')).toBeNull();
    expect(afterDeleteRule(undefined)).toBeNull();
  });
});
