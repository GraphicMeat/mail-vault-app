// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  // Every icon resolves. A hand-listed set breaks the moment a shared
  // primitive (ui/Button pulls in Loader, ui/Dialog pulls in X) imports one
  // more glyph — vitest then fails the whole file with "No export defined".
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

const openChangeServer = vi.fn();
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign(vi.fn(), { getState: () => ({ openChangeServer }) }),
}));

import { ConnectionErrorCard } from '../Sidebar';
import { t } from '../../i18n';

const account = { id: 'acct-1', email: 'user@example.com', authType: 'password' };

function baseProps(overrides = {}) {
  return {
    account,
    connectionErrorType: 'passwordMissing',
    activeMailbox: 'INBOX',
    activateAccount: vi.fn(),
    retryKeychainAccess: vi.fn(),
    setShowErrorModal: vi.fn(),
    onOpenAccounts: vi.fn(),
    ...overrides,
  };
}

describe('ConnectionErrorCard', () => {
  afterEach(() => {
    cleanup();
    openChangeServer.mockClear();
  });

  it('offers one password repair action that opens the affected account', () => {
    const props = baseProps();
    render(<ConnectionErrorCard {...props} />);
    expect(screen.getByText('Password missing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('sidebar.enterPassword') }));
    expect(props.onOpenAccounts).toHaveBeenCalledWith('acct-1', 'connection');
    expect(screen.queryByTitle('Retry')).toBeNull();
  });

  it('keeps server configuration behind account connection details', () => {
    const props = baseProps();
    render(<ConnectionErrorCard {...props} />);
    expect(screen.queryByText('Change server')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('sidebar.details') }));
    expect(props.setShowErrorModal).toHaveBeenCalledWith(true);
  });

  it('never shows Migrate mail (button removed from the card)', () => {
    render(<ConnectionErrorCard {...baseProps()} />);
    expect(screen.queryByText('Migrate mail')).toBeNull();
  });

  it('hides Change server for OAuth2 accounts', () => {
    const oauthAccount = { ...account, authType: 'oauth2' };
    render(<ConnectionErrorCard {...baseProps({ account: oauthAccount, connectionErrorType: 'oauthExpired' })} />);
    expect(screen.queryByText('Change server')).toBeNull();
  });

  it('reconnects an expired sign-in through its account settings', () => {
    const props = baseProps({ account: { ...account, authType: 'oauth2' }, connectionErrorType: 'oauthExpired' });
    render(<ConnectionErrorCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: t('sidebar.reconnect') }));
    expect(props.onOpenAccounts).toHaveBeenCalledWith('acct-1', 'connection');
    expect(props.activateAccount).not.toHaveBeenCalled();
  });

  // A failed sync used to read "Connection problem" whatever went wrong. The
  // daemon now says what (errorCode) and the notice names the remedy.
  it('names the blocked host and port so the user can ask IT to open it', () => {
    const props = baseProps({
      account: { ...account, imapHost: 'imap.example.test', imapPort: 993 },
      connectionErrorType: 'serverError',
      connectionErrorCode: 'blocked_or_timeout',
    });
    render(<ConnectionErrorCard {...props} />);
    expect(screen.getByText(t('sidebar.conn.blocked', { host: 'imap.example.test', port: 993 }))).toBeTruthy();
    expect(screen.queryByText(t('sidebar.connectionProblem'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(props.activateAccount).toHaveBeenCalledWith('acct-1', 'INBOX');
  });

  it('tells a throttled user to wait', () => {
    render(<ConnectionErrorCard {...baseProps({ connectionErrorType: 'serverError', connectionErrorCode: 'throttled' })} />);
    expect(screen.getByText(t('sidebar.conn.throttled'))).toBeTruthy();
  });

  it('sends a rejected sign-in to the password, not to Retry', () => {
    const props = baseProps({ connectionErrorType: 'serverError', connectionErrorCode: 'auth' });
    render(<ConnectionErrorCard {...props} />);
    expect(screen.getByText(t('sidebar.conn.auth'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('sidebar.enterPassword') }));
    expect(props.onOpenAccounts).toHaveBeenCalledWith('acct-1', 'connection');
    expect(props.activateAccount).not.toHaveBeenCalled();
  });

  it('sends a rejected OAuth sign-in to Reconnect', () => {
    const props = baseProps({
      account: { ...account, authType: 'oauth2' },
      connectionErrorType: 'serverError',
      connectionErrorCode: 'auth',
    });
    render(<ConnectionErrorCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: t('sidebar.reconnect') }));
    expect(props.onOpenAccounts).toHaveBeenCalledWith('acct-1', 'connection');
  });

  it('ignores a code left over from another kind of error', () => {
    // Only a serverError carries a code; a stale one must not reword another notice.
    render(<ConnectionErrorCard {...baseProps({ connectionErrorType: 'timeout', connectionErrorCode: 'dns' })} />);
    expect(screen.getByText(t('sidebar.timedOut'))).toBeTruthy();
  });

  it('keeps the generic notice for an unclassified failure', () => {
    render(<ConnectionErrorCard {...baseProps({ connectionErrorType: 'serverError', connectionErrorCode: 'other' })} />);
    expect(screen.getByText(t('sidebar.connectionProblem'))).toBeTruthy();
  });

  it('shows generic server-error state with retry + view-details actions', () => {
    const props = baseProps({ connectionErrorType: 'serverError' });
    render(<ConnectionErrorCard {...props} />);
    expect(screen.getByText(t('sidebar.connectionProblem'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('sidebar.details') }));
    expect(props.setShowErrorModal).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(props.activateAccount).toHaveBeenCalledWith('acct-1', 'INBOX');
  });
});
