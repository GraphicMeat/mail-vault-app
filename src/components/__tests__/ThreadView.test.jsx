// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
const { scrollToIndex } = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex, measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 144,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: index * 72 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: new Map() }, registerListener: () => () => {} }) };
});
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: () => null }));
const { ThreadView } = await import('../email/ThreadView');
const { useSettingsStore } = await import('../../stores/settingsStore');
const emails = [
  { uid: 7, _mailbox: 'INBOX', date: '2026-09-01', from: { name: 'Older', address: 'old@example.com' }, to: [], subject: 'Earlier' },
  { uid: 7, _mailbox: 'Sent', date: '2026-09-02', from: { name: 'Newest', address: 'new@example.com' }, to: [], subject: 'Latest' },
];
const thread = { threadId: 'one', subject: 'Conversation', emails, messageCount: 2 };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('thread reader layouts', () => {
  it('opens the newest full message identity and follows changes to sort order', () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first' });
    render(<ThreadView thread={thread} />);
    expect(scrollToIndex).toHaveBeenLastCalledWith(1, { align: 'start' });
    expect(screen.getAllByTestId('header-toggle').map(node => node.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
    act(() => useSettingsStore.setState({ threadSortOrder: 'newest-first' }));
    expect(scrollToIndex).toHaveBeenLastCalledWith(0, { align: 'start' });
    expect(screen.getAllByTestId('header-toggle').map(node => node.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
  });
  it('saves the layout and selects a different message in split view', () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first' });
    render(<ThreadView thread={thread} />);
    fireEvent.change(screen.getByLabelText('Layout'), { target: { value: 'split' } });
    expect(useSettingsStore.getState().threadReaderLayout).toBe('split');
    expect(screen.getByRole('button', { name: /Newest.*Latest/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Older.*Earlier/ }));
    expect(screen.getByRole('button', { name: /Older.*Earlier/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByTestId('sender-header')).toHaveLength(1);
  });
  it('expands a compact summary without composing a reply', () => {
    useSettingsStore.setState({ threadReaderLayout: 'compact', threadSortOrder: 'oldest-first' });
    const onComposeReply = vi.fn();
    render(<ThreadView thread={thread} onComposeReply={onComposeReply} />);
    fireEvent.click(screen.getByRole('button', { name: /Older.*Earlier/ }));
    expect(screen.getAllByTestId('header-toggle')).toHaveLength(2);
    expect(onComposeReply).not.toHaveBeenCalled();
  });
});
