// @vitest-environment jsdom

// The reader's frame handlers (auto-size, the link click that runs link safety,
// the context menu) belong to whichever <iframe> is mounted. View Source swaps
// the frame for a <pre> and back with the same body, so a dependency on the
// body alone leaves the new frame with none of them: a click on a flagged link
// skips the warning.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { autosized } = vi.hoisted(() => ({ autosized: [] }));
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
vi.mock('../../utils/emailIframeTemplate', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, attachEmailIframeAutoSize: (frame, ...rest) => { autosized.push(frame); return actual.attachEmailIframeAutoSize(frame, ...rest); } };
});
vi.mock('../../services/bodyScan', async (orig) => {
  const { stubBodyScan } = await import('../../test/bodyScan');
  return stubBodyScan(orig);
});
vi.mock('../../services/db', async (importOriginal) => ({
  ...(await importOriginal()),
  getVerifiedRawSource: async () => ({ b64: btoa('Subject: raw bytes'), error: null }),
}));
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: p => <button onClick={() => p.onViewSource()}>bar-source</button> }));

const { useMailStore } = await import('../../stores/mailStore');
const { useThemeStore } = await import('../../stores/themeStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { EmailViewer } = await import('../EmailViewer');

const mail = (uid) => ({
  uid, _accountId: 'acct-1', _mailbox: 'INBOX', subject: `S${uid}`, messageId: `<m${uid}@x>`,
  from: { name: 'A', address: 'a@example.test' }, to: [{ address: 'me@example.test' }],
  html: `<p>Body ${uid}</p>`, text: `Body ${uid}`, attachments: [], flags: ['\\Seen'], date: '2026-10-01',
});

function show(email) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({
    emailViewerTheme: 'system', linkSafetyEnabled: true, linkSafetyClickConfirm: true,
    threadReaderLayout: 'timeline', signatureDisplay: 'smart', emailRenderer: 'web',
  });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }],
    activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null,
    selectedEmail: email, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server',
    emails: [email], sortedEmails: [email], savedEmailIds: new Set(), archivedEmailIds: new Set(),
  });
  return render(<EmailViewer />);
}

const frameNow = () => document.querySelector('iframe');
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const toggleSource = async () => {
  await act(async () => { fireEvent.click(screen.getByText('bar-source')); });
  await settle();
};

// The frame finishes loading, then its document holds a link the scan flagged.
async function flaggedLinkIn(frame) {
  await settle();
  await act(async () => { fireEvent.load(frame); });
  const doc = frame.contentDocument;
  const link = doc.createElement('a');
  link.href = 'https://evil.test/login';
  link.setAttribute('data-link-alert', 'red');
  link.title = 'Mismatch';
  link.textContent = 'https://bank.test/login';
  doc.body.appendChild(link);
  return link;
}

// All three together, so a red names every handler the frame is missing.
async function expectHandlersOn(frame) {
  const link = await flaggedLinkIn(frame);
  await act(async () => { fireEvent.click(link); });
  await act(async () => { fireEvent.contextMenu(link); });
  expect({
    autoSize: autosized.includes(frame),
    linkSafety: screen.queryByRole('alertdialog') !== null,
    contextMenu: frame.contentDocument.getElementById('mv-ctx-menu') !== null,
  }).toEqual({ autoSize: true, linkSafety: true, contextMenu: true });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); autosized.length = 0; });

describe('EmailViewer frame handlers follow the mounted frame', () => {
  it('the frame a message opens in has them', async () => {
    show(mail(1));
    await expectHandlersOn(frameNow());
  });

  it('View Source on and off: the new frame has them', async () => {
    show(mail(1));
    const first = frameNow();
    await toggleSource();
    expect(frameNow()).toBeNull();
    expect(screen.getByText('Subject: raw bytes')).toBeTruthy();
    await toggleSource();
    const second = frameNow();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    await expectHandlersOn(second);
  });

  it('moving to another message with the source open: the frame that returns has them', async () => {
    show(mail(1));
    await toggleSource();
    expect(frameNow()).toBeNull();
    await act(async () => { useMailStore.setState({ selectedEmail: mail(2) }); });
    await settle();
    const frame = frameNow();
    expect(frame).not.toBeNull();
    await expectHandlersOn(frame);
  });

  it('a theme change keeps the frame and does not tear the handlers down', async () => {
    show(mail(1));
    const frame = frameNow();
    const before = frame.getAttribute('srcdoc');
    const attaches = autosized.length;
    await act(async () => { useThemeStore.setState({ theme: 'dark' }); });
    await settle();
    // The document does change, so this tests a reload rather than a no-op.
    expect(frame.getAttribute('srcdoc')).not.toBe(before);
    expect(frameNow()).toBe(frame);
    expect(autosized).toHaveLength(attaches);
    await expectHandlersOn(frame);
  });
});
