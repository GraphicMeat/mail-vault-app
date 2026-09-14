// @vitest-environment jsdom

// Bug report (2026-09-14): the "Try again" button on a body-load failure
// (EmailViewer's `email-body-retry`) called `selectEmail(selectedEmail.uid,
// 'server')` - a bare uid. In a spanning view (All Inboxes, a folder branch)
// that is not a key: `requireUnifiedContext` refuses it and the retry throws
// the unresolved-row error instead of reloading the message. The fix reads
// the row's own `_accountId`/`_mailbox` the same way EmailRow's `openRow`
// does, and only in a spanning view - a plain single-folder retry keeps
// sending the bare uid it always has.
//
// Rendered with the real stores (mocks limited to the virtualizer and body
// loader), same pattern as emailPalette.test.jsx: what matters here is the
// exact first argument the click hands to `selectEmail`, not the workflow it
// triggers - that is already covered in
// selectEmailRetryOutsideLoadedList.test.js.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

// A message whose body fetch failed - html empty, _bodyError set - which is
// what renders the `email-body-error` block and its retry button.
const failedEmail = {
  uid: 282, _accountId: 'acct-1', _mailbox: 'Sent', subject: 'didelis laiskas',
  from: { name: 'Sender', address: 'sender@example.test' }, to: [{ address: 'me@example.test' }],
  html: '', text: '', attachments: [], flags: [], date: '2026-09-07', _bodyError: 'fetch failed',
};

function renderViewer(mockSelectEmail) {
  useThemeStore.setState({ palette: 'graphite', theme: 'dark' });
  useSettingsStore.setState({ emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline', signatureDisplay: 'smart' });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'sender@example.test' }],
    activeAccountId: 'acct-1',
    selectedEmail: failedEmail,
    selectedThread: null,
    loadingEmail: false,
    selectedEmailSource: 'header-only',
    emails: [failedEmail],
    sortedEmails: [failedEmail],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    selectEmail: mockSelectEmail,
  });
  return render(<EmailViewer />);
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EmailViewer body-error retry, spanning vs. single-folder', () => {
  it('sends the full selection key in a spanning view (All Inboxes)', () => {
    const mockSelectEmail = vi.fn();
    useMailStore.setState({ activeMailbox: 'UNIFIED', mailboxScope: null });
    renderViewer(mockSelectEmail);

    fireEvent.click(screen.getByTestId('email-body-retry'));

    expect(mockSelectEmail).toHaveBeenCalledTimes(1);
    expect(mockSelectEmail.mock.calls[0][0]).toBe('acct-1:Sent:282');
    expect(mockSelectEmail.mock.calls[0][1]).toBe('server');
  });

  it('keeps sending the bare uid in a single-folder view (unchanged today)', () => {
    const mockSelectEmail = vi.fn();
    useMailStore.setState({ activeMailbox: 'INBOX', mailboxScope: null });
    renderViewer(mockSelectEmail);

    fireEvent.click(screen.getByTestId('email-body-retry'));

    expect(mockSelectEmail).toHaveBeenCalledTimes(1);
    expect(mockSelectEmail.mock.calls[0][0]).toBe(282);
    expect(mockSelectEmail.mock.calls[0][1]).toBe('server');
  });
});
