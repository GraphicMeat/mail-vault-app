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
vi.mock('../../utils/replyTarget', () => ({ replyTarget: async (header) => header }));
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

describe('thread message click targets', () => {
  // The thread reader is a list of messages: a click on a message opens or
  // shuts it, and only the sender's address writes back to him.
  const expandedFlags = () => screen.getAllByTestId('header-toggle').map(n => n.getAttribute('aria-expanded'));

  it('a click on a folded message unfolds it instead of composing', () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first' });
    const onComposeReply = vi.fn();
    render(<ThreadView thread={thread} onComposeReply={onComposeReply} />);
    expect(expandedFlags()).toEqual(['false', 'true']);
    fireEvent.click(screen.getAllByTestId('thread-email-header')[0]);
    expect(expandedFlags()).toEqual(['true', 'true']);
    expect(onComposeReply).not.toHaveBeenCalled();
  });

  it('a click on an unfolded message folds it again', () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first' });
    render(<ThreadView thread={thread} onComposeReply={vi.fn()} />);
    fireEvent.click(screen.getAllByTestId('thread-email-header')[1]);
    expect(expandedFlags()).toEqual(['false', 'false']);
  });

  it('a click on the sender address composes to THAT message', async () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first' });
    const onComposeReply = vi.fn();
    render(<ThreadView thread={thread} onComposeReply={onComposeReply} />);
    await act(async () => { fireEvent.click(screen.getAllByTestId('sender-address')[0]); });
    expect(onComposeReply).toHaveBeenCalledTimes(1);
    expect(onComposeReply.mock.calls[0][0]).toBe('reply');
    expect(onComposeReply.mock.calls[0][1].from.address).toBe('old@example.com');
    // Composing left the message folded — the two acts are independent.
    expect(expandedFlags()).toEqual(['false', 'true']);
  });
});
