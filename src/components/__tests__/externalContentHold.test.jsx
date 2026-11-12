// @vitest-environment jsdom
//
// "Ask before loading external content": with the setting on, opening a message
// loads nothing from elsewhere until the user says so. The claim is about what
// reaches the renderer, on every surface and in both renderers: the iframe's
// document carries a CSP that refuses it, and Blitz, which fetches images itself
// and answers to no CSP, is opened with allowRemote off. So this drives the real
// client (services/bodyScan) over every surface, with only the daemon stubbed.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../services/workflows/bindStoreActions';

vi.unmock('../../services/bodyScan');

const harness = vi.hoisted(() => ({ daemonCall: vi.fn() }));
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => harness.daemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 700,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey?.(index) ?? index, start: 0 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: emails => ({
    bodiesMapRef: { current: new Map((emails || []).map(email => [emailKey(email), { status: 'loaded', email }])) },
    registerListener: () => () => {},
  }) };
});
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: () => null }));

const { useMailStore } = await import('../../stores/mailStore');
const { useThemeStore } = await import('../../stores/themeStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { registerBodyRenderer, _resetBodyRenderersForTest } = await import('../email/bodyRendererRegistry');
const { _resetBodyScans } = await import('../../services/bodyScan');
const { EmailViewer } = await import('../EmailViewer');
const { ThreadView } = await import('../email/ThreadView');
const { FullViewEmailModal } = await import('../email/FullViewEmailModal');
const { ChatBubbleView } = await import('../ChatBubbleView');
const { OriginalFrame } = await import('../OriginalFrame');
const { EmailPreviewFrame } = await import('../email/EmailPreviewFrame');

const IMAGE = 'https://a.test/x.png';
const HELD_CSP = 'img-src data: blob: cid:';
const email = {
  uid: 5, _accountId: 'acct-1', _mailbox: 'INBOX', subject: 'Newsletter', date: '2026-09-26',
  from: { name: 'A', address: 'a@example.test' }, to: [{ address: 'me@example.test' }],
  attachments: [], flags: ['\\Seen'], html: `<p>Body</p><img src="${IMAGE}">`, text: 'Body',
};
const plain = { ...email, uid: 6, html: '<p>Nothing from elsewhere</p>' };

const SURFACES = {
  reader: (m) => {
    useMailStore.setState({ selectedEmail: m, selectedThread: null, emails: [m], sortedEmails: [m] });
    return <EmailViewer />;
  },
  thread: (m) => <ThreadView thread={{ threadId: 't', subject: m.subject, emails: [m], messageCount: 1 }} />,
  fullView: (m) => <FullViewEmailModal email={m} onClose={() => {}} />,
  chat: (m) => (
    <ChatBubbleView correspondent={{ name: 'A', email: 'a@example.test' }} threadId="t"
      threadsMap={new Map([['t', { subject: m.subject, emails: [m] }]])} userEmail="me@example.test" onBack={() => {}} />
  ),
  original: (m) => <OriginalFrame html={m.html} dark={false} title="Original" />,
  preview: (m) => <EmailPreviewFrame html={m.html} title="Preview" message={m} />,
};

const seen = [];
const StubBody = React.forwardRef(function StubBody(props, _ref) {
  seen.push(props);
  return <div data-testid="alt-body" />;
});
const srcdoc = () => document.querySelector('iframe[srcdoc]')?.getAttribute('srcdoc') ?? '';
const framed = () => waitFor(() => expect(srcdoc()).toContain('Body'));
const drawn = () => waitFor(() => expect(screen.getByTestId('alt-body')).toBeTruthy());
const scans = () => harness.daemonCall.mock.calls.filter(([m]) => m === 'body.scan');
const load = () => act(() => { fireEvent.click(screen.getByTestId('load-external-content')); });

beforeEach(() => {
  _resetBodyScans();
  seen.length = 0;
  harness.daemonCall.mockReset();
  harness.daemonCall.mockImplementation(async (method, p) => {
    if (method !== 'body.scan') return null;
    const remote = p.html.includes(IMAGE) ? 1 : 0;
    return { trackers: [], count: 0, https: remote, remote, summary: null, html: null, alerts: p.links ? [] : null, maxAlertLevel: null };
  });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({
    emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline', signatureDisplay: 'smart',
    emailRenderer: 'web', holdExternalContent: true,
  });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }], activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null,
    selectedEmail: null, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server',
    savedEmailIds: new Set(), archivedEmailIds: new Set(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  _resetBodyRenderersForTest();
  useSettingsStore.setState({ emailRenderer: 'web', holdExternalContent: false });
});

describe.each(Object.keys(SURFACES))('external content on the %s surface', (surface) => {
  const show = (m = email) => render(SURFACES[surface](m));

  it('the frame refuses it and offers the load, until the user takes it', async () => {
    show();
    await framed();
    expect(srcdoc()).toContain(HELD_CSP);
    expect(screen.getByTestId('external-content-bar')).toBeTruthy();

    load();

    await waitFor(() => expect(srcdoc()).not.toContain(HELD_CSP));
    expect(srcdoc()).toContain(IMAGE);
    expect(screen.queryByTestId('external-content-bar')).toBeNull();
  });

  it('Blitz is opened with remote off, until the user takes the load', async () => {
    registerBodyRenderer('blitz', { Body: StubBody });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    show();
    await drawn();
    expect(seen.at(-1).allowRemote).toBe(false);
    expect(screen.getByTestId('external-content-bar')).toBeTruthy();

    load();

    await waitFor(() => expect(seen.at(-1).allowRemote).toBe(true));
    expect(screen.queryByTestId('external-content-bar')).toBeNull();
  });

  it('the setting off leaves the frame and Blitz as they were, with no offer', async () => {
    useSettingsStore.setState({ holdExternalContent: false });
    const { unmount } = show();
    await framed();
    expect(srcdoc()).not.toContain(HELD_CSP);
    expect(screen.queryByTestId('external-content-bar')).toBeNull();
    unmount();

    registerBodyRenderer('blitz', { Body: StubBody });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    show();
    await drawn();
    expect(seen.at(-1).allowRemote).toBe(true);
  });

  it('a message with nothing external offers nothing', async () => {
    show(plain);
    await waitFor(() => expect(srcdoc()).toContain('Nothing from elsewhere'));
    expect(screen.queryByTestId('external-content-bar')).toBeNull();
  });
});

describe('the load', () => {
  it('asks the daemon nothing more: the answer it holds was never the block', async () => {
    render(SURFACES.reader(email));
    await framed();
    const asked = scans().length;
    load();
    await waitFor(() => expect(srcdoc()).not.toContain(HELD_CSP));
    expect(scans()).toHaveLength(asked);
  });

  it('covers the message it was asked for, and not the next one', async () => {
    const { rerender } = render(SURFACES.reader(email));
    await framed();
    load();
    await waitFor(() => expect(srcdoc()).not.toContain(HELD_CSP));

    const next = { ...email, uid: 9, html: `<p>Body nine</p><img src="${IMAGE}">` };
    rerender(SURFACES.reader(next));
    await waitFor(() => expect(srcdoc()).toContain('Body nine'));
    expect(srcdoc()).toContain(HELD_CSP);
    expect(screen.getByTestId('external-content-bar')).toBeTruthy();
  });

  it('turning the setting off releases a message already open', async () => {
    render(SURFACES.reader(email));
    await framed();
    act(() => useSettingsStore.setState({ holdExternalContent: false }));
    await waitFor(() => expect(srcdoc()).not.toContain(HELD_CSP));
    expect(screen.queryByTestId('external-content-bar')).toBeNull();
  });
});

describe('open in window', () => {
  const invoke = vi.fn();
  const windowHtml = () => invoke.mock.calls.filter(([c]) => c === 'open_email_window').at(-1)?.[1].html;
  const opened = async () => {
    await framed();
    await act(async () => { fireEvent.click(screen.getByTestId('open-in-window')); });
    await waitFor(() => expect(windowHtml()).toBeTruthy());
  };
  const show = () => {
    useMailStore.setState({ selectedEmail: email, selectedThread: null, emails: [email], sortedEmails: [email] });
    return render(<EmailViewer showOpenInWindow onClose={() => {}} />);
  };
  beforeEach(() => { invoke.mockClear(); window.__TAURI__ = { core: { invoke } }; });
  afterEach(() => { delete window.__TAURI__; });

  it('the file:// window inherits no CSP, so it carries the refusal itself', async () => {
    show();
    await opened();
    expect(windowHtml()).toContain(HELD_CSP);
  });

  it('a message the user loaded opens loaded', async () => {
    show();
    await framed();
    load();
    await waitFor(() => expect(srcdoc()).not.toContain(HELD_CSP));
    await opened();
    expect(windowHtml()).not.toContain(HELD_CSP);
  });
});
