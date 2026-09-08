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
