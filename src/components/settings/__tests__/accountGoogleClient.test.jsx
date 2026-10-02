// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountSettings } from '../AccountSettings';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';

// A Gmail account signs in through one of two Google apps: Thunderbird's or
// MailVault's own. Settings shows which, lets the user switch (a fresh sign-in
// through the chosen app) and keeps the CURRENT app on a plain Reconnect:
// Reconnect must never move an account between apps.

const mockSaveAccount = vi.fn(async () => {});
vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: (...a) => mockSaveAccount(...a) }));
vi.mock('../../../services/db/index.js', () => ({ getCachedMailboxes: async () => [], saveAccount: (...a) => mockSaveAccount(...a) }));

const mockGetOAuth2AuthUrl = vi.fn();
const mockExchangeOAuth2Code = vi.fn();
const mockGetGoogleClients = vi.fn();
vi.mock('../../../services/api', async importOriginal => ({
  ...(await importOriginal()),
  getOAuth2AuthUrl: (...a) => mockGetOAuth2AuthUrl(...a),
  exchangeOAuth2Code: (...a) => mockExchangeOAuth2Code(...a),
  getGoogleClients: (...a) => mockGetGoogleClients(...a),
}));

const TB_ID = 'thunderbird.apps.googleusercontent.com';
const OWN_ID = 'own.apps.googleusercontent.com';
const CLIENTS = { mailvault: true, default: 'thunderbird', thunderbirdClientId: TB_ID, mailvaultClientId: OWN_ID };

function googleAccount(extra = {}) {
  return {
    id: 'g1', name: 'Personal', email: 'personal@example.test', authType: 'oauth2', oauth2Provider: 'google',
    oauth2RefreshToken: 'old-rt', oauth2AccessToken: 'old-at', oauth2ExpiresAt: 1, ...extra,
  };
}

async function open(account) {
  useMailStore.setState({ accounts: [account] });
  render(<AccountSettings accounts={[account]} />);
  fireEvent.click(screen.getByRole('tab', { name: t('settings.accounts.sectionConnection') }));
  await waitFor(() => expect(mockGetGoogleClients).toHaveBeenCalled());
}

const current = () => screen.getByTestId('google-client-current').textContent;
const savedAccount = async () => {
  await waitFor(() => expect(mockSaveAccount).toHaveBeenCalledTimes(1));
  return mockSaveAccount.mock.calls[0][0];
};

beforeEach(() => {
  mockSaveAccount.mockClear();
  mockGetGoogleClients.mockReset().mockResolvedValue(CLIENTS);
  mockGetOAuth2AuthUrl.mockReset().mockResolvedValue({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', state: 's1' });
  mockExchangeOAuth2Code.mockReset().mockResolvedValue({ accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 99, clientId: OWN_ID });
  vi.spyOn(window, 'open').mockImplementation(() => {});
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  useSettingsStore.setState({ signatures: {}, displayNames: {}, sendAsAddresses: {}, accountColors: {}, accountOrder: [], hiddenAccounts: {} });
  useMailStore.setState({ accounts: [googleAccount()], activeAccountId: 'g1', activeMailbox: 'INBOX', mailboxes: [], connectionStatus: 'connected', connectionError: null, connectionErrorType: null, init: vi.fn(async () => {}) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Settings > Accounts: the Google sign-in app', () => {
  it('shows Thunderbird for an account with no stamp (signed in before stamps existed)', async () => {
    await open(googleAccount());
    expect(current()).toBe('Thunderbird');
  });

  it("shows Thunderbird for an account stamped with Thunderbird's client", async () => {
    await open(googleAccount({ oauth2ClientId: TB_ID }));
    expect(current()).toBe('Thunderbird');
  });

  it("shows MailVault for an account stamped with MailVault's client", async () => {
    await open(googleAccount({ oauth2ClientId: OWN_ID }));
    await waitFor(() => expect(current()).toBe('MailVault'));
  });

  it('explains why Thunderbird is used and where this is heading', async () => {
    await open(googleAccount());
    expect(screen.getByText(/MailVault signs in to Gmail through Thunderbird's Google app for now/)).toBeTruthy();
  });

  it('shows nothing for a Microsoft account', async () => {
    useMailStore.setState({ accounts: [googleAccount({ oauth2Provider: 'microsoft' })] });
    render(<AccountSettings accounts={[googleAccount({ oauth2Provider: 'microsoft' })]} />);
    fireEvent.click(screen.getByRole('tab', { name: t('settings.accounts.sectionConnection') }));
    expect(screen.queryByTestId('google-client-section')).toBeNull();
  });

  it('switches to MailVault: signs in again through it and stamps the result with the client that issued it', async () => {
    await open(googleAccount({ oauth2ClientId: TB_ID }));
    fireEvent.change(screen.getByLabelText('Google sign-in app'), { target: { value: 'mailvault' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch and sign in again' }));
    const saved = await savedAccount();
    expect(mockGetOAuth2AuthUrl.mock.calls[0][1]).toBe('google');
    expect(mockGetOAuth2AuthUrl.mock.calls[0][5]).toBe('mailvault');
    expect(saved.oauth2RefreshToken).toBe('new-rt');
    expect(saved.oauth2ClientId).toBe(OWN_ID);
  });

  it('switches back to Thunderbird', async () => {
    mockExchangeOAuth2Code.mockResolvedValue({ accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 99, clientId: TB_ID });
    await open(googleAccount({ oauth2ClientId: OWN_ID }));
    await waitFor(() => expect(current()).toBe('MailVault'));
    fireEvent.change(screen.getByLabelText('Google sign-in app'), { target: { value: 'thunderbird' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch and sign in again' }));
    const saved = await savedAccount();
    expect(mockGetOAuth2AuthUrl.mock.calls[0][5]).toBe('thunderbird');
    expect(saved.oauth2ClientId).toBe(TB_ID);
  });

  it('has nothing to switch to until another app is picked', async () => {
    await open(googleAccount());
    expect(screen.getByRole('button', { name: 'Switch and sign in again' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Google sign-in app'), { target: { value: 'mailvault' } });
    expect(screen.getByRole('button', { name: 'Switch and sign in again' }).disabled).toBe(false);
  });

  it("disables MailVault's own app, with the reason, when this build lacks it", async () => {
    mockGetGoogleClients.mockResolvedValue({ mailvault: false, default: 'thunderbird', thunderbirdClientId: TB_ID, mailvaultClientId: null });
    await open(googleAccount());
    const option = await screen.findByRole('option', { name: "MailVault's own Google app (in Google review)" });
    await waitFor(() => expect(option.disabled).toBe(true));
    expect(screen.getByText('This build of MailVault does not include its own Google sign-in.')).toBeTruthy();
    expect(screen.getByRole('option', { name: "Thunderbird's Google app (default)" }).disabled).toBe(false);
  });
});

describe('Settings > Accounts: a plain Reconnect keeps the current Google app', () => {
  async function reconnect(account) {
    await open(account);
    // Let the reported ids land: the stamp is read against them.
    await screen.findByTestId('google-client-current');
    fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.reconnect') }));
    return savedAccount();
  }

  it('keeps Thunderbird for a Thunderbird-stamped account', async () => {
    await reconnect(googleAccount({ oauth2ClientId: TB_ID }));
    expect(mockGetOAuth2AuthUrl.mock.calls[0][5]).toBe('thunderbird');
  });

  it('keeps Thunderbird for an account with no stamp', async () => {
    await reconnect(googleAccount());
    expect(mockGetOAuth2AuthUrl.mock.calls[0][5]).toBe('thunderbird');
  });

  it('keeps MailVault for a MailVault-stamped account', async () => {
    await reconnect(googleAccount({ oauth2ClientId: OWN_ID }));
    expect(mockGetOAuth2AuthUrl.mock.calls[0][5]).toBe('mailvault');
  });

  it('does not choose an app for a Microsoft account', async () => {
    mockGetOAuth2AuthUrl.mockResolvedValue({ authUrl: 'https://login.microsoftonline.com/x', state: 's1' });
    useMailStore.setState({ accounts: [googleAccount({ oauth2Provider: 'microsoft' })] });
    render(<AccountSettings accounts={[googleAccount({ oauth2Provider: 'microsoft' })]} />);
    fireEvent.click(screen.getByRole('tab', { name: t('settings.accounts.sectionConnection') }));
    fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.reconnect') }));
    await savedAccount();
    expect(mockGetOAuth2AuthUrl.mock.calls[0][5]).toBeUndefined();
  });

  it("says why in the catalog text when the build lacks the account's MailVault app", async () => {
    mockGetOAuth2AuthUrl.mockRejectedValue(new Error('E_GOOGLE_OWN_CLIENT_UNAVAILABLE: This build of MailVault does not include its own Google sign-in.'));
    await open(googleAccount({ oauth2ClientId: OWN_ID }));
    await screen.findByTestId('google-client-current');
    fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.reconnect') }));
    await waitFor(() => expect(window.alert).toHaveBeenCalled());
    expect(window.alert.mock.calls[0][0]).toContain(t('googleClient.ownUnavailable'));
    expect(mockSaveAccount).not.toHaveBeenCalled();
  });
});
