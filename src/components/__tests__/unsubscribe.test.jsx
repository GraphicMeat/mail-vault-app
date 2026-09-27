// @vitest-environment jsdom

// The shared unsubscribe flow: the confirm dialog every surface opens
// (UnsubscribeHost), what it does with each daemon answer, and the
// Settings > Unsubscribe page's account scope.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ daemonCall: vi.fn(), openLink: vi.fn(), openMailtoCompose: vi.fn() }));
vi.mock('../../services/daemonClient', () => ({ daemonCall: (...args) => mocks.daemonCall(...args) }));
vi.mock('../../utils/editorLinks', () => ({ openLink: (...args) => mocks.openLink(...args) }));
vi.mock('../../utils/mailto', () => ({ openMailtoCompose: (...args) => mocks.openMailtoCompose(...args) }));
vi.mock('framer-motion', () => ({
  motion: { div: React.forwardRef((props, ref) => React.createElement('div', { ...props, ref })) },
  AnimatePresence: ({ children }) => children,
}));
const mailState = { accounts: [{ id: 'acc-a', email: 'a@example.test' }, { id: 'acc-b', email: 'b@example.test' }] };
function useMailStore(selector) { return selector(mailState); }
useMailStore.getState = () => mailState;
vi.mock('../../stores/mailStore', () => ({ useMailStore }));
// What a sender link drives, recorded in the order it happens.
const steps = [];
const searchState = {
  clearSearch: () => steps.push(['clearSearch']),
  setSearchQuery: query => steps.push(['setSearchQuery', query]),
  performSearch: async () => { steps.push(['performSearch']); },
};
vi.mock('../../stores/searchStore', () => ({ useSearchStore: { getState: () => searchState } }));
const viewState = { activeViewId: null, closeView: () => steps.push(['closeView']) };
vi.mock('../../stores/viewStore', () => ({ useViewStore: { getState: () => viewState } }));

const { useUnsubscribeStore, useUnsubscribeSendersStore, unsubscribeTarget } = await import('../../stores/unsubscribeStore');
const { UnsubscribeHost } = await import('../UnsubscribeHost');
const { UnsubscribeSettings } = await import('../settings/UnsubscribeSettings');

const MESSAGE = {
  _accountId: 'acc-a', from: { address: 'news@list.test', name: 'List News' },
  listUnsubscribe: '<https://list.test/u>', listUnsubscribePost: 'List-Unsubscribe=One-Click',
  authenticationResults: 'mx.test; dkim=pass',
};

beforeEach(() => {
  useUnsubscribeStore.setState({ pending: null, busy: false, result: null, version: 0 });
  useUnsubscribeSendersStore.getState().clear();
  mocks.daemonCall.mockReset();
  mocks.openLink.mockReset().mockResolvedValue(true);
  mocks.openMailtoCompose.mockReset().mockReturnValue(true);
});
afterEach(cleanup);

describe('unsubscribe confirm flow', () => {
  it('asks first, and Cancel sends nothing', async () => {
    render(<UnsubscribeHost />);
    useUnsubscribeStore.getState().request(unsubscribeTarget(MESSAGE));
    await screen.findByText('Unsubscribe from List News?');
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1));
    expect(useUnsubscribeStore.getState().pending).toBe(null);
    expect(mocks.daemonCall).not.toHaveBeenCalled();
  });

  it('confirming a one-click list lets the daemon do it and reports success', async () => {
    mocks.daemonCall.mockResolvedValue({ method: 'one-click', status: 'ok', url: null });
    render(<UnsubscribeHost />);
    useUnsubscribeStore.getState().request(unsubscribeTarget(MESSAGE));
    fireEvent.click(await screen.findByRole('button', { name: 'Unsubscribe' }));
    await screen.findByText('Unsubscribed from List News.');
    expect(mocks.daemonCall).toHaveBeenCalledWith('unsubscribe', {
      accountId: 'acc-a', sender: 'news@list.test', name: 'List News', listUnsubscribe: '<https://list.test/u>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click', authenticationResults: 'mx.test; dkim=pass',
    });
    expect(mocks.openLink).not.toHaveBeenCalled();
    expect(useUnsubscribeStore.getState().version).toBe(1);
  });

  it('opens the page for a browser answer and compose for a mailto answer', async () => {
    render(<UnsubscribeHost />);
    mocks.daemonCall.mockResolvedValueOnce({ method: 'browser', status: 'opened', url: 'https://list.test/u' });
    useUnsubscribeStore.getState().request(unsubscribeTarget(MESSAGE));
    fireEvent.click(await screen.findByRole('button', { name: 'Unsubscribe' }));
    await screen.findByText('Opened the unsubscribe page for List News.');
    expect(mocks.openLink).toHaveBeenCalledWith('https://list.test/u');

    mocks.daemonCall.mockResolvedValueOnce({ method: 'mailto', status: 'opened', url: 'mailto:leave@list.test?subject=stop' });
    useUnsubscribeStore.getState().request(unsubscribeTarget(MESSAGE));
    fireEvent.click(await screen.findByRole('button', { name: 'Unsubscribe' }));
    await screen.findByText('Opened an unsubscribe email to List News. Send it to finish.');
    expect(mocks.openMailtoCompose).toHaveBeenCalledWith('mailto:leave@list.test?subject=stop', 'acc-a');
  });

  it('a message without List-Unsubscribe has nothing to ask about', () => {
    expect(unsubscribeTarget({ from: { address: 'friend@x.test' } })).toBe(null);
  });
});

describe('Settings > Unsubscribe', () => {
  const sender = (account, lastAt = '2026-09-01T00:00:00Z') => ({
    address: `news@${account}.test`, name: `News ${account}`, accountId: account, mailbox: 'Promotions', count: 3,
    lastAt, method: 'one-click', listUnsubscribe: '<https://x.test/u>',
  });
  const pill = name => screen.getByRole('radio', { name: new RegExp(name) });
  const rows = () => [...document.querySelectorAll('[data-testid="unsubscribe-senders"] tr[data-sender]')]
    .map(row => row.getAttribute('data-sender'));
  const sendersCalls = account => mocks.daemonCall.mock.calls
    .filter(([method, params]) => method === 'unsubscribe.senders' && params.accountId === account).length;
  /** Each account's pair of calls answers when the test says so. */
  function deferredDaemon() {
    const waiting = {};
    mocks.daemonCall.mockImplementation((method, { accountId }) => new Promise((resolve, reject) => {
      (waiting[accountId] ||= []).push({ method, resolve, reject });
    }));
    return {
      answer: (accountId, senders, history = []) => waiting[accountId].splice(0).forEach(call =>
        call.resolve(call.method === 'unsubscribe.senders' ? senders : history)),
      fail: (accountId, error) => waiting[accountId].splice(0).forEach(call => call.reject(new Error(error))),
    };
  }
  const answerAll = () => mocks.daemonCall.mockImplementation(async (method, { accountId }) =>
    method === 'unsubscribe.history' ? [] : [sender(accountId, accountId === 'acc-a' ? '2026-09-05T00:00:00Z' : undefined)]);

  beforeEach(() => {
    steps.length = 0;
    viewState.activeViewId = null;
    Object.assign(mailState, {
      activeAccountId: 'acc-b', activeMailbox: 'INBOX', unifiedInbox: false, mailboxScope: null,
      activateAccount: async (accountId, mailbox) => { steps.push(['activateAccount', accountId, mailbox]); },
    });
  });

  it('asks once per account, in parallel, and fills each account as it answers', async () => {
    const daemon = deferredDaemon();
    render(<UnsubscribeSettings />);
    await waitFor(() => expect(mocks.daemonCall).toHaveBeenCalledTimes(4));
    for (const accountId of ['acc-a', 'acc-b']) {
      expect(mocks.daemonCall).toHaveBeenCalledWith('unsubscribe.senders', { accountId });
      expect(mocks.daemonCall).toHaveBeenCalledWith('unsubscribe.history', { accountId });
    }
    expect(mocks.daemonCall.mock.calls.some(([, params]) => params.accountId == null)).toBe(false);

    daemon.answer('acc-b', [sender('acc-b')]);
    await screen.findByText('News acc-b');
    expect(pill('a@example.test').getAttribute('aria-busy')).toBe('true');
    expect(pill('b@example.test').getAttribute('aria-busy')).toBe(null);

    daemon.answer('acc-a', [sender('acc-a', '2026-09-05T00:00:00Z')]);
    await screen.findByText('News acc-a');
    // Newest first across accounts.
    expect(rows()).toEqual(['news@acc-a.test', 'news@acc-b.test']);
    expect(pill('a@example.test').getAttribute('aria-busy')).toBe(null);
  });

  it('switches the scope from the pills without asking the daemon again', async () => {
    answerAll();
    render(<UnsubscribeSettings />);
    await screen.findByText('News acc-b');
    await screen.findByText('News acc-a');
    const asked = mocks.daemonCall.mock.calls.length;
    expect(screen.getAllByTestId('unsubscribe-row-account')).toHaveLength(2);

    fireEvent.click(pill('a@example.test'));
    expect(pill('a@example.test').getAttribute('aria-checked')).toBe('true');
    expect(rows()).toEqual(['news@acc-a.test']);
    // The account badge only helps when several accounts share the list.
    expect(screen.queryByTestId('unsubscribe-row-account')).toBeNull();

    fireEvent.keyDown(pill('a@example.test'), { key: 'ArrowRight' });
    expect(pill('b@example.test').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(pill('b@example.test'));
    expect(rows()).toEqual(['news@acc-b.test']);
    fireEvent.keyDown(pill('b@example.test'), { key: 'Home' });
    expect(rows()).toEqual(['news@acc-a.test', 'news@acc-b.test']);
    expect(mocks.daemonCall.mock.calls.length).toBe(asked);

    fireEvent.click(pill('a@example.test'));
    fireEvent.click(screen.getByTestId('unsubscribe-sender'));
    expect(useUnsubscribeStore.getState().pending).toMatchObject({ accountId: 'acc-a', sender: 'news@acc-a.test' });
  });

  it('keeps what it loaded when the page is left and opened again', async () => {
    answerAll();
    const { unmount } = render(<UnsubscribeSettings />);
    await screen.findByText('News acc-a');
    const asked = mocks.daemonCall.mock.calls.length;
    unmount();
    render(<UnsubscribeSettings />);
    expect(screen.getByText('News acc-a')).toBeTruthy();
    expect(screen.getByText('News acc-b')).toBeTruthy();
    expect(mocks.daemonCall.mock.calls.length).toBe(asked);
  });

  it('asks again for the account an unsubscribe changed, and only that one', async () => {
    answerAll();
    render(<UnsubscribeSettings />);
    await screen.findByText('News acc-a');
    await screen.findByText('News acc-b');
    expect([sendersCalls('acc-a'), sendersCalls('acc-b')]).toEqual([1, 1]);

    useUnsubscribeStore.getState().request(unsubscribeTarget(sender('acc-a'), 'acc-a'));
    const answer = mocks.daemonCall.getMockImplementation();
    mocks.daemonCall.mockImplementation(async (method, params) =>
      method === 'unsubscribe' ? { method: 'one-click', status: 'ok', url: null } : answer(method, params));
    await useUnsubscribeStore.getState().confirm();
    await waitFor(() => expect(sendersCalls('acc-a')).toBe(2));
    expect(sendersCalls('acc-b')).toBe(1);
    // The rows it had stay up while it asks.
    expect(screen.getByText('News acc-a')).toBeTruthy();
  });

  it('shows an account that failed on its pill and still lists the others', async () => {
    const daemon = deferredDaemon();
    render(<UnsubscribeSettings />);
    await waitFor(() => expect(mocks.daemonCall).toHaveBeenCalledTimes(4));
    daemon.fail('acc-a', 'vault offline');
    daemon.answer('acc-b', [sender('acc-b')]);
    await screen.findByText('News acc-b');
    expect(screen.getByRole('alert').textContent).toBe('Could not load the senders for a@example.test: vault offline');
    expect(pill('a@example.test').getAttribute('data-state')).toBe('error');
  });

  it('a sender opens its mail: Settings minimizes, its folder opens, searched to that sender', async () => {
    answerAll();
    const onMinimize = vi.fn(() => steps.push(['minimize']));
    viewState.activeViewId = 'view-1';
    render(<UnsubscribeSettings onMinimize={onMinimize} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show mail from News acc-a' }));
    await waitFor(() => expect(steps.at(-1)).toEqual(['performSearch']));
    expect(steps).toEqual([
      ['minimize'],
      ['closeView'],
      ['clearSearch'],
      ['activateAccount', 'acc-a', 'Promotions'],
      ['setSearchQuery', 'from:news@acc-a.test'],
      ['performSearch'],
    ]);
  });

  it('a folder that fails to open still leaves the sender searched', async () => {
    answerAll();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mailState.activateAccount = async () => { steps.push(['activateAccount']); throw new Error('offline'); };
    render(<UnsubscribeSettings onMinimize={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show mail from News acc-a' }));
    await waitFor(() => expect(steps.at(-1)).toEqual(['performSearch']));
    expect(steps).toContainEqual(['setSearchQuery', 'from:news@acc-a.test']);
  });

  it('a sender with no folder opens the inbox, and one already on screen is not reopened', async () => {
    mocks.daemonCall.mockImplementation(async (method, { accountId }) =>
      method === 'unsubscribe.senders' && accountId === 'acc-b' ? [{ ...sender('acc-b'), mailbox: null }] : []);
    Object.assign(mailState, { activeAccountId: 'acc-b', activeMailbox: 'INBOX' });
    render(<UnsubscribeSettings onMinimize={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show mail from News acc-b' }));
    await waitFor(() => expect(steps.at(-1)).toEqual(['performSearch']));
    expect(steps.some(([step]) => step === 'activateAccount')).toBe(false);
    expect(steps).toContainEqual(['setSearchQuery', 'from:news@acc-b.test']);
  });

  it('with nowhere to show mail (the detached window) the sender is plain text', async () => {
    answerAll();
    render(<UnsubscribeSettings />);
    await screen.findByText('News acc-a');
    expect(screen.queryByRole('button', { name: /Show mail from/ })).toBeNull();
  });

  it('says so when a scope has no subscription senders', async () => {
    mocks.daemonCall.mockResolvedValue([]);
    render(<UnsubscribeSettings />);
    await screen.findByTestId('unsubscribe-empty');
  });
});
