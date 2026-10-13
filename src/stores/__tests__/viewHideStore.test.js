import { beforeEach, describe, expect, it } from 'vitest';
import { useViewHideStore } from '../viewHideStore';

beforeEach(() => {
  useViewHideStore.getState().clear();
});

describe('view hide store', () => {
  it('starts unknown', () => {
    const s = useViewHideStore.getState();
    expect(s.keys).toBeNull();
    expect(s.unreadByMailbox).toBeNull();
    expect(s.hiddenByMailbox).toBeNull();
  });

  it('available reply becomes a key set and per-mailbox counts', () => {
    useViewHideStore.getState().setMembers({ available: true, members: { a: { INBOX: { uids: [1, 3], unread: 1 } } } });
    const s = useViewHideStore.getState();
    expect([...s.keys]).toEqual(['a|INBOX|1', 'a|INBOX|3']);
    expect(s.unreadByMailbox).toEqual({ 'a|INBOX': 1 });
    expect(s.hiddenByMailbox).toEqual({ 'a|INBOX': 2 });
  });

  it('unavailable reply means unknown, never an empty set', () => {
    useViewHideStore.getState().setMembers({ available: true, members: { a: { INBOX: { uids: [1], unread: 0 } } } });
    useViewHideStore.getState().setMembers({ available: false, members: {} });
    const s = useViewHideStore.getState();
    expect(s.keys).toBeNull();
    expect(s.unreadByMailbox).toBeNull();
    expect(s.hiddenByMailbox).toBeNull();
  });

  it('a missing reply means unknown', () => {
    useViewHideStore.getState().setMembers(null);
    expect(useViewHideStore.getState().keys).toBeNull();
  });

  it('an available reply with no members is a complete answer that hides nothing', () => {
    useViewHideStore.getState().setMembers({ available: true, members: {} });
    const s = useViewHideStore.getState();
    expect(s.keys).toBeInstanceOf(Set);
    expect(s.keys.size).toBe(0);
    expect(s.unreadByMailbox).toEqual({});
    expect(s.hiddenByMailbox).toEqual({});
  });

  it('spans accounts and mailboxes, and every reply is a new set', () => {
    useViewHideStore.getState().setMembers({ available: true, members: { a: { INBOX: { uids: [1], unread: 0 } } } });
    const first = useViewHideStore.getState().keys;
    useViewHideStore.getState().setMembers({
      available: true,
      members: { a: { INBOX: { uids: [1], unread: 0 }, 'Work/Q4': { uids: [7, 8, 9], unread: 2 } }, b: { INBOX: { uids: [1], unread: 1 } } },
    });
    const s = useViewHideStore.getState();
    expect(s.keys).not.toBe(first);
    expect([...s.keys].sort()).toEqual(['a|INBOX|1', 'a|Work/Q4|7', 'a|Work/Q4|8', 'a|Work/Q4|9', 'b|INBOX|1']);
    expect(s.hiddenByMailbox).toEqual({ 'a|INBOX': 1, 'a|Work/Q4': 3, 'b|INBOX': 1 });
    expect(s.unreadByMailbox).toEqual({ 'a|INBOX': 0, 'a|Work/Q4': 2, 'b|INBOX': 1 });
  });

  it('clear goes back to unknown', () => {
    useViewHideStore.getState().setMembers({ available: true, members: { a: { INBOX: { uids: [1], unread: 1 } } } });
    useViewHideStore.getState().clear();
    expect(useViewHideStore.getState().keys).toBeNull();
    expect(useViewHideStore.getState().hiddenByMailbox).toBeNull();
  });
});
