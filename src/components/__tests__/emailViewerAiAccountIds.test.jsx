// @vitest-environment jsdom
//
// The viewer's Summarize says whose mail it sends: the open message's account,
// or the account being read when the message carries none (a single-account
// folder). The daemon refuses a cloud endpoint for a request that names no
// account, so a caller that forgets this breaks Summarize for everyone.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const captured = { props: null };
vi.mock('../ai/AiComposeActions', () => ({ AiComposeActions: (props) => { captured.props = props; return null; } }));
vi.mock('../email/QuickReplyChips', () => ({ QuickReplyChips: () => null }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 700,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: 0 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: new Map() }, registerListener: () => () => {} }) };
});

const { useMailStore } = await import('../../stores/mailStore');
const { useThemeStore } = await import('../../stores/themeStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { EmailViewer } = await import('../EmailViewer');

const HEADER = {
  uid: 5, _mailbox: 'INBOX', subject: 'Does Tuesday work?', messageId: '<m5@x>', text: 'Does Tuesday at noon work for you?',
  from: { name: 'Ann', address: 'ann@example.test' }, to: [{ address: 'me@example.test' }],
  flags: ['\\Seen'], date: '2026-09-26',
};

function renderViewer(selectedEmail) {
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({ emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline', signatureDisplay: 'smart' });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }, { id: 'acct-2', email: 'me@gmail.com' }],
    activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null,
    selectedEmail, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server',
    emails: [selectedEmail], sortedEmails: [selectedEmail], savedEmailIds: new Set(), archivedEmailIds: new Set(),
  });
  return render(<EmailViewer onComposeReply={vi.fn()} />);
}

beforeEach(() => {
  captured.props = null;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EmailViewer Summarize names the account of the mail it sends', () => {
  it('passes the open message\'s own account', () => {
    renderViewer({ ...HEADER, _accountId: 'acct-2' });
    expect(captured.props.accountIds).toEqual(['acct-2']);
  });

  it('falls back to the account being read for a message that carries none', () => {
    renderViewer(HEADER);
    expect(captured.props.accountIds).toEqual(['acct-1']);
  });
});
