// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountSettings } from '../AccountSettings';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';

// Reconnect saves `{...account, ...tokens}`. A refresh token only works with
// the OAuth client that issued it, so the save must also carry the client the
// new sign-in used: an account that predates the stamp (or holds the old
// client's) would otherwise refresh its new tokens as the wrong client.

const mockSaveAccount = vi.fn(async () => {});
// Both ids: db.js re-exports db/index.js, and AccountSettings' dynamic import
// can land on either.
vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: (...a) => mockSaveAccount(...a) }));
vi.mock('../../../services/db/index.js', () => ({ getCachedMailboxes: async () => [], saveAccount: (...a) => mockSaveAccount(...a) }));

const mockGetOAuth2AuthUrl = vi.fn();
const mockExchangeOAuth2Code = vi.fn();
vi.mock('../../../services/api', async importOriginal => ({
  ...(await importOriginal()),
  getOAuth2AuthUrl: (...a) => mockGetOAuth2AuthUrl(...a),
  exchangeOAuth2Code: (...a) => mockExchangeOAuth2Code(...a),
}));

const OLD = 'thunderbird.apps.googleusercontent.com';
const NEW = 'own.apps.googleusercontent.com';

function googleAccount(extra = {}) {
  return {
    id: 'g1', name: 'Personal', email: 'personal@example.test', authType: 'oauth2', oauth2Provider: 'google',
    oauth2RefreshToken: 'old-rt', oauth2AccessToken: 'old-at', oauth2ExpiresAt: 1, ...extra,
  };
}

async function reconnect(account) {
  render(<AccountSettings accounts={[account]} />);
  fireEvent.click(screen.getByRole('tab', { name: t('settings.accounts.sectionConnection') }));
  fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.reconnect') }));
  await waitFor(() => expect(mockSaveAccount).toHaveBeenCalledTimes(1));
  return mockSaveAccount.mock.calls[0][0];
}

beforeEach(() => {
  mockSaveAccount.mockClear();
  mockGetOAuth2AuthUrl.mockReset().mockResolvedValue({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', state: 's1' });
  mockExchangeOAuth2Code.mockReset().mockResolvedValue({ accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 99, clientId: NEW });
  vi.spyOn(window, 'open').mockImplementation(() => {});
  useSettingsStore.setState({ signatures: {}, displayNames: {}, sendAsAddresses: {}, accountColors: {}, accountOrder: [], hiddenAccounts: {} });
  const acct = googleAccount();
  useMailStore.setState({ accounts: [acct], activeAccountId: 'g1', activeMailbox: 'INBOX', mailboxes: [], connectionStatus: 'connected', connectionError: null, connectionErrorType: null, init: vi.fn(async () => {}) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('stamps an unstamped (legacy) account with the client the new sign-in used', async () => {
  const saved = await reconnect(googleAccount());
  expect(saved.oauth2RefreshToken).toBe('new-rt');
  expect(saved.oauth2ClientId).toBe(NEW);
});

it('replaces an old stamp carried in by the spread of the existing account', async () => {
  const saved = await reconnect(googleAccount({ oauth2ClientId: OLD }));
  expect(saved.oauth2RefreshToken).toBe('new-rt');
  expect(saved.oauth2ClientId).toBe(NEW);
});

it('keeps no stale stamp when the exchange reports no client', async () => {
  mockExchangeOAuth2Code.mockResolvedValue({ accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 99 });
  const saved = await reconnect(googleAccount({ oauth2ClientId: OLD }));
  expect(saved.oauth2ClientId).toBeUndefined();
});
