// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMailStore } from '../../stores/mailStore';
import { useThemeStore } from '../../stores/themeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { EmailViewer } from '../EmailViewer';
import { FullViewEmailModal } from '../email/FullViewEmailModal';
import { ThreadView } from '../email/ThreadView';

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
const email = { uid: 901, _accountId: 'test', _mailbox: 'INBOX', subject: 'Palette example',
  from: { name: 'Sender', address: 'sender@example.test' }, to: [{ address: 'me@example.test' }],
  html: '<div style="background:#ffffff;color:#222222">A light email</div>', text: 'A plain email', attachments: [], flags: ['\\Seen'], date: '2026-09-07' };
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useMailStore.setState({ accounts: [{ id: 'test', email: 'me@example.test' }], activeAccountId: 'test', activeMailbox: 'INBOX', selectedEmail: email, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server', emails: [email], sortedEmails: [email], savedEmailIds: new Set(), archivedEmailIds: new Set() });
  useThemeStore.setState({ palette: 'graphite', theme: 'dark' });
  useSettingsStore.setState({ emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline', signatureDisplay: 'smart' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const frameOptions = () => {
  const html = document.querySelector('iframe').getAttribute('srcdoc');
  const match = html.match(/window\.DarkReader\.enable\((\{.*?\})\);/);
  return match ? JSON.parse(match[1]) : null;
};

for (const view of ['single', 'thread', 'expanded']) {
  describe(`${view} email palette`, () => {
    function open() {
      return render(view === 'single' ? <EmailViewer /> : view === 'expanded' ? <FullViewEmailModal email={email} onClose={() => {}} />
        : <ThreadView thread={{ threadId: 't', subject: email.subject, emails: [email], messageCount: 1 }} />);
    }
    it('updates the rendered email when the palette changes', () => {
      open();
      expect(frameOptions().darkSchemeBackgroundColor).toBe('#121313');
      act(() => useThemeStore.getState().setPalette('indigo'));
      expect(frameOptions().darkSchemeBackgroundColor).toBe('#0a0a12');
    });
    it('honors forced dark mode in a light app and lets the reader switch this message to light', () => {
      useThemeStore.setState({ theme: 'light' });
      useSettingsStore.setState({ emailViewerTheme: 'dark' });
      open();
      expect(frameOptions().darkSchemeBackgroundColor).toBe('#121313');
      fireEvent.click(screen.getByRole('button', { name: 'Light', exact: true }));
      expect(frameOptions()).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Dark', exact: true }));
      expect(frameOptions().darkSchemeBackgroundColor).toBe('#121313');
    });
  });
}
it('paints plain text with the same Graphite background as HTML', () => {
  useMailStore.setState({ selectedEmail: { ...email, html: '' } });
  render(<EmailViewer />);
  expect(document.querySelector('.email-plain-body').style.backgroundColor).toBe('rgb(18, 19, 19)');
});
