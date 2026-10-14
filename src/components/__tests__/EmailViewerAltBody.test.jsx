// @vitest-environment jsdom

// The reader draws a registered alternative body (today: Blitz) instead of its
// iframe when the emailRenderer setting names one. This test registers a stub
// through the real registry, so it never imports the module itself.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMailStore } from '../../stores/mailStore';
import { useThemeStore } from '../../stores/themeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { registerBodyRenderer, _resetBodyRenderersForTest } from '../email/bodyRendererRegistry';
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

const last = { props: null };
// The reader hands the body a ref (the reply selection handle), so a body is a forwardRef.
const StubBody = React.forwardRef(function StubBody(p, _ref) {
  last.props = p;
  return (
    <div data-testid="alt-body">
      <button onClick={() => p.onLink({ href: 'https://evil.test/', alert: 'red', title: 'Mismatch', text: 'bank.com' })}>alt-link</button>
    </div>
  );
});

const mail = (uid) => ({
  uid, _accountId: 'acct-1', _mailbox: 'INBOX', subject: `S${uid}`,
  from: { name: 'A', address: 'a@example.test' }, to: [{ address: 'me@example.test' }],
  html: `<p>Body ${uid}</p>`, text: `Body ${uid}`, attachments: [], flags: ['\\Seen'], date: '2026-10-01',
});

function show(email, renderer) {
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({
    emailViewerTheme: 'system', linkSafetyEnabled: true, linkSafetyClickConfirm: true,
    threadReaderLayout: 'timeline', signatureDisplay: 'smart', emailRenderer: renderer,
  });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }],
    activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null,
    selectedEmail: email, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server',
    emails: [email], sortedEmails: [email], savedEmailIds: new Set(), archivedEmailIds: new Set(),
  });
  return render(<EmailViewer />);
}
const iframe = () => document.querySelector('iframe[srcdoc]');

beforeEach(() => {
  last.props = null;
  registerBodyRenderer('blitz', { Body: StubBody });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); _resetBodyRenderersForTest(); });

describe('EmailViewer alternative body seam', () => {
  it('web draws the iframe exactly as before', () => {
    show(mail(1), 'web');
    expect(iframe()).not.toBeNull();
    expect(screen.queryByTestId('alt-body')).toBeNull();
  });

  it('blitz draws the registered body and no iframe, with the contract props', () => {
    show(mail(1), 'blitz');
    expect(iframe()).toBeNull();
    expect(screen.getByTestId('alt-body')).toBeTruthy();
    expect(last.props.surface).toBe('reader');
    expect(last.props.bodyHtml).toContain('Body 1');
    expect(last.props.plainText).toBe('Body 1');
    expect(last.props.messageKey).toBeTruthy();
    expect(last.props.theme).toEqual(expect.objectContaining({ dark: false, palette: 'graphite' }));
    expect(last.props.sizing).toBe('content');
  });

  it('switching the setting with a message open swaps the renderer', async () => {
    show(mail(1), 'blitz');
    await act(async () => { useSettingsStore.getState().setEmailRenderer('web'); });
    expect(iframe()).not.toBeNull();
    expect(screen.queryByTestId('alt-body')).toBeNull();
  });

  it('an alt-body link goes through link safety like the iframe', () => {
    show(mail(1), 'blitz');
    fireEvent.click(screen.getByText('alt-link'));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});
