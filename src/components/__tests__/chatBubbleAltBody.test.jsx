// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 300,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: index, start: index * 96 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: new Map() }, registerListener: () => () => {} }) };
});
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: () => null }));
const { ChatBubbleView, buildChatBubbleDocument, BUBBLE_FRAME_WIDTH } = await import('../ChatBubbleView');
const { registerBodyRenderer, _resetBodyRenderersForTest } = await import('../email/bodyRendererRegistry');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useThemeStore } = await import('../../stores/themeStore');
const { usePrivacyStore } = await import('../../stores/privacyStore');

const seen = [];
const Stub = (props) => { seen.push(props); return <div data-testid="alt-bubble"><button onClick={() => props.onLink({ href: 'https://evil.test/', text: 'bank', alert: 'red', title: 'Mismatch' })}>alt-phish</button></div>; };
const email = { uid: 7, _accountId: 'demo', _mailbox: 'INBOX', date: '2026-09-01', from: { name: 'Nell', address: 'nell@example.com' }, to: [], subject: 'Studio plans', html: '<p>Shall we meet at two?</p><script>x()</script>', text: 'Shall we meet at two?', flags: [] };
const show = () => render(<ChatBubbleView correspondent={{ name: 'Nell', email: 'nell@example.com' }}
  threadId="studio" threadsMap={new Map([['studio', { subject: 'Studio plans', emails: [email] }]])}
  userEmail="rowan@example.com" onBack={() => {}} />);
const unNonce = (s) => s.replace(/nonce-[A-Za-z0-9]+/g, 'nonce-N').replace(/nonce="[A-Za-z0-9]+"/g, 'nonce="N"');

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); useThemeStore.setState({ theme: 'dark', palette: 'indigo' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); seen.length = 0; _resetBodyRenderersForTest(); usePrivacyStore.setState({ enabled: false }); useSettingsStore.setState({ emailRenderer: 'web' }); });

describe('chat bubble on the body seam', () => {
  it('Blitz gets the exact document the iframe gets', () => {
    const { container, unmount } = show();
    const srcdoc = container.querySelector('iframe').getAttribute('srcdoc');
    unmount();
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    const view = show();
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(unNonce(seen.at(-1).documentHtml)).toBe(unNonce(srcdoc));
  });

  it('privacy on: the document Blitz gets still carries the gate, as the iframe does', () => {
    usePrivacyStore.setState({ enabled: true });
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    show();
    expect(seen.at(-1).documentHtml).toContain('mv-privacy-gate');
    expect(seen.at(-1).privacy).toBe(true);
  });

  it('bubble sizing, width rule, no Dark Reader', () => {
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    show();
    const p = seen.at(-1);
    expect(p.surface).toBe('bubble');
    expect(p.sizing).toEqual({ collapsedMax: 400 });
    expect(p.style).toEqual({ width: '100%', maxWidth: '100%', minHeight: 50 });
    expect(p.theme.dark).toBe(false);
    expect(p.foldQuotes).toBe(true);
    expect(p.message.uid).toBe(7);
  });

  // jsdom has no layout, so this pins the rule's tokens; the CSS reasoning is in the Task 6 fix report and
  // tests/e2e/connected-blitz-surfaces.test.js (bubble width vs iframe) is the real check.
  it('the wrapper fills the bubble and a 300 px strut gives it the iframe intrinsic width', () => {
    expect(BUBBLE_FRAME_WIDTH).toBe(300);
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    const { container } = show();
    const p = seen.at(-1);
    expect(p.className.split(/\s+/)).toEqual(expect.arrayContaining(['w-full', '[contain:inline-size]']));
    expect(p.className).not.toMatch(/w-\[300px\]/);
    const strut = container.querySelector('[data-bubble-strut]');
    expect(strut.style.width).toBe('300px');
    expect(strut.style.maxWidth).toBe('100%');
    expect(strut.style.height).toBe('0px');
    expect(strut.nextElementSibling).toBe(screen.getByTestId('alt-bubble'));
  });

  it('a red link raises link safety', () => {
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz', linkSafetyEnabled: true, linkSafetyClickConfirm: true });
    show();
    fireEvent.click(screen.getByText('alt-phish'));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('switching blitz to web attaches the iframe handlers to the fresh iframe', () => {
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    const { container } = show();
    expect(container.querySelector('iframe')).toBeNull();
    act(() => { useSettingsStore.setState({ emailRenderer: 'web' }); });
    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(typeof frame.onload).toBe('function');
  });

  it('buildChatBubbleDocument is the iframe template', () => {
    const out = buildChatBubbleDocument({ bodyHtml: '<p>x</p>', fromUser: true, theme: 'light', palette: 'graphite', indicatorStyle: '', privacy: false, signatureDisplay: 'smart', nonce: 'abc' });
    expect(out).toContain("script-src 'nonce-abc'");
    expect(out).toContain('background-color: transparent !important');
    expect(out).toContain('color: #ffffff');
  });
});
