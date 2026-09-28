// @vitest-environment jsdom

// "Open in new window" beside the reader's close, for a reader that asks for
// it (Notes to Self). A note is usually plain text, and the window used to
// open only for a message with an HTML body: for a text one it did nothing.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMailStore } from '../../stores/mailStore';
import { useThemeStore } from '../../stores/themeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { EmailViewer } from '../EmailViewer';
import { t } from '../../i18n';

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

const invoke = vi.fn(async () => {});
const windowCalls = () => invoke.mock.calls.filter(([command]) => command === 'open_email_window');
// The shell only from the click on: the reader mounts as in every other test.
const openInWindow = () => {
  window.__TAURI__ = { core: { invoke } };
  fireEvent.click(screen.getByTestId('open-in-window'));
};

function renderViewer(body, props = {}) {
  const email = {
    uid: 5, _accountId: 'acct-1', _mailbox: 'INBOX', subject: 'Pasta <recipe>',
    from: { name: 'Me', address: 'me@example.test' }, to: [{ address: 'me@example.test' }],
    attachments: [], flags: ['\\Seen'], date: '2026-09-26', ...body,
  };
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({ emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline', signatureDisplay: 'smart' });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }],
    activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null,
    selectedEmail: email, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server',
    emails: [email], sortedEmails: [email], savedEmailIds: new Set(), archivedEmailIds: new Set(),
  });
  return render(<EmailViewer onClose={() => {}} {...props} />);
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  invoke.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.__TAURI__; });

describe('EmailViewer open in new window', () => {
  it('is not offered unless the reader asks for it', () => {
    renderViewer({ text: 'Boil water.' });
    expect(screen.queryByTestId('open-in-window')).toBeNull();
  });

  it('sits beside the one close control', () => {
    renderViewer({ text: 'Boil water.' }, { showOpenInWindow: true });
    const button = screen.getByTestId('open-in-window');
    expect(button.getAttribute('aria-label')).toBe(t('chat.bubble.openNewWindow'));
    expect(button.parentElement.contains(screen.getByTestId('close-viewer'))).toBe(true);
  });

  it('opens a plain-text message, its text escaped', () => {
    renderViewer({ text: 'Boil <water>.\nAdd salt.' }, { showOpenInWindow: true });
    openInWindow();
    expect(windowCalls()).toHaveLength(1);
    const [, { html, title }] = windowCalls()[0];
    expect(title).toBe('Pasta <recipe>');
    expect(html).toContain('Boil &lt;water&gt;.');
    expect(html).toContain('Add salt.');
    expect(html).not.toContain('<water>');
  });

  it('opens an HTML message from its HTML', () => {
    renderViewer({ html: '<p>Rich <b>body</b></p>', text: 'Rich body' }, { showOpenInWindow: true });
    openInWindow();
    expect(windowCalls()[0][1].html).toContain('<b>body</b>');
  });
});
