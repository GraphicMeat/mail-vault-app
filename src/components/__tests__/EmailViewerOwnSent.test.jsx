// @vitest-environment jsdom

// Gmail keeps sent mail in "[Gmail]/Sent Mail" and Outlook in "Sent Items".
// A check for a folder named exactly "sent" missed both, so your own sent
// message was offered Reply and quick replies as if someone had written to you.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
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

function renderViewer(mailbox) {
  const email = {
    uid: 5, _accountId: 'acct-1', _mailbox: mailbox, subject: 'Question',
    from: { name: 'Me', address: 'me@example.test' }, to: [{ address: 'a@example.test' }],
    html: '<p>Sent text.</p>', text: 'Sent text.', attachments: [], flags: ['\\Seen'], date: '2026-09-26',
  };
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({ emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline', signatureDisplay: 'smart' });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }],
    activeAccountId: 'acct-1', activeMailbox: mailbox, mailboxScope: null,
    selectedEmail: email, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server',
    emails: [email], sortedEmails: [email], savedEmailIds: new Set(), archivedEmailIds: new Set(),
  });
  const { container } = render(<EmailViewer />);
  return within(container.querySelector('.email-action-bar'));
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EmailViewer on your own sent mail', () => {
  it('offers Reply on a received message', () => {
    const bar = renderViewer('INBOX');
    expect(bar.queryAllByRole('button', { name: /^Reply$/ })).toHaveLength(1);
  });

  it.each(['Sent', '[Gmail]/Sent Mail', 'Sent Items', 'INBOX.Sent'])('offers no Reply in %s', (mailbox) => {
    const bar = renderViewer(mailbox);
    expect(bar.queryAllByRole('button', { name: /^Reply$/ })).toHaveLength(0);
  });
});
