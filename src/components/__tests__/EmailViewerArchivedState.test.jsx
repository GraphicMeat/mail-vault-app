// @vitest-environment jsdom

// The reader decides archived state by the rule the list, the selection bar
// and the bulk modal use: the message's own flag, or, for a message of the
// open folder, the folder's archived uids. Server view writes isArchived false
// on every row it lists, and another folder's message can share a uid with an
// archived one here.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useMailStore } from '../../stores/mailStore';
import { useThemeStore } from '../../stores/themeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { EmailViewer } from '../EmailViewer';

vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 700,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: 0 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: emails => ({
    bodiesMapRef: { current: new Map(emails.map(email => [emailKey(email), { status: 'loaded', email }])) },
    registerListener: () => () => {},
  }) };
});

const readerAction = action => ({ id: action, action, params: {} });

function renderViewer(email, { viewMode = 'all', archived = [] } = {}) {
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({ emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline', signatureDisplay: 'smart' });
  useSettingsStore.getState().setQuickActionSurface('reader', null, {
    mode: 'inline', entries: [readerAction('archive'), readerAction('deleteServer')], favoriteId: 'archive', palette: 'neutral',
  });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }],
    activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null, unifiedInbox: false, viewMode,
    selectedEmail: email, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server',
    emails: [email], sortedEmails: [email], savedEmailIds: new Set(), archivedEmailIds: new Set(archived),
  });
  const { container } = render(<EmailViewer />);
  return within(container.querySelector('.email-action-bar'));
}

const message = overrides => ({
  uid: 5, _accountId: 'acct-1', _mailbox: 'INBOX', subject: 'Question', source: 'server', isArchived: false,
  from: { name: 'Sender', address: 'sender@example.test' }, to: [{ address: 'me@example.test' }],
  html: '<p>Text.</p>', text: 'Text.', attachments: [], flags: ['\\Seen'], date: '2026-09-26', ...overrides,
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useSettingsStore.getState().resetQuickActions();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EmailViewer archived state', () => {
  it('offers Unarchive for an open-folder message its folder holds archived, in Server view', () => {
    const bar = renderViewer(message(), { viewMode: 'server', archived: ['acct-1:INBOX:5'] });
    expect(bar.queryAllByRole('button', { name: /^Unarchive$/ })).toHaveLength(1);
    expect(bar.queryAllByRole('button', { name: /^Archive$/ })).toHaveLength(0);
    // The custody band states the same thing the buttons act on.
    expect(document.querySelector('[data-testid="email-custody-band"]').getAttribute('data-tone')).toBe('local');
  });

  it('never claims a vault copy for another folder\'s message that shares an archived uid', async () => {
    const bar = renderViewer(message({ _mailbox: 'Sent' }), { archived: ['acct-1:INBOX:5'] });
    expect(bar.queryAllByRole('button', { name: /^Archive$/ })).toHaveLength(1);
    expect(document.querySelector('[data-testid="email-custody-band"]').getAttribute('data-tone')).toBe('server');
    fireEvent.click(bar.getByRole('button', { name: /delete/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('This email will be permanently deleted from the server.');
  });
});
