import { describe, it, expect } from 'vitest';
import { findSentMailboxPath, waitForSentMailboxPath } from '../sentFolder';

/** Minimal zustand-shaped store: getState + subscribe. */
function fakeStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set: (patch) => { state = { ...state, ...patch }; for (const fn of [...listeners]) fn(state); },
    listenerCount: () => listeners.size,
  };
}

const withMailboxes = (mailboxes, fetchedAt = null) => ({
  mailboxes,
  mailboxesFetchedAt: fetchedAt,
  getSentMailboxPath: () => findSentMailboxPath(mailboxes),
});

const INBOX_ONLY = [{ name: 'INBOX', path: 'INBOX', specialUse: null, children: [] }];
const FULL = [...INBOX_ONLY, { name: 'Sent', path: 'Sent', specialUse: '\\Sent', children: [] }];

describe('waitForSentMailboxPath', () => {
  it('resolves immediately when the path is already known', async () => {
    const store = fakeStore(withMailboxes(FULL));
    await expect(waitForSentMailboxPath(store)).resolves.toBe('Sent');
    expect(store.listenerCount()).toBe(0);
  });

  it('waits through the INBOX placeholder and resolves when the real list lands', async () => {
    const store = fakeStore(withMailboxes(INBOX_ONLY));
    const pending = waitForSentMailboxPath(store);
    store.set(withMailboxes(FULL, Date.now()));
    await expect(pending).resolves.toBe('Sent');
    expect(store.listenerCount()).toBe(0);
  });

  it('resolves null once the folder list arrives without a Sent folder', async () => {
    const store = fakeStore(withMailboxes(INBOX_ONLY));
    const pending = waitForSentMailboxPath(store);
    store.set(withMailboxes(INBOX_ONLY, Date.now()));
    await expect(pending).resolves.toBeNull();
  });

  it('does not wait when the folder list was already fetched and has no Sent', async () => {
    const store = fakeStore(withMailboxes(INBOX_ONLY, Date.now()));
    await expect(waitForSentMailboxPath(store)).resolves.toBeNull();
    expect(store.listenerCount()).toBe(0);
  });

  it('resolves null on timeout and unsubscribes', async () => {
    const store = fakeStore(withMailboxes(INBOX_ONLY));
    await expect(waitForSentMailboxPath(store, 5)).resolves.toBeNull();
    expect(store.listenerCount()).toBe(0);
  });
});
