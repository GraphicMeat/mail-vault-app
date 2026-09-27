// @vitest-environment jsdom
//
// Download modes (H5): a thread message with no body here yet shows the
// search index's snippet (the loader's `snippet` on a still-loading entry)
// with a marker, instead of a bare spinner. Same mocks as
// ThreadViewQuickReplies.test.jsx.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { bodies } = vi.hoisted(() => ({ bodies: new Map() }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 144,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: index * 72 })),
}) }));
vi.mock('../../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: bodies }, registerListener: () => () => {} }) };
});
vi.mock('../EmailActionBar', () => ({ EmailActionBar: () => null }));
vi.mock('../../../utils/replyTarget', () => ({ replyTarget: async (header) => header }));
vi.mock('../../../services/daemonClient', () => ({ daemonCall: vi.fn() }));

const { ThreadView } = await import('../ThreadView');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { emailKey } = await import('../../../stores/slices/unifiedHelpers');

const older = {
  uid: 1, _mailbox: 'INBOX', _accountId: 'acct', date: '2026-09-01T10:00:00Z',
  from: { name: 'Ann', address: 'ann@example.com' }, to: [{ address: 'me@example.com' }],
  subject: 'Lunch', messageId: '<m1@x>',
};
const newest = {
  uid: 2, _mailbox: 'INBOX', _accountId: 'acct', date: '2026-09-02T10:00:00Z',
  from: { name: 'Ann', address: 'ann@example.com' }, to: [{ address: 'me@example.com' }],
  subject: 'Re: Lunch', inReplyTo: '<m1@x>', messageId: '<m2@x>',
};
const thread = { threadId: 'lunch', subject: 'Lunch', emails: [older, newest], messageCount: 2 };

afterEach(() => { cleanup(); bodies.clear(); });

describe('ThreadView on the index snippet', () => {
  it('shows a still-loading message as its snippet with the marker', () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first' });
    bodies.set(emailKey(older), { status: 'loaded', email: { ...older, text: 'Lunch tomorrow?' } });
    bodies.set(emailKey(newest), { status: 'loading', email: null, snippet: 'Does Tuesday at noon' });
    render(<ThreadView thread={thread} />);
    expect(screen.getByText('Does Tuesday at noon')).toBeTruthy();
    expect(screen.getByTestId('thread-body-loading')).toBeTruthy();
  });

  it('keeps the spinner when the index has no snippet', () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first' });
    bodies.set(emailKey(older), { status: 'loaded', email: { ...older, text: 'Lunch tomorrow?' } });
    bodies.set(emailKey(newest), { status: 'loading', email: null });
    render(<ThreadView thread={thread} />);
    expect(screen.queryByTestId('thread-body-loading')).toBeNull();
  });
});
