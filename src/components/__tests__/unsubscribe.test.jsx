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

const { useUnsubscribeStore, unsubscribeTarget } = await import('../../stores/unsubscribeStore');
const { UnsubscribeHost } = await import('../UnsubscribeHost');
const { UnsubscribeSettings } = await import('../settings/UnsubscribeSettings');

const MESSAGE = {
  _accountId: 'acc-a', from: { address: 'news@list.test', name: 'List News' },
  listUnsubscribe: '<https://list.test/u>', listUnsubscribePost: 'List-Unsubscribe=One-Click',
  authenticationResults: 'mx.test; dkim=pass',
};

beforeEach(() => {
  useUnsubscribeStore.setState({ pending: null, busy: false, result: null, version: 0 });
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
  const sender = account => ({
    address: `news@${account}.test`, name: `News ${account}`, accountId: account, count: 3,
    lastAt: '2026-09-01T00:00:00Z', method: 'one-click', listUnsubscribe: '<https://x.test/u>',
  });

  it('lists the scope the select names, all accounts first', async () => {
    mocks.daemonCall.mockImplementation(async (method, { accountId }) => {
      if (method === 'unsubscribe.history') return [];
      return accountId ? [sender(accountId)] : [sender('acc-a'), sender('acc-b')];
    });
    render(<UnsubscribeSettings />);
    await screen.findByText('News acc-b');
    expect(screen.getByText('News acc-a')).toBeTruthy();
    expect(mocks.daemonCall).toHaveBeenCalledWith('unsubscribe.senders', { accountId: null });

    fireEvent.change(screen.getByTestId('unsubscribe-scope'), { target: { value: 'acc-a' } });
    await waitFor(() => expect(screen.queryByText('News acc-b')).toBeNull());
    expect(screen.getByText('News acc-a')).toBeTruthy();
    expect(mocks.daemonCall).toHaveBeenCalledWith('unsubscribe.senders', { accountId: 'acc-a' });
    expect(mocks.daemonCall).toHaveBeenCalledWith('unsubscribe.history', { accountId: 'acc-a' });

    fireEvent.click(screen.getByTestId('unsubscribe-sender'));
    expect(useUnsubscribeStore.getState().pending).toMatchObject({ accountId: 'acc-a', sender: 'news@acc-a.test' });
  });

  it('says so when a scope has no subscription senders', async () => {
    mocks.daemonCall.mockResolvedValue([]);
    render(<UnsubscribeSettings />);
    await screen.findByTestId('unsubscribe-empty');
  });
});
