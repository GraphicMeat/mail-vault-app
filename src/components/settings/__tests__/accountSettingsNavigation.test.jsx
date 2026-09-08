// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AccountSettings } from '../AccountSettings';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';

// These account preferences remain real; only disk/network reads are isolated.
vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));

const accounts = [
  { id: 'studio', name: 'Studio', email: 'studio@example.test', password: 'saved-password', imapHost: 'imap.example.test' },
  { id: 'personal', name: 'Personal', email: 'personal@example.test', authType: 'oauth2', oauth2Provider: 'google', oauth2ExpiresAt: 1 },
];
const tab = key => screen.getByRole('tab', { name: t(`settings.accounts.section${key}`) });

beforeEach(() => {
  useSettingsStore.setState({ signatures: {}, displayNames: {}, sendAsAddresses: {}, accountColors: {}, accountOrder: [], hiddenAccounts: {} });
  useMailStore.setState({ accounts, activeAccountId: 'studio', activeMailbox: 'INBOX', mailboxes: [], connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('keeps identity visible while revealing only the chosen category', () => {
  render(<AccountSettings accounts={accounts} />);
  expect(screen.getByRole('heading', { name: 'Studio' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: t('settings.accounts.displayName') })).toBeTruthy();
  expect(screen.queryByRole('button', { name: t('settings.accounts.changeServer') })).toBeNull();
  fireEvent.click(tab('Connection'));
  expect(screen.getByRole('heading', { name: 'Studio' })).toBeTruthy();
  expect(screen.getByRole('button', { name: t('settings.accounts.changeServer') })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: t('settings.accounts.displayName') })).toBeNull();
  expect(screen.queryByRole('button', { name: t('settings.accounts.removeAccount2') })).toBeNull();
  fireEvent.click(tab('Advanced'));
  expect(screen.getByRole('button', { name: t('settings.accounts.removeAccount2') })).toBeTruthy();
  expect(screen.getByRole('heading', { name: t('settings.accounts.accountOrder') })).toBeTruthy();
});

it('opens the requested section and honors a new search destination', () => {
  const { rerender } = render(<AccountSettings accounts={accounts} initialSection="connection" />);
  expect(tab('Connection').getAttribute('aria-selected')).toBe('true');
  rerender(<AccountSettings accounts={accounts} initialSection="advanced" />);
  expect(tab('Advanced').getAttribute('aria-selected')).toBe('true');
});

it('returns to a searched category repeatedly after manual navigation and password recovery', () => {
  function SettingsSearchHost() {
    const [destination, setDestination] = React.useState('profile');
    return <>
      <button onClick={() => setDestination('profile')}>Find signature</button>
      <AccountSettings accounts={accounts} initialSection={destination} onSectionChange={setDestination} />
    </>;
  }
  render(<SettingsSearchHost />);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    fireEvent.click(tab('Advanced'));
    expect(tab('Advanced').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Find signature' }));
    expect(tab('Profile').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('textbox', { name: t('settings.accounts.displayName') })).toBeTruthy();
  }
  act(() => useMailStore.setState({ connectionStatus: 'error', connectionErrorType: 'passwordMissing' }));
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.enterPassword') }));
  expect(tab('Connection').getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Find signature' }));
  expect(tab('Profile').getAttribute('aria-selected')).toBe('true');
});

it('retains pending identity edits across section and account changes', async () => {
  vi.useFakeTimers();
  const { unmount } = render(<AccountSettings accounts={accounts} />);
  fireEvent.change(screen.getByRole('textbox', { name: t('settings.accounts.displayName') }), { target: { value: 'Studio Team' } });
  fireEvent.click(tab('Connection'));
  fireEvent.click(tab('Profile'));
  expect(screen.getByRole('textbox', { name: t('settings.accounts.displayName') }).value).toBe('Studio Team');
  fireEvent.click(screen.getByRole('button', { name: /Personal personal@example.test/ }));
  expect(useSettingsStore.getState().getDisplayName('studio')).toBe('Studio Team');
  fireEvent.change(screen.getByRole('textbox', { name: t('settings.accounts.displayName') }), { target: { value: 'My Personal Mail' } });
  unmount();
  expect(useSettingsStore.getState().getDisplayName('personal')).toBe('My Personal Mail');
  await act(async () => {});
});

it('provides password recovery for the affected active account without exposing details first', () => {
  useMailStore.setState({ connectionStatus: 'error', connectionErrorType: 'passwordMissing', connectionError: 'Authentication failed on imap.example.test' });
  render(<AccountSettings accounts={accounts} />);
  const status = screen.getByRole('status');
  expect(within(status).getByText(t('settings.accounts.passwordRequired'))).toBeTruthy();
  fireEvent.click(within(status).getByRole('button', { name: t('settings.accounts.enterPassword') }));
  expect(tab('Connection').getAttribute('aria-selected')).toBe('true');
  expect(screen.getByLabelText(t('settings.accounts.newPassword'))).toBeTruthy();
  const details = screen.getByText('Authentication failed on imap.example.test').closest('details');
  expect(details.open).toBe(false);
});

it.each(['connection', 'recovery'])('focuses the password input when opened from %s', entry => {
  if (entry === 'recovery') {
    useMailStore.setState({ connectionStatus: 'error', connectionErrorType: 'passwordMissing' });
  }
  render(<AccountSettings accounts={accounts} initialSection={entry === 'connection' ? 'connection' : 'profile'} />);
  fireEvent.click(screen.getByRole('button', {
    name: t(entry === 'recovery' ? 'settings.accounts.enterPassword' : 'settings.accounts.update'),
    exact: true,
  }));
  expect(document.activeElement).toBe(screen.getByLabelText(t('settings.accounts.newPassword')));
});

it('does not label a different account broken, or OAuth access-token expiry disconnected', () => {
  useMailStore.setState({ connectionStatus: 'error', connectionErrorType: 'passwordMissing', connectionError: 'Authentication failed' });
  render(<AccountSettings accounts={accounts} initialAccountId="personal" initialSection="connection" />);
  expect(screen.queryByText(t('settings.accounts.passwordRequired'))).toBeNull();
  expect(screen.queryByText(t('settings.accounts.tokenExpired'))).toBeNull();
  expect(within(screen.getByRole('status')).getByText(t('settings.accounts.inactiveStatus'))).toBeTruthy();
  act(() => useMailStore.setState({ activeAccountId: 'personal', connectionStatus: 'connected', connectionErrorType: null, connectionError: null }));
  expect(within(screen.getByRole('status')).getByText(t('settings.accounts.connected'))).toBeTruthy();
});

it('distinguishes a disconnected active account from an account that is not open', () => {
  useMailStore.setState({ connectionStatus: 'disconnected' });
  render(<AccountSettings accounts={accounts} />);
  expect(within(screen.getByRole('status')).getByText(t('settings.accounts.disconnected'))).toBeTruthy();
  expect(within(screen.getByRole('status')).queryByText(t('settings.accounts.inactiveStatus'))).toBeNull();
});

it('clears unsubmitted password and destructive confirmation when choosing another account', () => {
  render(<AccountSettings accounts={accounts} initialSection="connection" />);
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.update'), exact: true }));
  fireEvent.change(screen.getByLabelText(t('settings.accounts.newPassword')), { target: { value: 'unsubmitted' } });
  fireEvent.click(screen.getByRole('button', { name: /Personal personal@example.test/ }));
  fireEvent.click(screen.getByRole('button', { name: /Studio studio@example.test/ }));
  expect(screen.queryByLabelText(t('settings.accounts.newPassword'))).toBeNull();
  fireEvent.click(tab('Advanced'));
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.removeAccount2') }));
  expect(screen.getByText(t('settings.accounts.sureRemoveAccount', { email: 'studio@example.test' }))).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Personal personal@example.test/ }));
  expect(screen.queryByText(t('settings.accounts.sureRemoveAccount', { email: 'personal@example.test' }))).toBeNull();
});
