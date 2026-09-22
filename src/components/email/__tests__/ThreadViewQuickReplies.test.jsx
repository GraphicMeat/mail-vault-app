// @vitest-environment jsdom
//
// Quick Replies (Phase 5) and "Summarize thread" (Phase 6) on a REAL thread —
// the surface EmailViewer hands off to ThreadView whenever there is more
// than one message, and exactly the "person-to-person conversation" case
// the feature was designed for. Same mocking conventions as
// ThreadView.test.jsx (virtualizer, useChatBodyLoader, EmailActionBar,
// replyTarget) plus composeOpener/daemonClient for the seams this adds.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const { scrollToIndex, bodies } = vi.hoisted(() => ({ scrollToIndex: vi.fn(), bodies: new Map() }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex, measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 144,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: index * 72 })),
}) }));
vi.mock('../../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: bodies }, registerListener: () => () => {} }) };
});
vi.mock('../EmailActionBar', () => ({ EmailActionBar: () => null }));
vi.mock('../../../utils/replyTarget', () => ({ replyTarget: async (header) => header }));
vi.mock('../../../utils/composeOpener', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, openCompose: vi.fn() };
});
vi.mock('../../../services/daemonClient', () => ({ daemonCall: vi.fn() }));

const { ThreadView } = await import('../ThreadView');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { openCompose } = await import('../../../utils/composeOpener');
const { daemonCall } = await import('../../../services/daemonClient');

const AI_OFF = { enabled: false, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false };
const AI_ON = { enabled: true, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false };

const older = {
  uid: 1, _mailbox: 'INBOX', _accountId: 'acct', date: '2026-09-01T10:00:00Z',
  from: { name: 'Ann', address: 'ann@example.com' }, to: [{ address: 'me@example.com' }],
  subject: 'Lunch', text: 'Want to grab lunch tomorrow?', messageId: '<m1@x>',
};
const newest = {
  uid: 2, _mailbox: 'INBOX', _accountId: 'acct', date: '2026-09-02T10:00:00Z',
  from: { name: 'Ann', address: 'ann@example.com' }, to: [{ address: 'me@example.com' }],
  subject: 'Re: Lunch', text: 'Does Tuesday at noon work for you?', inReplyTo: '<m1@x>', messageId: '<m2@x>',
};
const thread = { threadId: 'lunch', subject: 'Lunch', emails: [older, newest], messageCount: 2 };

afterEach(() => {
  cleanup();
  bodies.clear();
  vi.clearAllMocks();
  useSettingsStore.setState({ dismissedQuickReplyThreads: {}, aiSettings: AI_OFF });
});

describe('Quick Reply chips in a real thread', () => {
  it('renders chips only under the newest message, not the older one', () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first', aiSettings: AI_OFF });
    render(<ThreadView thread={thread} />);
    expect(screen.getAllByTestId('quick-reply-chips')).toHaveLength(1);
    // Tier 1's proposed-time shape, read off the NEWEST message's text.
    expect(screen.getByText('That works for me')).toBeTruthy();
  });

  it('evaluates suppression against the newest message headers', () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first', aiSettings: AI_OFF });
    const automated = { ...newest, listUnsubscribe: '<mailto:off@list.test>' };
    render(<ThreadView thread={{ ...thread, emails: [older, automated] }} />);
    expect(screen.queryByTestId('quick-reply-chips')).toBeNull();
  });

  it('is suppressed the same way regardless of thread sort order (newest-first)', () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'newest-first', aiSettings: AI_OFF });
    render(<ThreadView thread={thread} />);
    expect(screen.getAllByTestId('quick-reply-chips')).toHaveLength(1);
  });

  it('dismissing hides the chips for the whole thread, keyed off the newest message', () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first', aiSettings: AI_OFF });
    const { rerender } = render(<ThreadView thread={thread} />);
    fireEvent.click(screen.getByLabelText('Dismiss quick replies'));
    rerender(<ThreadView thread={thread} />);
    expect(screen.queryByTestId('quick-reply-chips')).toBeNull();
    expect(useSettingsStore.getState().dismissedQuickReplyThreads['<m1@x>']).toBe(true);
  });

  it('opens Compose with the full thread as context, not just the newest message', () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first', aiSettings: AI_OFF });
    render(<ThreadView thread={thread} />);
    fireEvent.click(screen.getByText('That works for me'));
    expect(openCompose).toHaveBeenCalledTimes(1);
    const [arg] = openCompose.mock.calls[0];
    expect(arg.mode).toBe('reply');
    expect(arg.templateBody).toBe('That works for me');
    expect(arg.replyTo._threadContext.map(m => m.uid)).toEqual([1, 2]);
  });
});

describe('Tier 2 reads the thread, not just the newest message', () => {
  it('sends both messages to the provider, bounded — the reason it beats Tier 1 here', async () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first', aiSettings: AI_ON });
    daemonCall.mockResolvedValue({ text: 'Sounds good\nWorks for me\nLet me check' });
    render(<ThreadView thread={thread} />);
    await waitFor(() => expect(daemonCall).toHaveBeenCalledWith('ai.generate', expect.anything()));
    const [, params] = daemonCall.mock.calls.find(([method]) => method === 'ai.generate');
    expect(params.prompt).toContain('grab lunch tomorrow');
    expect(params.prompt).toContain('Tuesday at noon');
  });
});

describe('Summarize thread (thread view)', () => {
  it('previews and summarizes the real thread text spanning both messages', async () => {
    useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first', aiSettings: AI_ON });
    daemonCall.mockImplementation((method, params) => {
      if (method === 'ai.providers') return Promise.resolve([{ provider: 'localGguf', available: true, reason: '' }]);
      // Tier 2's own background generation (for the chips) hits the same
      // mock — keep its answer distinct so the assertions below can tell
      // the summary apart from a quick-reply chip reading the same text.
      if (method === 'ai.generate' && params?.prompt?.includes('Summarize')) {
        return Promise.resolve({ text: 'Ann and I are figuring out lunch time.' });
      }
      return Promise.resolve({ text: 'Sounds good' });
    });
    render(<ThreadView thread={thread} />);

    await waitFor(() => expect(screen.getByText('Summarize').disabled).toBe(false));
    fireEvent.click(screen.getByText('Summarize'));

    // The exact text about to be sent covers BOTH messages.
    const previewText = screen.getByTestId('ai-preview-text').textContent;
    expect(previewText).toContain('grab lunch tomorrow');
    expect(previewText).toContain('Tuesday at noon');

    fireEvent.click(screen.getByTestId('ai-preview-confirm'));
    await waitFor(() => expect(screen.getByTestId('ai-summary-panel')).toBeTruthy());
    expect(screen.getByText('Ann and I are figuring out lunch time.')).toBeTruthy();
  });
});
