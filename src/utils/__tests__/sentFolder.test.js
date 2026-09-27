import { describe, it, expect } from 'vitest';
import { findSentMailboxPath, waitForSentMailboxPath, isOutgoingMailboxName, isOutgoingRow, mergesSentIntoThreads, sentMailboxPathFor } from '../sentFolder';

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

describe('isOutgoingMailboxName', () => {
  // Name-based on purpose: a unified view mixes accounts whose Sent paths
  // differ, so the active account's resolved path cannot answer for them.
  it.each(['Sent', 'Sent Items', '[Gmail]/Sent Mail', 'INBOX.Sent', 'Gesendet', '已发送'])(
    'calls %s outgoing', (path) => expect(isOutgoingMailboxName(path)).toBe(true));

  // `Sentinel` is the one a startsWith/includes check gets wrong.
  it.each(['INBOX', 'Archive', 'Sentinel', 'INBOX/Sent drafts', 'UNIFIED', '', null, undefined])(
    'leaves %s alone', (path) => expect(isOutgoingMailboxName(path)).toBe(false));
});

describe('isOutgoingRow', () => {
  const state = (activeMailbox) => ({ activeMailbox });

  it('takes the merge flag the INBOX+Sent merge stamps', () => {
    expect(isOutgoingRow({ _fromSentFolder: true, _mailbox: 'INBOX' }, state('INBOX'))).toBe(true);
  });

  it('takes the row\'s own mailbox when it carries one', () => {
    expect(isOutgoingRow({ _mailbox: '[Gmail]/Sent Mail' }, state('UNIFIED'))).toBe(true);
    expect(isOutgoingRow({ _mailbox: 'INBOX' }, state('Sent'))).toBe(false);
  });

  it('falls back to the view when the row was never stamped', () => {
    expect(isOutgoingRow({}, state('Sent'))).toBe(true);
    expect(isOutgoingRow({}, state('INBOX'))).toBe(false);
    expect(isOutgoingRow({}, undefined)).toBe(false);
    expect(isOutgoingRow(null, state('Sent'))).toBe(false);
  });
});

// Which lists thread your Sent mail in with what you received. All inboxes is
// the INBOX of every account, so it does; its Sent and Drafts folders are the
// outgoing mail itself, and merging Sent into them would double every message.
describe('mergesSentIntoThreads', () => {
  it('merges in an account\'s INBOX', () => {
    expect(mergesSentIntoThreads({ activeMailbox: 'INBOX' })).toBe(true);
  });

  it('merges in All inboxes showing INBOX', () => {
    expect(mergesSentIntoThreads({ activeMailbox: 'UNIFIED', unifiedFolder: 'INBOX' })).toBe(true);
    // The unified view starts on INBOX before the folder is written.
    expect(mergesSentIntoThreads({ activeMailbox: 'UNIFIED', unifiedFolder: null })).toBe(true);
  });

  it('does not merge in the unified Sent or Drafts view', () => {
    expect(mergesSentIntoThreads({ activeMailbox: 'UNIFIED', unifiedFolder: 'Sent' })).toBe(false);
    expect(mergesSentIntoThreads({ activeMailbox: 'UNIFIED', unifiedFolder: 'Drafts' })).toBe(false);
  });

  it('does not merge in any other folder', () => {
    expect(mergesSentIntoThreads({ activeMailbox: 'Sent' })).toBe(false);
    expect(mergesSentIntoThreads({ activeMailbox: 'Archive', unifiedFolder: 'INBOX' })).toBe(false);
    expect(mergesSentIntoThreads(null)).toBe(false);
  });
});

// One `getSentMailboxPath()` answered for the active account only, and every
// other account's Sent was read at THAT path: a Gmail account beside a Dovecot
// one looked for `[Gmail]/Sent Mail` on a server that calls it `INBOX.Sent`.
describe('sentMailboxPathFor', () => {
  const gmail = [{ name: 'INBOX', path: 'INBOX' }, { name: 'Sent Mail', path: '[Gmail]/Sent Mail', specialUse: '\\Sent' }];
  const dovecot = [{ name: 'INBOX', path: 'INBOX', children: [{ name: 'Sent', path: 'INBOX.Sent', specialUse: '\\Sent' }] }];
  const state = {
    activeAccountId: 'a',
    mailboxes: gmail,
    accounts: [{ id: 'a' }, { id: 'b' }, { id: 'c', sentFolderOverride: 'INBOX.Outgoing' }],
  };

  it('answers the active account from the live folder list', () => {
    expect(sentMailboxPathFor(state, 'a', dovecot)).toBe('[Gmail]/Sent Mail');
  });

  it('answers another account from ITS cached folder list, not the active one\'s', () => {
    expect(sentMailboxPathFor(state, 'b', dovecot)).toBe('INBOX.Sent');
  });

  it('honours that account\'s own override', () => {
    const boxes = [...dovecot, { name: 'Outgoing', path: 'INBOX.Outgoing' }];
    expect(sentMailboxPathFor(state, 'c', boxes)).toBe('INBOX.Outgoing');
  });

  it('knows nothing for an account with no cached folder list', () => {
    expect(sentMailboxPathFor(state, 'b', null)).toBeNull();
  });
});
