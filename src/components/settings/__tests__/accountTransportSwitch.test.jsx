// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountSettings } from '../AccountSettings';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';
import '../../../services/workflows/bindStoreActions';

// Settings > Accounts > Connection switches a Microsoft account between Graph
// and IMAP in place: a sign-in with the new transport's scopes, then one
// daemon call that re-files the vault and saves the account. The shell sends
// the grant and the server fields; it never touches the vault itself.

const { mockSwitch, db } = vi.hoisted(() => {
  const mockSwitch = vi.fn(async () => ({ account: {} }));
  const db = () => ({
    getCachedMailboxes: async () => [],
    switchAccountTransport: (...a) => mockSwitch(...a),
    accountExpectedContext: a => ({ fields: { email: a.email, oauth2Transport: a.oauth2Transport } }),
  });
  return { mockSwitch, db };
});
// Both ids: db.js re-exports db/index.js, and AccountSettings' dynamic import
// can land on either.
vi.mock('../../../services/db', db);
vi.mock('../../../services/db/index.js', db);

const mockShellOpen = vi.fn(async () => {});
vi.mock('@tauri-apps/plugin-shell', () => ({ open: (...a) => mockShellOpen(...a) }));

const mockGetOAuth2AuthUrl = vi.fn();
const mockExchangeOAuth2Code = vi.fn();
vi.mock('../../../services/api', async importOriginal => ({
  ...(await importOriginal()),
  getOAuth2AuthUrl: (...a) => mockGetOAuth2AuthUrl(...a),
  exchangeOAuth2Code: (...a) => mockExchangeOAuth2Code(...a),
}));

function msAccount(extra = {}) {
  return {
    id: 'm1', name: 'Home', email: 'me@outlook.com', authType: 'oauth2', oauth2Provider: 'microsoft',
    oauth2Transport: 'graph', oauth2RefreshToken: 'old-rt', oauth2AccessToken: 'old-at', oauth2ExpiresAt: 1, ...extra,
  };
}

let init;
function open(account) {
  useMailStore.setState({ accounts: [account] });
  render(<AccountSettings accounts={[account]} />);
  fireEvent.click(screen.getByRole('tab', { name: t('settings.accounts.sectionConnection') }));
}
const select = () => screen.getByRole('combobox', { name: t('account.msTransport') });
const switchButton = () => screen.getByRole('button', { name: t('settings.accounts.transportSwitch') });

beforeEach(() => {
  mockSwitch.mockReset().mockResolvedValue({ account: {} });
  mockShellOpen.mockClear();
  mockGetOAuth2AuthUrl.mockReset().mockResolvedValue({ authUrl: 'https://login.microsoftonline.com/x', state: 's1' });
  mockExchangeOAuth2Code.mockReset().mockResolvedValue({ accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 99 });
  vi.spyOn(window, 'open').mockImplementation(() => {});
  useSettingsStore.setState({ signatures: {}, displayNames: {}, sendAsAddresses: {}, accountColors: {}, accountOrder: [], hiddenAccounts: {}, transportRefusals: {} });
  init = vi.fn(async () => {});
  useMailStore.setState({ activeAccountId: 'm1', activeMailbox: 'INBOX', mailboxes: [], connectionStatus: 'connected', connectionError: null, connectionErrorType: null, init });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows the current transport and offers no switch until another is picked', () => {
  open(msAccount());
  expect(screen.getByTestId('ms-transport-current').textContent).toBe(t('account.msTransportGraph'));
  expect(select().value).toBe('graph');
  expect(switchButton().disabled).toBe(true);
});

it('Graph to IMAP: signs in with IMAP scopes, then hands the grant and IMAP servers to the daemon', async () => {
  open(msAccount());
  fireEvent.change(select(), { target: { value: 'imap' } });
  fireEvent.click(switchButton());

  await waitFor(() => expect(mockSwitch).toHaveBeenCalledTimes(1));
  expect(mockGetOAuth2AuthUrl.mock.calls[0][4]).toBe(false);
  const [id, transport, fields, opts] = mockSwitch.mock.calls[0];
  expect([id, transport]).toEqual(['m1', 'imap']);
  expect(fields).toMatchObject({
    oauth2AccessToken: 'new-at', oauth2RefreshToken: 'new-rt',
    imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp-mail.outlook.com', smtpPort: 587,
  });
  expect(opts.expected.fields).toEqual({ email: 'me@outlook.com', oauth2Transport: 'graph' });
  await waitFor(() => expect(init).toHaveBeenCalled());
});

it('IMAP to Graph: signs in with Graph scopes and sends no server fields', async () => {
  open(msAccount({ oauth2Transport: 'imap', email: 'me@contoso.example', imapHost: 'outlook.office365.com' }));
  expect(select().value).toBe('imap');
  fireEvent.change(select(), { target: { value: 'graph' } });
  fireEvent.click(switchButton());

  await waitFor(() => expect(mockSwitch).toHaveBeenCalledTimes(1));
  expect(mockGetOAuth2AuthUrl.mock.calls[0][4]).toBe(true);
  const [, transport, fields] = mockSwitch.mock.calls[0];
  expect(transport).toBe('graph');
  expect(fields).not.toHaveProperty('smtpHost');
});

it('a sign-in that fails changes nothing and says why', async () => {
  mockExchangeOAuth2Code.mockRejectedValue(new Error('cancelled'));
  open(msAccount());
  fireEvent.change(select(), { target: { value: 'imap' } });
  fireEvent.click(switchButton());

  expect((await screen.findByRole('alert')).textContent).toContain('cancelled');
  expect(mockSwitch).not.toHaveBeenCalled();
  expect(init).not.toHaveBeenCalled();
});

it('a refusal from the daemon reads from the catalog', async () => {
  mockSwitch.mockRejectedValue(new Error('errors.transportSwitchPending'));
  open(msAccount());
  fireEvent.change(select(), { target: { value: 'imap' } });
  fireEvent.click(switchButton());
  expect((await screen.findByRole('alert')).textContent).toBe(t('errors.transportSwitchPending'));
});

it('a Google account has no transport switch', () => {
  open(msAccount({ oauth2Provider: 'google', oauth2Transport: undefined, email: 'me@gmail.com' }));
  expect(screen.queryByTestId('ms-transport-section')).toBeNull();
});

// Outlook.com refuses IMAP until "Let devices and apps use IMAP" is on. A
// refused switch leaves the steps, the Outlook settings link and the FAQ on
// screen, and keeps them for the account until a switch goes through.
describe('a switch Outlook refused over IMAP', () => {
  const REFUSED = 'errors.transportSwitchImapRefused';
  const help = () => screen.queryByTestId('outlook-imap-help');

  async function refuse() {
    mockSwitch.mockRejectedValueOnce(new Error(REFUSED));
    open(msAccount());
    fireEvent.change(select(), { target: { value: 'imap' } });
    fireEvent.click(switchButton());
    return screen.findByTestId('outlook-imap-help');
  }

  it('shows how to turn IMAP on, with Outlook settings and the FAQ a click away', async () => {
    const panel = await refuse();
    expect(panel.textContent).toContain(t('help.outlookImap.steps'));
    expect(screen.getByAltText(t('help.outlookImap.imageAlt'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('help.outlookImap.open') }));
    await waitFor(() => expect(mockShellOpen).toHaveBeenCalledWith('https://outlook.live.com/mail/options/mail/forwarding'));
    fireEvent.click(screen.getByRole('button', { name: t('help.outlookImap.faq') }));
    await waitFor(() => expect(mockShellOpen).toHaveBeenCalledWith('https://mailvaultapp.com/faq/troubleshooting.html#outlook-imap-not-connected'));
  });

  it('is remembered for the account after Settings is closed and opened again', async () => {
    await refuse();
    expect(useSettingsStore.getState().transportRefusals).toEqual({ m1: REFUSED });
    cleanup();
    open(msAccount());
    expect(help()).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(t(REFUSED));
  });

  it('a switch that goes through forgets it', async () => {
    useSettingsStore.setState({ transportRefusals: { m1: REFUSED } });
    open(msAccount());
    expect(help()).toBeTruthy();
    fireEvent.change(select(), { target: { value: 'imap' } });
    fireEvent.click(switchButton());
    await waitFor(() => expect(useSettingsStore.getState().transportRefusals).toEqual({}));
    expect(help()).toBeNull();
  });

  it('another refusal shows no Outlook help', async () => {
    mockSwitch.mockRejectedValueOnce(new Error('errors.transportSwitchPending'));
    open(msAccount());
    fireEvent.change(select(), { target: { value: 'imap' } });
    fireEvent.click(switchButton());
    await screen.findByRole('alert');
    expect(help()).toBeNull();
  });
});
