// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: (p) => <button onClick={() => p.onOpenInWindow?.()}>bar-window</button> }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 700,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: 0 })),
}) }));
const { EmailViewer } = await import('../EmailViewer');
const { registerBodyRenderer, _resetBodyRenderersForTest } = await import('../email/bodyRendererRegistry');
const { useMailStore } = await import('../../stores/mailStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useThemeStore } = await import('../../stores/themeStore');
const { usePrivacyStore } = await import('../../stores/privacyStore');

const openWindow = vi.fn(async () => 'original-1');
const mail = { uid: 1, _accountId: 'acct-1', _mailbox: 'INBOX', subject: 'Pop me', from: { name: 'A', address: 'a@example.test' }, to: [{ address: 'me@example.test' }], html: '<p>Pop body</p>', text: 'Pop body', attachments: [], flags: ['\\Seen'], date: '2026-10-01' };
function show(settings) {
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({ emailViewerTheme: 'system', ...settings });
  useMailStore.setState({ accounts: [{ id: 'acct-1', email: 'me@example.test' }], activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null, selectedEmail: mail, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server', emails: [mail], sortedEmails: [mail], savedEmailIds: new Set(), archivedEmailIds: new Set() });
  return render(<EmailViewer />);
}
beforeEach(() => {
  window.__TAURI__ = { core: { invoke: vi.fn() } };
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  registerBodyRenderer('blitz', { Body: () => <div />, openWindow });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.__TAURI__; openWindow.mockClear(); _resetBodyRenderersForTest(); usePrivacyStore.setState({ enabled: false }); useSettingsStore.setState({ emailRenderer: 'web' }); });

describe('Open in window', () => {
  it('blitz: hands the pre-processed body to the renderer window', () => {
    show({ emailRenderer: 'blitz' });
    fireEvent.click(screen.getByText('bar-window'));
    expect(openWindow).toHaveBeenCalledWith({ html: expect.stringContaining('Pop body'), dark: false, title: 'Pop me' });
    expect(window.__TAURI__.core.invoke).not.toHaveBeenCalledWith('open_email_window', expect.anything());
  });
  it('web: the file:// window as today', () => {
    show({ emailRenderer: 'web' });
    fireEvent.click(screen.getByText('bar-window'));
    expect(openWindow).not.toHaveBeenCalled();
    expect(window.__TAURI__.core.invoke).toHaveBeenCalledWith('open_email_window', expect.objectContaining({ title: 'Pop me' }));
  });
  it('blitz: privacy mode refuses the window before the renderer sees the body', () => {
    usePrivacyStore.setState({ enabled: true });
    show({ emailRenderer: 'blitz' });
    fireEvent.click(screen.getByText('bar-window'));
    expect(openWindow).not.toHaveBeenCalled();
  });
  it('blitz: without Tauri nothing opens', () => {
    show({ emailRenderer: 'blitz' });
    delete window.__TAURI__;
    fireEvent.click(screen.getByText('bar-window'));
    expect(openWindow).not.toHaveBeenCalled();
  });
});
