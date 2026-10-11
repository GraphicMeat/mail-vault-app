// @vitest-environment jsdom
// Settings > Accounts > Connection for a JMAP account: its session, sign-in
// kind and login, and a "Replace password or token" field. No IMAP or SMTP
// host: editing a JMAP account as IMAP would corrupt it.
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AccountSettings } from '../AccountSettings';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';

vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));
vi.mock('../../../services/aliasDiscovery', () => ({
  refreshAliases: vi.fn(async () => ({ added: [], suggestions: [], providerStatus: 'ok' })),
}));

const TOKEN = {
  id: 'fm', name: 'Fastmail', email: 'me@fastmail.com', authType: 'password', password: 'fmu1-tok',
  imapHost: 'api.fastmail.com', jmapSessionUrl: 'https://api.fastmail.com/jmap/session', jmapAuth: 'bearer',
};
const BASIC = {
  id: 'sw', name: 'Stalwart', email: 'me@example.org', authType: 'password', password: 'pw',
  imapHost: 'mail.example.org', jmapSessionUrl: 'https://mail.example.org/jmap/session', jmapAuth: 'basic', jmapUsername: 'alice',
};
const connection = () => fireEvent.click(screen.getByRole('tab', { name: t('settings.accounts.sectionConnection') }));

beforeEach(() => {
  useSettingsStore.setState({ signatures: {}, displayNames: {}, sendAsAddresses: {}, aliases: {}, dismissedAliases: {}, accountColors: {}, accountOrder: [], hiddenAccounts: {} });
  useMailStore.setState({ accounts: [TOKEN, BASIC], activeAccountId: 'fm', activeMailbox: 'INBOX', mailboxes: [], connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
});
afterEach(cleanup);

it('shows the session and a replace-secret field, and no IMAP host', () => {
  render(<AccountSettings accounts={[TOKEN, BASIC]} />);
  connection();

  const details = screen.getByTestId('jmap-server-details');
  expect(details.textContent).toContain('https://api.fastmail.com/jmap/session');
  expect(details.textContent).toContain(t('account.jmapApiToken'));
  expect(screen.queryByText(t('settings.accounts.imap'))).toBeNull();
  expect(screen.queryByText(/api\.fastmail\.com:993/)).toBeNull();
  // Change server stays: it re-points the session, as a JMAP account.
  expect(screen.getByRole('button', { name: t('settings.accounts.changeServer') })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: t('account.jmapReplaceSecret') }));
  expect(screen.getByLabelText(t('account.jmapReplaceSecret'))).toBeTruthy();
});

it('names the Basic login of a password account', () => {
  render(<AccountSettings accounts={[TOKEN, BASIC]} initialAccountId="sw" initialSection="connection" />);
  const details = screen.getByTestId('jmap-server-details');
  expect(details.textContent).toContain(t('account.jmapUsername'));
  expect(details.textContent).toContain('alice');
  expect(details.textContent).toContain(t('settings.accounts.password'));
});

it('leaves an IMAP account as it was', () => {
  const imap = { id: 'im', name: 'Imap', email: 'me@imap.test', password: 'x', imapHost: 'imap.imap.test', imapPort: 993, smtpHost: 'smtp.imap.test', smtpPort: 587 };
  useMailStore.setState({ accounts: [imap], activeAccountId: 'im' });
  render(<AccountSettings accounts={[imap]} initialSection="connection" />);
  expect(screen.queryByTestId('jmap-server-details')).toBeNull();
  expect(screen.getByText('imap.imap.test:993')).toBeTruthy();
  expect(screen.queryByRole('button', { name: t('account.jmapReplaceSecret') })).toBeNull();
});
