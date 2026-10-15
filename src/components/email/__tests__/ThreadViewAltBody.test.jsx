// @vitest-environment jsdom
import React, { forwardRef, useImperativeHandle } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

const { bodies, seen, mounts, autosized } = vi.hoisted(() => ({ bodies: new Map(), seen: [], autosized: [], mounts: { count: 0, unmounts: 0 } }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 144,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: index * 72 })),
}) }));
vi.mock('../../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: bodies }, registerListener: () => () => {} }) };
});
vi.mock('../../../utils/emailIframeTemplate', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, attachEmailIframeAutoSize: (frame, ...rest) => { autosized.push(frame); return actual.attachEmailIframeAutoSize(frame, ...rest); } };
});
vi.mock('../EmailActionBar', () => ({ EmailActionBar: (p) => (
  <div><button onClick={() => p.onReply()}>bar-reply</button><button onClick={() => p.onOpenInWindow()}>bar-window</button></div>
) }));
vi.mock('../../../utils/replyTarget', () => ({ replyTarget: async (header, _l, _s, selectedHtml) => ({ ...header, selectedHtml }) }));
vi.mock('../../../services/daemonClient', () => ({ daemonCall: vi.fn() }));

const { ThreadView } = await import('../ThreadView');
const { registerBodyRenderer, _resetBodyRenderersForTest } = await import('../bodyRendererRegistry');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { usePrivacyStore } = await import('../../../stores/privacyStore');
const { useThemeStore } = await import('../../../stores/themeStore');
const { emailKey, emailScopeKey } = await import('../../../stores/slices/unifiedHelpers');
const { useMailStore } = await import('../../../stores/mailStore');
const { isTrackerBlockingActive } = await import('../../../stores/settingsStore');
const { frameBody } = await import('../../../stores/netActivityStore');
const { scanEmailLinks } = await import('../../../utils/linkSafety');
const { getEmailBodyContent } = await import('../../../utils/emailIframeTemplate');
const { replaceCidUrls } = await import('../../../services/attachmentUtils');
const newestHtml = '<p>Newest body</p><script>evil()</script>';

const Stub = forwardRef(function Stub(props, ref) {
  const layer = React.useRef(null);
  React.useEffect(() => { mounts.count += 1; return () => { mounts.unmounts += 1; }; }, []);
  // The handle is { selectionRoot(), selectionText() }; the text carries a newline the DOM text does not.
  useImperativeHandle(ref, () => ({ selectionRoot: () => layer.current, selectionText: () => 'picked text\nsecond line' }));
  seen.push(props);
  return (
    <div data-testid="alt-body">
      <div ref={layer} data-testid="alt-text-layer"><span>picked text</span></div>
      <button onClick={() => props.onLink({ href: 'mailto:x@y.z', text: 'x', alert: null, title: null })}>alt-mailto</button>
      <button onClick={() => props.onLink({ href: 'https://evil.test/', text: 'bank.com', alert: 'red', title: 'Mismatch' })}>alt-phish</button>
    </div>
  );
});
const openWindow = vi.fn(async () => 'original-1');

const older = { uid: 1, _mailbox: 'INBOX', _accountId: 'acct', date: '2026-09-01T10:00:00Z', from: { name: 'Ann', address: 'ann@example.com' }, to: [{ address: 'me@example.com' }], subject: 'Lunch', messageId: '<m1@x>' };
const newest = { uid: 2, _mailbox: 'INBOX', _accountId: 'acct', date: '2026-09-02T10:00:00Z', from: { name: 'Ann', address: 'ann@example.com' }, to: [{ address: 'me@example.com' }], subject: 'Re: Lunch', inReplyTo: '<m1@x>', messageId: '<m2@x>' };
const thread = { threadId: 'lunch', subject: 'Lunch', emails: [older, newest], messageCount: 2 };

beforeEach(() => {
  registerBodyRenderer('blitz', { Body: Stub, openWindow });
  useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first', emailRenderer: 'blitz', emailViewerTheme: 'system', linkSafetyEnabled: true, linkSafetyClickConfirm: true, signatureDisplay: 'smart' });
  useThemeStore.setState({ theme: 'dark', palette: 'indigo' });
  bodies.set(emailKey(older), { status: 'loaded', email: { ...older, html: '<p>Older body</p>', text: 'Older body' } });
  bodies.set(emailKey(newest), { status: 'loaded', email: { ...newest, html: newestHtml, text: 'Newest body' } });
  window.__TAURI__ = { core: { invoke: vi.fn() } };
});
afterEach(() => { cleanup(); bodies.clear(); seen.length = 0; autosized.length = 0; openWindow.mockClear(); usePrivacyStore.setState({ enabled: false }); mounts.count = 0; mounts.unmounts = 0; _resetBodyRenderersForTest(); useSettingsStore.setState({ emailRenderer: 'web' }); delete window.__TAURI__; });

const last = () => seen.at(-1);

describe('ThreadView with an alternative body renderer', () => {
  it('draws the open message through Alt, never an iframe', () => {
    const { container } = render(<ThreadView thread={thread} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getAllByTestId('alt-body')).toHaveLength(1);
    const p = last();
    expect(p.surface).toBe('thread');
    expect(p.bodyHtml).toContain('Newest body');
    // Exactly the pre-processed body the iframe path renders (cid, tracker frame, link scan).
    const scopeKey = emailScopeKey(newest, useMailStore.getState());
    const framed = frameBody(getEmailBodyContent(replaceCidUrls(newestHtml, undefined)), scopeKey, isTrackerBlockingActive(useSettingsStore.getState())).body;
    expect(p.bodyHtml).toBe(scanEmailLinks(framed, scopeKey).modifiedBodyHtml);
    expect(p.indicatorCss).toBe(scanEmailLinks(framed, scopeKey).indicatorStyle);
    expect(p.sizing).toBe('content');
    expect(p.style).toEqual({ minHeight: 100 });
    expect(p.theme).toEqual({ dark: true, palette: 'indigo' });
    expect(p.foldQuotes).toBe(true);
    expect(p.signatureDisplay).toBe('smart');
    expect(p.message.uid).toBe(2);
    expect(p.messageKey).toBeTruthy();
  });

  it('web keeps the iframe', () => {
    useSettingsStore.setState({ emailRenderer: 'web' });
    const { container } = render(<ThreadView thread={thread} />);
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(screen.queryByTestId('alt-body')).toBeNull();
  });

  it('a red link raises link safety, as the iframe does', () => {
    render(<ThreadView thread={thread} />);
    fireEvent.click(screen.getByText('alt-phish'));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('read-only: mailto composes nothing', async () => {
    const mailto = await import('../../../utils/mailto');
    const spy = vi.spyOn(mailto, 'openMailtoCompose');
    render(<ThreadView thread={thread} readOnly />);
    fireEvent.click(screen.getByText('alt-mailto'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('Reply quotes the selection inside the Blitz text layer, and nothing outside it', async () => {
    const onComposeReply = vi.fn();
    render(<ThreadView thread={thread} onComposeReply={onComposeReply} />);
    const select = (node) => { const r = document.createRange(); r.selectNodeContents(node); const s = document.getSelection(); s.removeAllRanges(); s.addRange(r); };
    select(screen.getByText('picked text'));
    fireEvent.click(screen.getByText('bar-reply'));
    await waitFor(() => expect(onComposeReply).toHaveBeenCalledTimes(1));
    expect(onComposeReply.mock.calls[0][1].selectedHtml).toBe('picked text<br>second line');
    select(screen.getAllByTestId('thread-email-header')[0]);
    fireEvent.click(screen.getByText('bar-reply'));
    await waitFor(() => expect(onComposeReply).toHaveBeenCalledTimes(2));
    expect(onComposeReply.mock.calls[1][1].selectedHtml).toBe('');
  });

  it('collapse unmounts the body, re-expand mounts it again under the same messageKey (Review Focus 2)', () => {
    render(<ThreadView thread={thread} />);
    const key = last().messageKey;
    const headers = screen.getAllByTestId('thread-email-header');
    for (let i = 0; i < 10; i++) { act(() => { fireEvent.click(headers[1]); }); }
    // An even number of toggles: open again.
    expect(screen.getAllByTestId('alt-body')).toHaveLength(1);
    expect(mounts.unmounts).toBe(5);
    expect(last().messageKey).toBe(key);
  });

  it('a rejecting renderer window is not an unhandled rejection', async () => {
    // A plain function: a vi.fn() attaches its own handler to a returned promise and would hide the defect.
    let calls = 0;
    registerBodyRenderer('blitz', { Body: Stub, openWindow: () => { calls += 1; return Promise.reject(new Error('window failed')); } });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      render(<ThreadView thread={thread} />);
      fireEvent.click(screen.getByText('bar-window'));
      await new Promise(r => setTimeout(r, 20));
      expect(calls).toBe(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });

  it('Open in window goes to the renderer, not open_email_window', () => {
    render(<ThreadView thread={thread} />);
    fireEvent.click(screen.getByText('bar-window'));
    expect(openWindow).toHaveBeenCalledWith({ html: expect.stringContaining('Newest body'), dark: true, title: 'Re: Lunch' });
    expect(window.__TAURI__.core.invoke).not.toHaveBeenCalled();
  });

  it('Open in window under privacy is refused before the renderer is asked', () => {
    usePrivacyStore.setState({ enabled: true });
    render(<ThreadView thread={thread} />);
    fireEvent.click(screen.getByText('bar-window'));
    expect(openWindow).not.toHaveBeenCalled();
    expect(window.__TAURI__.core.invoke).not.toHaveBeenCalled();
  });

  it('switching blitz to web attaches the iframe handlers to the fresh iframe', () => {
    const { container } = render(<ThreadView thread={thread} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(autosized).toHaveLength(0);
    act(() => { useSettingsStore.setState({ emailRenderer: 'web' }); });
    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(autosized).toContain(frame);
  });
});
