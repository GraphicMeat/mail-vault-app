import { describe, it, expect, vi } from 'vitest';
import { startNotificationOpenBridge, openNotificationTarget } from '../notificationOpen';

// The rule this file protects: clicking a new-mail banner opens the message it
// showed, in the folder it arrived in, including the click that launched the
// app (queued in Rust before the webview existed).

function fakeListen() {
  const handlers = {};
  const listen = vi.fn(async (name, cb) => {
    handlers[name] = cb;
    return () => { delete handlers[name]; };
  });
  return { listen, fire: name => handlers[name]?.() };
}

describe('startNotificationOpenBridge', () => {
  it('opens a click queued before the bridge started', async () => {
    const { listen } = fakeListen();
    const target = { accountId: 'a1', mailbox: 'INBOX', uid: 7 };
    const invoke = vi.fn().mockResolvedValueOnce(target);
    const open = vi.fn();

    await startNotificationOpenBridge({ invoke, listen, open }).ready;

    expect(invoke).toHaveBeenCalledWith('take_notification_open');
    expect(open).toHaveBeenCalledWith(target);
  });

  it('drains again on the wake-up and ignores an empty queue', async () => {
    const { listen, fire } = fakeListen();
    const target = { accountId: 'a2', mailbox: 'Work', uid: 3 };
    const invoke = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(target);
    const open = vi.fn();

    await startNotificationOpenBridge({ invoke, listen, open }).ready;
    expect(open).not.toHaveBeenCalled();

    await fire('notification-open');
    expect(open).toHaveBeenCalledWith(target);
  });

  it('stops listening once stopped', async () => {
    const { listen, fire } = fakeListen();
    const invoke = vi.fn().mockResolvedValue({ accountId: 'a1', mailbox: 'INBOX', uid: 1 });
    const open = vi.fn();

    const bridge = startNotificationOpenBridge({ invoke, listen, open });
    await bridge.ready;
    open.mockClear();
    bridge.stop();
    await fire('notification-open');

    expect(open).not.toHaveBeenCalled();
  });
});

describe('openNotificationTarget', () => {
  const store = (patch) => {
    let state;
    const activateAccount = vi.fn(async (accountId, mailbox) => {
      state = { ...state, activeAccountId: accountId, activeMailbox: mailbox, unifiedInbox: false, mailboxScope: null };
    });
    const selectEmail = vi.fn();
    state = {
      accounts: [{ id: 'a1' }, { id: 'a2' }],
      activeAccountId: 'a1', activeMailbox: 'INBOX', unifiedInbox: false, mailboxScope: null,
      activateAccount, selectEmail, ...patch,
    };
    return { getState: () => state, activateAccount, selectEmail };
  };

  it('switches to the account and folder the mail arrived in, then opens it', async () => {
    const s = store();
    await openNotificationTarget({ accountId: 'a2', mailbox: 'Work', uid: 9 }, s.getState);

    expect(s.activateAccount).toHaveBeenCalledWith('a2', 'Work');
    expect(s.selectEmail).toHaveBeenCalledWith(9);
    expect(s.activateAccount.mock.invocationCallOrder[0]).toBeLessThan(s.selectEmail.mock.invocationCallOrder[0]);
  });

  it('does not reload the folder already on screen', async () => {
    const s = store();
    await openNotificationTarget({ accountId: 'a1', mailbox: 'INBOX', uid: 4 }, s.getState);

    expect(s.activateAccount).not.toHaveBeenCalled();
    expect(s.selectEmail).toHaveBeenCalledWith(4);
  });

  it('leaves All Inboxes for the account folder', async () => {
    const s = store({ unifiedInbox: true, activeMailbox: 'UNIFIED' });
    await openNotificationTarget({ accountId: 'a1', mailbox: 'INBOX', uid: 4 }, s.getState);

    expect(s.activateAccount).toHaveBeenCalledWith('a1', 'INBOX');
    expect(s.selectEmail).toHaveBeenCalledWith(4);
  });

  it('opens only the folder when the banner named no message', async () => {
    const s = store();
    await openNotificationTarget({ accountId: 'a2', mailbox: 'INBOX' }, s.getState);

    expect(s.activateAccount).toHaveBeenCalledWith('a2', 'INBOX');
    expect(s.selectEmail).not.toHaveBeenCalled();
  });

  it('opens nothing for an account removed since the banner fired', async () => {
    const s = store();
    await openNotificationTarget({ accountId: 'gone', mailbox: 'INBOX', uid: 1 }, s.getState);

    expect(s.activateAccount).not.toHaveBeenCalled();
    expect(s.selectEmail).not.toHaveBeenCalled();
  });
});
