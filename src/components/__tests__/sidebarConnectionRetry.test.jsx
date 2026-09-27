// @vitest-environment jsdom
//
// Retry on the connection notice hides it for as long as the attempt runs.
// A failure brings it straight back (the 3s gate already passed: the status
// never left `error`); a success keeps it gone. jsdom never finishes a framer
// exit animation, so exits here finish at once; the double click the exit
// window allows is covered in SidebarNavigation.test.jsx with the real one.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from '../Sidebar';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { t } from '../../i18n';

vi.mock('framer-motion', async importOriginal => ({
  ...await importOriginal(),
  AnimatePresence: ({ children }) => children,
}));
vi.mock('../../services/db', async importOriginal => ({
  ...await importOriginal(),
  getVaultUidSets: async () => ({ saved: new Set(), archived: new Set() }),
  readLocalEmailIndex: async () => [],
}));

const realActivate = useMailStore.getState().activateAccount;
let settle;
const activateAccount = vi.fn(() => new Promise((resolve, reject) => { settle = { resolve, reject }; }));

beforeEach(() => {
  activateAccount.mockClear();
  useSettingsStore.setState({
    sidebarCollapsed: false, sidebarStyle: 'list', sidebarLayout: 'stacked', hiddenAccounts: {}, accountOrder: [],
    backupGlobalEnabled: false, billingProfile: null, transferHoverEnabled: false,
  });
  useMailStore.setState({
    accounts: [{ id: 'studio', name: 'Studio', email: 'studio@example.com', authType: 'password' }],
    activeAccountId: 'studio', activeMailbox: 'INBOX', unifiedInbox: false,
    mailboxes: [{ name: 'INBOX', path: 'INBOX' }], emails: [], localEmails: [],
    connectionStatus: 'error', connectionErrorType: 'serverError', connectionError: 'Connection failed',
    suspectEmptyServerData: null, activateAccount,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useMailStore.setState({ activateAccount: realActivate });
});

const details = () => screen.queryByRole('button', { name: t('sidebar.details') });

function clickRetry() {
  vi.useFakeTimers();
  render(<Sidebar />);
  act(() => vi.advanceTimersByTime(3000));
  fireEvent.click(screen.getByRole('button', { name: t('common.retry') }));
  expect(activateAccount).toHaveBeenCalledOnce();
}

describe('connection notice Retry', () => {
  it.each([
    ['an account folder', {}],
    ['All Inboxes', { unifiedInbox: true, activeMailbox: 'UNIFIED' }],
  ])('hides the notice while Retry runs in %s and brings it straight back on failure', async (_view, state) => {
    useMailStore.setState(state);
    clickRetry();
    expect(details()).toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(details()).toBeNull();
    await act(async () => settle.resolve());
    expect(details()).not.toBeNull();
  });

  it('asks the server again for the view on screen instead of repainting a saved copy', async () => {
    clickRetry();
    expect(activateAccount).toHaveBeenCalledWith('studio', 'INBOX', { _backgroundRefresh: true });
    await act(async () => settle.resolve());
  });

  it('brings the notice back when the retry throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clickRetry();
    await act(async () => settle.reject(new Error('boom')));
    expect(details()).not.toBeNull();
    warn.mockRestore();
  });

  it('keeps the notice gone once the retry connects', async () => {
    clickRetry();
    await act(async () => {
      useMailStore.setState({ connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
      settle.resolve();
    });
    expect(details()).toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(details()).toBeNull();
  });
});
