// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 300,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: index, start: index * 96 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: new Map() }, registerListener: () => () => {} }) };
});
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: () => null }));
const { ChatBubbleView } = await import('../ChatBubbleView');
const { useThemeStore } = await import('../../stores/themeStore');
const { getEmailColors } = await import('../../utils/mailChrome');
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('chat HTML theme', () => {
  it('renders an HTML message and updates iframe colors when appearance changes', () => {
    useThemeStore.setState({ theme: 'light', palette: 'graphite' });
    const email = { uid: 7, _accountId: 'demo', _mailbox: 'INBOX', date: '2026-09-01',
      from: { name: 'Nell', address: 'nell@example.com' }, to: [], subject: 'Studio plans',
      html: '<p>Shall we meet at two?</p>', text: 'Shall we meet at two?', flags: [] };
    const { container } = render(<ChatBubbleView correspondent={{ name: 'Nell', email: 'nell@example.com' }}
      threadId="studio" threadsMap={new Map([['studio', { subject: 'Studio plans', emails: [email] }]])}
      userEmail="rowan@example.com" onBack={() => {}} />);
    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('srcdoc')).toContain('Shall we meet at two?');
    expect(frame.getAttribute('srcdoc')).toContain(getEmailColors('light', 'graphite').text);
    act(() => useThemeStore.setState({ theme: 'dark', palette: 'indigo' }));
    expect(frame.getAttribute('srcdoc')).toContain(getEmailColors('dark', 'indigo').text);
  });
});
