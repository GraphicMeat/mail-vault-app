// @vitest-environment jsdom
//
// Privacy mode in the thread reader: each message frame starts gated, and
// "Open in window" is refused (the file:// window is out of reach of the
// masking pass) with a notice instead of opening.

import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const { bodies } = vi.hoisted(() => ({ bodies: new Map() }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 144,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: index * 72 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: bodies }, registerListener: () => () => {} }) };
});
vi.mock('../email/EmailActionBar', () => ({
  EmailActionBar: ({ onOpenInWindow }) => <button type="button" data-testid="open-window-stub" onClick={onOpenInWindow} />,
}));
vi.mock('../email/QuickReplyChips', () => ({ QuickReplyChips: () => null }));
vi.mock('../TagChips', () => ({ TagChips: () => null }));
vi.mock('../../services/workflows/threadReadTimer', () => ({
  startThreadReadTimer: vi.fn(async () => {}), stopThreadReadTimer: vi.fn(() => false), forgetThreadReadTimer: vi.fn(),
}));

const { ThreadView } = await import('../email/ThreadView');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useMailStore } = await import('../../stores/mailStore');
const { usePrivacyStore } = await import('../../stores/privacyStore');
const { t } = await import('../../i18n');

const email = { uid: 7, _mailbox: 'INBOX', date: '2026-09-01', from: { name: 'Older', address: 'old@example.com' }, to: [], subject: 'Earlier', flags: [] };
const thread = { threadId: 'one', subject: 'Conversation', emails: [email], messageCount: 1 };
const invoke = vi.fn(async () => {});

beforeEach(() => {
  useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first', emailViewerTheme: 'light' });
  bodies.set('|INBOX|7', { status: 'loaded', email: { uid: 7, html: '<p>Older body</p>', text: 'Older body' } });
  usePrivacyStore.setState({ enabled: true, peek: false });
  useMailStore.setState({ error: null });
  window.__TAURI__ = { core: { invoke } };
});
afterEach(() => {
  cleanup();
  bodies.clear();
  usePrivacyStore.setState({ enabled: false });
  delete window.__TAURI__;
  invoke.mockClear();
});

describe('ThreadView under privacy mode', () => {
  it('starts each message frame gated', () => {
    render(<ThreadView thread={thread} onComposeReply={vi.fn()} />);
    const doc = new DOMParser().parseFromString(document.querySelector('iframe').getAttribute('srcdoc'), 'text/html');
    expect(doc.head.querySelector('style#mv-privacy-gate')).not.toBeNull();
    expect(doc.documentElement.getAttribute('style')).toBe('opacity:0!important');
  });

  it('refuses "Open in window" with a notice', () => {
    render(<ThreadView thread={thread} onComposeReply={vi.fn()} />);
    fireEvent.click(screen.getAllByTestId('open-window-stub')[0]);
    expect(invoke.mock.calls.filter(([command]) => command === 'open_email_window')).toHaveLength(0);
    expect(useMailStore.getState().error).toBe(t('privacy.windowBlocked'));
  });

  it('control: with privacy off the window opens', () => {
    usePrivacyStore.setState({ enabled: false });
    render(<ThreadView thread={thread} onComposeReply={vi.fn()} />);
    fireEvent.click(screen.getAllByTestId('open-window-stub')[0]);
    expect(invoke.mock.calls.filter(([command]) => command === 'open_email_window')).toHaveLength(1);
  });
});
