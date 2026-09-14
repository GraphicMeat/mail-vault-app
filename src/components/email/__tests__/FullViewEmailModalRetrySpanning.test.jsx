// @vitest-environment jsdom

// Bug report (2026-09-14): FullViewEmailModal's initial-fetch effect called
// `selectEmail(initialEmail.uid, initialEmail.source || 'server')` - a bare
// uid. In a spanning view (All Inboxes, a folder branch) `requireUnifiedContext`
// refuses that and the modal never gets its body, exactly the same defect as
// EmailViewer's retry button (EmailViewerRetrySpanning.test.jsx). The fix
// reads the row's own `_accountId`/`_mailbox` the way EmailRow's `openRow`
// does, and only in a spanning view.
//
// Rendered with the real stores (mocks limited to the virtualizer and body
// loader), same pattern as emailPalette.test.jsx: what matters here is the
// exact first argument the effect hands to `selectEmail`.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useMailStore } from '../../../stores/mailStore';
import { useThemeStore } from '../../../stores/themeStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { FullViewEmailModal } from '../FullViewEmailModal';

vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 700,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: 0 })),
}) }));
vi.mock('../../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: emails => ({
    bodiesMapRef: { current: new Map(emails.map(email => [emailKey(email), { status: 'loaded', email }])) },
    registerListener: () => () => {},
  }) };
});

// No html/text: fails the modal's `hasContent` check, so the mount effect
// runs `selectEmail(initialEmail.uid, initialEmail.source || 'server')`.
const initialEmail = {
  uid: 282, _accountId: 'acct-1', _mailbox: 'Sent', source: 'local', subject: 'didelis laiskas',
  from: { name: 'Sender', address: 'sender@example.test' }, to: [{ address: 'me@example.test' }],
  attachments: [], flags: [], date: '2026-09-07',
};

function renderModal(mockSelectEmail) {
  useThemeStore.setState({ palette: 'graphite', theme: 'dark' });
  useSettingsStore.setState({ emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline', signatureDisplay: 'smart' });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'sender@example.test' }],
    activeAccountId: 'acct-1',
    selectedEmail: null,
    selectedThread: null,
    loadingEmail: false,
    selectedEmailSource: null,
    emails: [],
    sortedEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    selectEmail: mockSelectEmail,
  });
  return render(<FullViewEmailModal email={initialEmail} onClose={() => {}} />);
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('FullViewEmailModal initial fetch, spanning vs. single-folder', () => {
  it('sends the full selection key in a spanning view (All Inboxes)', () => {
    const mockSelectEmail = vi.fn();
    useMailStore.setState({ activeMailbox: 'UNIFIED', mailboxScope: null });
    renderModal(mockSelectEmail);

    expect(mockSelectEmail).toHaveBeenCalledTimes(1);
    expect(mockSelectEmail.mock.calls[0][0]).toBe('acct-1:Sent:282');
    expect(mockSelectEmail.mock.calls[0][1]).toBe('local');
  });

  it('keeps sending the bare uid in a single-folder view (unchanged today)', () => {
    const mockSelectEmail = vi.fn();
    useMailStore.setState({ activeMailbox: 'INBOX', mailboxScope: null });
    renderModal(mockSelectEmail);

    expect(mockSelectEmail).toHaveBeenCalledTimes(1);
    expect(mockSelectEmail.mock.calls[0][0]).toBe(282);
    expect(mockSelectEmail.mock.calls[0][1]).toBe('local');
  });
});
