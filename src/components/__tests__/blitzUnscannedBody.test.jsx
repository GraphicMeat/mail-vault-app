// @vitest-environment jsdom

// A body the daemon did not scan (body.scan failed or ran out of time: the
// daemon is busy right after a new-mail banner is clicked) is still drawn.
// The iframe frames it with remote images refused (UNSCANNED_HEAD); Blitz drew
// nothing at all, so the clicked message opened to an empty reader. Blitz
// draws it with remote fetches off, the same refusal.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

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
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: () => null }));
// Every scan here fails: the answer the real scanBody gives on a timeout or an error.
vi.mock('../../services/bodyScan', async (orig) => {
  const { stubBodyScan, bodyScanAnswer } = await import('../../test/bodyScan');
  return stubBodyScan(orig, (html) => bodyScanAnswer(html, { scanned: false }));
});

const { useMailStore } = await import('../../stores/mailStore');
const { useThemeStore } = await import('../../stores/themeStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { registerBodyRenderer, _resetBodyRenderersForTest } = await import('../email/bodyRendererRegistry');
const { EmailViewer } = await import('../EmailViewer');
const { FullViewEmailModal } = await import('../email/FullViewEmailModal');
const { OriginalFrame } = await import('../OriginalFrame');
const { EmailPreviewFrame } = await import('../email/EmailPreviewFrame');

const seen = [];
const StubBody = React.forwardRef(function StubBody(p, _ref) {
  seen.push(p);
  return <div data-testid="alt-body" />;
});

const email = {
  uid: 7, _accountId: 'acct-1', _mailbox: 'INBOX', subject: 'Just arrived',
  from: { name: 'A', address: 'a@example.test' }, to: [{ address: 'me@example.test' }],
  html: '<p>Arrived body <img src="https://tracker.test/p.gif"></p>', text: 'Arrived body', attachments: [], flags: ['\\Seen'], date: '2026-11-07',
};

beforeEach(() => {
  registerBodyRenderer('blitz', { Body: StubBody });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({
    emailViewerTheme: 'system', linkSafetyEnabled: true, linkSafetyClickConfirm: true,
    threadReaderLayout: 'timeline', signatureDisplay: 'smart', emailRenderer: 'blitz',
  });
});
afterEach(() => { cleanup(); seen.length = 0; vi.unstubAllGlobals(); _resetBodyRenderersForTest(); useSettingsStore.setState({ emailRenderer: 'web' }); });

const drawnWithRemoteOff = () => {
  expect(screen.getByTestId('alt-body')).toBeTruthy();
  expect(seen.at(-1).allowRemote).toBe(false);
};

describe('Blitz draws an unscanned body with remote content refused', () => {
  it('reader', () => {
    useMailStore.setState({
      accounts: [{ id: 'acct-1', email: 'me@example.test' }],
      activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null,
      selectedEmail: email, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server',
      emails: [email], sortedEmails: [email], savedEmailIds: new Set(), archivedEmailIds: new Set(),
    });
    render(<EmailViewer />);
    drawnWithRemoteOff();
    expect(seen.at(-1).bodyHtml).toContain('Arrived body');
  });

  it('full view', () => {
    render(<FullViewEmailModal email={email} onClose={() => {}} />);
    drawnWithRemoteOff();
  });

  it('original', () => {
    render(<OriginalFrame html="<p>Quoted</p>" title="t" message={{ messageId: '<q@x>' }} />);
    drawnWithRemoteOff();
  });

  it('preview', () => {
    render(<EmailPreviewFrame html="<p>Snapshot</p>" title="t" message={{ uid: 5 }} />);
    drawnWithRemoteOff();
  });
});
