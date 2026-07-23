// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  const names = [
    'Inbox', 'Send', 'File', 'Trash2', 'Star', 'Archive', 'AlertCircle', 'AlertTriangle',
    'CheckCircle2', 'Plus', 'ChevronDown', 'ChevronRight', 'Settings', 'HardDrive', 'Cloud',
    'Layers', 'PenSquare', 'Sun', 'Moon', 'WifiOff', 'Key', 'ServerOff', 'RefreshCw', 'Info',
    'X', 'PanelLeftClose', 'PanelLeftOpen', 'Loader',
  ];
  return Object.fromEntries(names.map((n) => [n, icon(n)]));
});

const openChangeServer = vi.fn();
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign(vi.fn(), { getState: () => ({ openChangeServer }) }),
}));

import { ConnectionErrorCard } from '../Sidebar';

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

  it('shows password-missing state with retry + re-enter password actions', () => {
    const props = baseProps();
    render(<ConnectionErrorCard {...props} />);
    expect(screen.getByText('Password missing')).toBeTruthy();
    fireEvent.click(screen.getByText('Re-enter Password in Settings'));
    expect(props.onOpenAccounts).toHaveBeenCalledWith('acct-1');
  });

  it('shows Change server for a non-OAuth account and wires it to openChangeServer', () => {
    render(<ConnectionErrorCard {...baseProps()} />);
    fireEvent.click(screen.getByText('Change server'));
    expect(openChangeServer).toHaveBeenCalledWith('acct-1');
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

  it('shows generic server-error state with retry + view-details actions', () => {
    const props = baseProps({ connectionErrorType: 'serverError' });
    render(<ConnectionErrorCard {...props} />);
    expect(screen.getByText('Server error')).toBeTruthy();
    fireEvent.click(screen.getByTitle('View error details'));
    expect(props.setShowErrorModal).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTitle('Retry connection'));
    expect(props.activateAccount).toHaveBeenCalledWith('acct-1', 'INBOX');
  });
});
