// @vitest-environment jsdom

// Every reader of a message body (the reading pane, a thread, a chat bubble,
// the full view) runs the same link rule: the scan is asked for flagged links
// when link safety is on, a click on a flagged link raises the link-safety
// dialog when click confirmation is on, and opens the link when it is off.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '../../services/workflows/bindStoreActions';

const { bodies, opened } = vi.hoisted(() => ({ bodies: new Map(), opened: [] }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 300,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey ? options.getItemKey(index) : index, start: index * 96 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: bodies }, registerListener: () => () => {} }) };
});
vi.mock('../../services/bodyScan', async (orig) => {
  const { stubBodyScan } = await import('../../test/bodyScan');
  return stubBodyScan(orig);
});
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async (url) => { opened.push(url); } }));
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: () => null }));

const bodyScan = await import('../../services/bodyScan');
const { useMailStore } = await import('../../stores/mailStore');
const { useThemeStore } = await import('../../stores/themeStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { emailKey } = await import('../../stores/slices/unifiedHelpers');
const { EmailViewer } = await import('../EmailViewer');
const { ChatBubbleView } = await import('../ChatBubbleView');
const { ThreadView } = await import('../email/ThreadView');
const { FullViewEmailModal } = await import('../email/FullViewEmailModal');

// A fresh body per test: the scan stub answers a repeated (body, options) from its cache without recording it.
let run = 0;
const mail = (uid, body) => ({
  uid, _accountId: 'acct-1', _mailbox: 'INBOX', subject: `S${uid}`, messageId: `<m${uid}@x>`,
  from: { name: 'Nell', address: 'nell@example.test' }, to: [{ address: 'me@example.test' }],
  html: `<p>${body}</p>`, text: body, attachments: [], flags: ['\\Seen'], date: '2026-10-01T10:00:00Z',
});

const READERS = {
  reader: () => {
    const email = mail(1, `reader body ${run}`);
    useMailStore.setState({ selectedEmail: email, selectedThread: null, emails: [email], sortedEmails: [email] });
    render(<EmailViewer />);
    return `reader body ${run}`;
  },
  thread: () => {
    const email = mail(2, `thread body ${run}`);
    bodies.set(emailKey(email), { status: 'loaded', email });
    render(<ThreadView thread={{ threadId: 't', subject: 'S2', emails: [email], messageCount: 1 }} />);
    return `thread body ${run}`;
  },
  chat: () => {
    const email = mail(3, `chat body ${run}`);
    render(<ChatBubbleView correspondent={{ name: 'Nell', email: 'nell@example.test' }}
      threadId="t" threadsMap={new Map([['t', { subject: 'S3', emails: [email] }]])}
      userEmail="me@example.test" onBack={() => {}} />);
    return `chat body ${run}`;
  },
  fullView: () => {
    render(<FullViewEmailModal email={mail(4, `full body ${run}`)} onClose={() => {}} />);
    return `full body ${run}`;
  },
};

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

async function clickFlaggedLink() {
  await settle();
  const frame = document.querySelector('iframe');
  expect(frame).not.toBeNull();
  await act(async () => { fireEvent.load(frame); });
  const doc = frame.contentDocument;
  const link = doc.createElement('a');
  link.href = 'https://evil.test/login';
  link.setAttribute('data-link-alert', 'red');
  link.title = 'Mismatch';
  link.textContent = 'https://bank.test/login';
  doc.body.appendChild(link);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => { link.dispatchEvent(click); });
  await settle();
  return click;
}

beforeEach(() => {
  run += 1;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({
    emailViewerTheme: 'system', linkSafetyEnabled: true, linkSafetyClickConfirm: true,
    threadReaderLayout: 'timeline', signatureDisplay: 'smart', emailRenderer: 'web',
  });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }], activeAccountId: 'acct-1', activeMailbox: 'INBOX',
    mailboxScope: null, loadingEmail: false, selectedEmailSource: 'server', savedEmailIds: new Set(), archivedEmailIds: new Set(),
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); bodies.clear(); opened.length = 0; bodyScan.__scans.length = 0; });

describe.each(Object.keys(READERS))('%s', (name) => {
  it('asks the scan for flagged links when link safety is on', async () => {
    const body = READERS[name]();
    await settle();
    const asked = bodyScan.__scans.filter(scan => scan.html.includes(body));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(scan => scan.opts.links === true)).toBe(true);
  });

  it('does not ask for flagged links when link safety is off', async () => {
    useSettingsStore.setState({ linkSafetyEnabled: false });
    const body = READERS[name]();
    await settle();
    const asked = bodyScan.__scans.filter(scan => scan.html.includes(body));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.some(scan => scan.opts.links)).toBe(false);
  });

  it('a click on a flagged link raises the link-safety dialog, and opens nothing', async () => {
    READERS[name]();
    const click = await clickFlaggedLink();
    expect(click.defaultPrevented).toBe(true);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(opened).toEqual([]);
  });

  it('with click confirmation off the flagged link opens', async () => {
    useSettingsStore.setState({ linkSafetyClickConfirm: false });
    READERS[name]();
    const click = await clickFlaggedLink();
    expect(click.defaultPrevented).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(opened).toEqual(['https://evil.test/login']);
  });
});
