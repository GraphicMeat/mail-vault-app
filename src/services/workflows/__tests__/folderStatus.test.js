// Copy to src/services/workflows/__tests__/folderStatus.test.js after native GREEN.
// Native tests own selection, 50-path cap and throttle policy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  send: vi.fn(async method => method === 'get_app_data_dir' ? '/synthetic' : {}),
  legacyStatus: vi.fn(),
}));
vi.mock('../../transport', () => ({ send: (...args) => bridge.send(...args) }));
vi.mock('../../api', () => ({ fetchFolderStatus: (...args) => bridge.legacyStatus(...args) }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async () => true, mkdir: async () => {} }));
vi.mock('../../graphConfig', () => ({
  isGraphAccount: (account) => account?.oauth2Transport === 'graph',
  isPersonalMicrosoftEmail: () => false,
}));

let state = { accounts: [], folderStatus: {} };
const subscribers = new Set();
function setStore(patch) {
  const update = typeof patch === 'function' ? patch(state) : patch;
  if (Object.is(update, state)) return;
  const previous = state;
  state = { ...state, ...update };
  for (const subscriber of subscribers) subscriber(state, previous);
}
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => state,
    setState: setStore,
    subscribe: (subscriber) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  },
}));

const { refreshFolderStatus, invalidateFolderStatus } = await import('../folderStatus');
const A = { id: 'acct-a', email: 'a@mock.test' };
const B = { id: 'acct-b', email: 'b@mock.test' };
const tree = [
  { path: 'INBOX', children: [] },
  { path: 'Parent', noselect: true, children: [{ path: 'Parent/Child', children: [] }] },
  { path: 'Archive', children: [] },
];
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};
const waitForSend = count => vi.waitFor(() => expect(bridge.send).toHaveBeenCalledTimes(count));

beforeEach(() => {
  subscribers.clear();
  state = { accounts: [A, B], folderStatus: {} };
  bridge.send.mockReset();
  bridge.legacyStatus.mockReset();
  bridge.legacyStatus.mockImplementation(() => { throw new Error('legacy STATUS used'); });
});

afterEach(() => {
  expect(subscribers.size, 'each native STATUS request must release its temporary store observer').toBe(0);
});

describe('native closed-folder status adapter', () => {
  it('passes the full displayed tree and merges provider rows without local selection', async () => {
    bridge.send.mockResolvedValue({ rows: [
      { path: 'Parent/Child', messages: 2, unseen: 1, uidNext: 3, uidValidity: 9 },
      { path: 'Archive', messages: 5, unseen: 4, uidNext: 6, uidValidity: 9 },
    ] });
    const result = await refreshFolderStatus(A, tree, 'INBOX');
    expect(bridge.send).toHaveBeenCalledTimes(1);
    expect(bridge.send).toHaveBeenCalledWith('folders.status', {
      op: 'refresh', accountId: A.id, activeMailbox: 'INBOX', mailboxes: tree,
    });
    expect(result['Parent/Child'].uidNext).toBe(3);
    expect(state.folderStatus[A.id]['Parent/Child']).toEqual({
      path: 'Parent/Child', messages: 2, unseen: 1, uidNext: 3, uidValidity: 9,
    });
    expect(state.folderStatus[A.id].Archive.unseen).toBe(4);
    expect(bridge.legacyStatus).not.toHaveBeenCalled();
  });

  it('keeps prior sibling rows and other accounts when a native result is sparse or empty', async () => {
    state.folderStatus = {
      [A.id]: { Archive: { path: 'Archive', unseen: 4 }, Sent: { path: 'Sent', unseen: 2 } },
      [B.id]: { INBOX: { path: 'INBOX', unseen: 7 } },
    };
    bridge.send.mockResolvedValueOnce({ rows: [{ path: 'Archive', unseen: 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await refreshFolderStatus(A, tree, 'INBOX')).toEqual({ Archive: { path: 'Archive', unseen: 1 } });
    expect(state.folderStatus[A.id].Sent.unseen).toBe(2);
    expect(state.folderStatus[B.id].INBOX.unseen).toBe(7);
    expect(await refreshFolderStatus(A, tree, 'INBOX')).toEqual({});
    expect(state.folderStatus[A.id].Archive.unseen).toBe(1);
    expect(state.folderStatus[A.id].Sent.unseen).toBe(2);
  });

  it('skips absent and Graph accounts without store writes or native calls', async () => {
    expect(await refreshFolderStatus(null, tree, 'INBOX')).toBeNull();
    expect(await refreshFolderStatus({ ...A, oauth2Transport: 'graph' }, tree, 'INBOX')).toBeNull();
    expect(bridge.send).not.toHaveBeenCalled();
    expect(state.folderStatus).toEqual({});
  });

  it('keeps prior counts when native selection returns null', async () => {
    state.folderStatus = { [A.id]: { Archive: { path: 'Archive', unseen: 4 } } };
    bridge.send.mockResolvedValue(null);
    expect(await refreshFolderStatus(A, tree, 'INBOX')).toBeNull();
    expect(state.folderStatus[A.id].Archive.unseen).toBe(4);
  });

  it('passes an empty displayed scope to native selection when no tree is loaded', async () => {
    bridge.send.mockResolvedValue(null);
    expect(await refreshFolderStatus(A, null, null)).toBeNull();
    expect(bridge.send).toHaveBeenCalledExactlyOnceWith('folders.status', {
      op: 'refresh', accountId: A.id, activeMailbox: null, mailboxes: [],
    });
  });

  it('fences a held row when a newer invalidation settles', async () => {
    const held = deferred();
    const legacyHeld = deferred();
    state.folderStatus = { [B.id]: { INBOX: { path: 'INBOX', unseen: 7 } } };
    bridge.send.mockImplementation(async (_method, params) =>
      params.op === 'refresh' ? held.promise : { invalidated: true });
    bridge.legacyStatus.mockReturnValue(legacyHeld.promise);
    const stale = refreshFolderStatus(A, tree, 'INBOX');
    await waitForSend(1);
    await invalidateFolderStatus(A.id);
    held.resolve({ rows: [{ path: 'Archive', unseen: 99 }] });
    legacyHeld.resolve([{ path: 'Archive', unseen: 99 }]);
    await stale;
    expect(state.folderStatus[A.id], 'stale folder result published after invalidation')
      .toBeUndefined();
    expect(state.folderStatus[B.id].INBOX.unseen).toBe(7);
    expect(bridge.send.mock.calls.map(([, params]) => params.op))
      .toEqual(['refresh', 'invalidate']);
  });

  it('does not repopulate an account removed during a held reply', async () => {
    const held = deferred();
    bridge.send.mockReturnValue(held.promise);
    const stale = refreshFolderStatus(A, tree, 'INBOX');
    await waitForSend(1);
    setStore({ accounts: [B] });
    held.resolve({ rows: [{ path: 'Archive', unseen: 99 }] });
    await stale;
    expect(state.folderStatus[A.id]).toBeUndefined();
  });

  it('keeps the old reply fenced when native invalidation fails', async () => {
    const held = deferred();
    bridge.send.mockImplementation((_method, params) => params.op === 'refresh'
      ? held.promise : Promise.reject(new Error('errors.daemonUnavailable')));
    const stale = refreshFolderStatus(A, tree, 'INBOX');
    await waitForSend(1);
    await invalidateFolderStatus(A.id);
    held.resolve({ rows: [{ path: 'Archive', unseen: 99 }] });
    await stale;
    expect(state.folderStatus[A.id]).toBeUndefined();
  });

  it('publishes only the newer refresh generation', async () => {
    const first = deferred();
    const second = deferred();
    let issued = 0;
    bridge.send.mockImplementation((_method, params) => {
      if (params.op !== 'refresh') throw new Error('unexpected operation');
      issued += 1;
      return issued === 1 ? first.promise : second.promise;
    });
    const older = refreshFolderStatus(A, tree, 'INBOX');
    await waitForSend(1);
    const newer = refreshFolderStatus(A, tree, 'INBOX');
    await waitForSend(2);
    second.resolve({ rows: [{ path: 'Archive', unseen: 2 }] });
    await newer;
    first.resolve({ rows: [{ path: 'Archive', unseen: 99 }] });
    await older;
    expect(state.folderStatus[A.id].Archive.unseen).toBe(2);
    expect(bridge.send).toHaveBeenCalledTimes(2);
  });

  it('lets an earlier real sweep publish when a later native call is throttled', async () => {
    const held = deferred();
    bridge.send.mockReturnValueOnce(held.promise).mockResolvedValueOnce(null);
    const first = refreshFolderStatus(A, tree, 'INBOX');
    await waitForSend(1);
    expect(await refreshFolderStatus(A, tree, 'INBOX')).toBeNull();
    held.resolve({ rows: [{ path: 'Archive', unseen: 3 }] });
    await first;
    expect(state.folderStatus[A.id].Archive.unseen).toBe(3);
  });

  it('publishes real rows after keychain hydration replaces the account during a throttled sweep', async () => {
    const account = { ...A, imapHost: 'imap.mock.test', imapPort: 993, imapSecurity: 'ssl' };
    state.accounts = [account, B];
    const held = deferred();
    bridge.send.mockReturnValueOnce(held.promise).mockResolvedValueOnce(null);

    const first = refreshFolderStatus(account, tree, 'INBOX');
    await waitForSend(1);
    state.folderStatus = {
      [account.id]: { Sent: { path: 'Sent', unseen: 2 } },
      [B.id]: { INBOX: { path: 'INBOX', unseen: 7 } },
    };
    const hydrated = { ...account, password: 'hydrated-credential', name: 'Updated display name',
      oauth2AccessToken: 'renewed-token', oauth2ExpiresAt: 12345 };
    setStore({ accounts: [hydrated, B] });
    const renamed = { ...hydrated, name: 'Later display name' };
    setStore({ accounts: [renamed, B] });
    expect(await refreshFolderStatus(renamed, tree, 'INBOX')).toBeNull();
    held.resolve({ rows: [{ path: 'Archive', unseen: 3 }] });

    expect(await first, 'same-source hydration must not discard real STATUS rows after a throttle')
      .toEqual({ Archive: { path: 'Archive', unseen: 3 } });
    expect(state.folderStatus[account.id]?.Archive?.unseen).toBe(3);
    expect(state.folderStatus[account.id].Sent.unseen).toBe(2);
    expect(state.folderStatus[B.id].INBOX.unseen).toBe(7);
    expect(bridge.send).toHaveBeenCalledTimes(2);
    expect(bridge.legacyStatus).not.toHaveBeenCalled();
  });

  it('fences a held native row after the same account id moves to another IMAP source', async () => {
    const account = { ...A, imapHost: 'old.mock.test', imapPort: 993, imapSecurity: 'ssl' };
    state.accounts = [account, B];
    const held = deferred();
    bridge.send.mockReturnValue(held.promise);

    const stale = refreshFolderStatus(account, tree, 'INBOX');
    await waitForSend(1);
    setStore({ accounts: [{ ...account, imapHost: 'new.mock.test' }, B] });
    held.resolve({ rows: [{ path: 'Archive', unseen: 99 }] });

    expect(await stale).toBeNull();
    expect(state.folderStatus[account.id], 'old server STATUS must not publish after source replacement')
      .toBeUndefined();
  });

  it.each([
    ['IMAP port', { ...A, imapHost: 'mail.mock.test', imapPort: 993 }, { imapPort: 143 }],
    ['IMAP security', { ...A, imapHost: 'mail.mock.test', imapSecurity: 'ssl' }, { imapSecurity: 'starttls' }],
    ['JMAP session', { ...A, imapHost: 'api.mock.test', jmapSessionUrl: 'https://api.mock.test/one' },
      { jmapSessionUrl: 'https://api.mock.test/two' }],
    ['JMAP login', { ...A, imapHost: 'api.mock.test', jmapUsername: 'old@mock.test' },
      { jmapUsername: 'new@mock.test' }],
    ['OAuth transport', { ...A, authType: 'oauth2', oauth2Transport: 'imap' },
      { oauth2Transport: 'graph' }],
  ])('fences a held row after a %s source change', async (_label, account, patch) => {
    state.accounts = [account, B];
    const held = deferred();
    bridge.send.mockReturnValue(held.promise);
    const stale = refreshFolderStatus(account, tree, 'INBOX');
    await waitForSend(1);
    setStore({ accounts: [{ ...account, ...patch }, B] });
    held.resolve({ rows: [{ path: 'Archive', unseen: 99 }] });
    expect(await stale).toBeNull();
    expect(state.folderStatus[account.id]).toBeUndefined();
  });

  it('fences an in-place source mutation using the original context values', async () => {
    const account = { ...A, imapHost: 'mail.mock.test', imapPort: 993 };
    state.accounts = [account, B];
    const held = deferred();
    bridge.send.mockReturnValue(held.promise);
    const stale = refreshFolderStatus(account, tree, 'INBOX');
    await waitForSend(1);
    account.imapPort = 143;
    setStore({ accounts: [account, B] });
    held.resolve({ rows: [{ path: 'Archive', unseen: 99 }] });
    expect(await stale, 'in-place server edits must not mutate the captured source context').toBeNull();
    expect(state.folderStatus[account.id]).toBeUndefined();
  });

  it('distinguishes an absent source field from explicit null', async () => {
    const account = { ...A, imapHost: 'mail.mock.test' };
    state.accounts = [account, B];
    const held = deferred();
    bridge.send.mockReturnValue(held.promise);
    const stale = refreshFolderStatus(account, tree, 'INBOX');
    await waitForSend(1);
    setStore({ accounts: [{ ...account, oauth2ClientId: null }, B] });
    held.resolve({ rows: [{ path: 'Archive', unseen: 99 }] });
    expect(await stale).toBeNull();
    expect(state.folderStatus[account.id]).toBeUndefined();
  });

  it('keeps a held reply fenced when its id is removed and re-added before the reply', async () => {
    const held = deferred();
    bridge.send.mockReturnValue(held.promise);
    const stale = refreshFolderStatus(A, tree, 'INBOX');
    await waitForSend(1);
    setStore({ accounts: [B] });
    setStore({ accounts: [{ ...A }, B] });
    held.resolve({ rows: [{ path: 'Archive', unseen: 99 }] });
    expect(await stale, 'remove and re-add must not revive an old STATUS reply').toBeNull();
    expect(state.folderStatus[A.id]).toBeUndefined();
  });

  it('keeps a held reply fenced when its source changes and changes back', async () => {
    const account = { ...A, imapHost: 'old.mock.test' };
    state.accounts = [account, B];
    const held = deferred();
    bridge.send.mockReturnValue(held.promise);
    const stale = refreshFolderStatus(account, tree, 'INBOX');
    await waitForSend(1);
    setStore({ accounts: [{ ...account, imapHost: 'new.mock.test' }, B] });
    setStore({ accounts: [{ ...account }, B] });
    held.resolve({ rows: [{ path: 'Archive', unseen: 99 }] });
    expect(await stale, 'restoring the original source must not revive an old STATUS reply').toBeNull();
    expect(state.folderStatus[account.id]).toBeUndefined();
  });

  it('does not fence account A when only account B disappears', async () => {
    const held = deferred();
    bridge.send.mockReturnValue(held.promise);
    const current = refreshFolderStatus(A, tree, 'INBOX');
    await waitForSend(1);
    setStore({ accounts: [A] });
    held.resolve({ rows: [{ path: 'Archive', unseen: 3 }] });
    expect(await current).toEqual({ Archive: { path: 'Archive', unseen: 3 } });
    expect(state.folderStatus[A.id].Archive.unseen).toBe(3);
  });

  it('releases the temporary observer after a malformed native answer', async () => {
    bridge.send.mockResolvedValue({ rows: 'invalid' });
    await expect(refreshFolderStatus(A, tree, 'INBOX')).rejects.toThrow('errors.connectionFailed');
    expect(state.folderStatus).toEqual({});
  });

  it('never calls old STATUS after a native transport error', async () => {
    bridge.send.mockRejectedValue(new Error('errors.daemonUnavailable'));
    await expect(refreshFolderStatus(A, tree, 'INBOX')).rejects.toThrow();
    expect(state.folderStatus).toEqual({});
    expect(bridge.legacyStatus).not.toHaveBeenCalled();
  });

  it('bounds a native folder refresh that never replies', async () => {
    vi.useFakeTimers();
    try {
      const started = deferred();
      bridge.send.mockImplementation(() => {
        started.resolve();
        return new Promise(() => {});
      });
      const error = refreshFolderStatus(A, tree, 'INBOX').then(() => null, caught => caught);
      await started.promise;
      await vi.advanceTimersByTimeAsync(126_000);
      expect((await error)?.message).toBe('errors.connectionFailed');
      expect(state.folderStatus).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});
