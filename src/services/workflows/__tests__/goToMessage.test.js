import { describe, it, expect, vi, beforeEach } from 'vitest';

// "Go to mailbox" on a search hit or an All inboxes row: leave the search,
// show the message's own account and folder, and open it (its whole
// conversation when threads are on, anchored on the message itself).
const h = vi.hoisted(() => {
  const fake = (initial) => {
    let state = initial;
    const listeners = new Set();
    return {
      getState: () => state,
      setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; listeners.forEach(l => l()); },
      subscribe: l => { listeners.add(l); return () => listeners.delete(l); },
    };
  };
  return { fake, mail: null, settings: null, search: null, view: null };
});
vi.mock('../../../stores/mailStore', () => ({ useMailStore: { getState: () => h.mail.getState(), subscribe: l => h.mail.subscribe(l) } }));
vi.mock('../../../stores/settingsStore', () => ({ useSettingsStore: { getState: () => h.settings } }));
vi.mock('../../../stores/searchStore', () => ({ useSearchStore: { getState: () => h.search } }));
vi.mock('../../../stores/viewStore', () => ({ useViewStore: { getState: () => h.view } }));

const { goToMessage } = await import('../goToMessage.js');

const row = (uid, extra = {}) => ({
  uid, _mailbox: 'INBOX', source: 'server', subject: 'Plan', date: `2026-09-0${uid}T10:00:00Z`,
  messageId: `<m${uid}@x>`, ...extra,
});
// uid 1 and 2 answer each other; 5 stands alone.
const listed = [row(1), row(2, { inReplyTo: '<m1@x>', references: ['<m1@x>'] }), row(5, { subject: 'Alone' })];
// A search hit as the daemon stamps it: account id and folder, no list context.
const hit = (uid = 1) => ({ ...row(uid), _accountId: 'a2', source: 'server-search' });

beforeEach(() => {
  h.settings = { threadMode: 'expandable' };
  h.search = { clearSearch: vi.fn() };
  h.view = { activeViewId: null, closeView: vi.fn() };
  h.mail = h.fake({
    accounts: [{ id: 'a1' }, { id: 'a2' }],
    activeAccountId: 'a1', activeMailbox: 'UNIFIED', unifiedInbox: true, mailboxScope: null,
    sortedEmails: [], getChatEmails() { return this.sortedEmails; },
    activateAccount: vi.fn(async (accountId, mailbox) => {
      h.mail.setState({ activeAccountId: accountId, activeMailbox: mailbox, unifiedInbox: false });
      // The folder's list arrives after the switch, as the real load does.
      setTimeout(() => h.mail.setState({ sortedEmails: listed }), 0);
    }),
    selectThread: vi.fn(),
    selectEmail: vi.fn(async () => {}),
  });
});

describe('goToMessage', () => {
  it("leaves the search, opens the hit's own folder and its thread anchored on the hit", async () => {
    expect(await goToMessage(hit(2))).toBe(true);
    const s = h.mail.getState();
    expect(h.search.clearSearch).toHaveBeenCalledOnce();
    expect(s.activateAccount).toHaveBeenCalledWith('a2', 'INBOX');
    expect(s.activateAccount.mock.invocationCallOrder[0]).toBeGreaterThan(h.search.clearSearch.mock.invocationCallOrder[0]);
    expect(s.selectThread).toHaveBeenCalledOnce();
    const [thread, focusKey] = s.selectThread.mock.calls[0];
    expect(thread.emails.map(e => e.uid).sort()).toEqual([1, 2]);
    // The key ThreadView names its messages by: the hit, not the newest or oldest.
    expect(focusKey).toBe('|INBOX|2');
    expect(s.selectEmail).not.toHaveBeenCalled();
  });

  it('anchors on the first message when the hit is the first, not the newest', async () => {
    await goToMessage(hit(1));
    expect(h.mail.getState().selectThread.mock.calls[0][1]).toBe('|INBOX|1');
  });

  it('closes a saved view that is on screen', async () => {
    h.view.activeViewId = 'v1';
    await goToMessage(hit(1));
    expect(h.view.closeView).toHaveBeenCalledOnce();
  });

  it('opens the message alone when threads are off', async () => {
    h.settings.threadMode = 'flat';
    await goToMessage(hit(2));
    const s = h.mail.getState();
    expect(s.selectThread).not.toHaveBeenCalled();
    expect(s.selectEmail).toHaveBeenCalledWith(2, 'server-search', 'INBOX');
  });

  it('opens a message with no conversation as itself', async () => {
    await goToMessage(hit(5));
    const s = h.mail.getState();
    expect(s.selectThread).not.toHaveBeenCalled();
    expect(s.selectEmail).toHaveBeenCalledWith(5, 'server-search', 'INBOX');
  });

  it('does not keep the reader waiting on a message the list never shows', async () => {
    h.mail.getState().activateAccount.mockImplementation(async (accountId, mailbox) => {
      h.mail.setState({ activeAccountId: accountId, activeMailbox: mailbox, unifiedInbox: false });
    });
    await goToMessage(hit(1), { threadWaitMs: 20 });
    expect(h.mail.getState().selectEmail).toHaveBeenCalledWith(1, 'server-search', 'INBOX');
  });

  it('does not reload the folder already on screen', async () => {
    h.mail.setState({ activeAccountId: 'a2', activeMailbox: 'INBOX', unifiedInbox: false, sortedEmails: listed });
    await goToMessage(hit(2));
    const s = h.mail.getState();
    expect(s.activateAccount).not.toHaveBeenCalled();
    expect(s.selectThread).toHaveBeenCalledOnce();
  });

  it('leaves the reader alone when the user navigated elsewhere meanwhile', async () => {
    h.mail.getState().activateAccount.mockImplementation(async () => {
      h.mail.setState({ activeAccountId: 'a1', activeMailbox: 'Work', unifiedInbox: false });
    });
    expect(await goToMessage(hit(2))).toBe(false);
    expect(h.mail.getState().selectThread).not.toHaveBeenCalled();
    expect(h.mail.getState().selectEmail).not.toHaveBeenCalled();
  });

  it('does nothing for an account that is gone or a row with no folder', async () => {
    expect(await goToMessage({ ...hit(1), _accountId: 'gone' })).toBe(false);
    expect(await goToMessage({ uid: 1, _accountId: 'a2' })).toBe(false);
    expect(h.search.clearSearch).not.toHaveBeenCalled();
    expect(h.mail.getState().activateAccount).not.toHaveBeenCalled();
  });
});
