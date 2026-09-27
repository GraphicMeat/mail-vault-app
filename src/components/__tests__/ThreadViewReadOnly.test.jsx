// @vitest-environment jsdom
//
// The compose pane reads the replied message's thread with ThreadView
// `readOnly`: the same reader, with nothing that acts. No action bar, quick
// actions, quick replies, tags or reply; no read timer (Track C); no selection,
// reply shortcut or store write. Folding still works, and the host picks the
// theme and the message shown open.

import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const { scrollToIndex, bodies, timers, opener, mutations } = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  bodies: new Map(),
  timers: { startThreadReadTimer: vi.fn(async () => {}), stopThreadReadTimer: vi.fn(() => false), forgetThreadReadTimer: vi.fn() },
  opener: { registerActiveReply: vi.fn(), openCompose: vi.fn() },
  mutations: { applyFlagToKeys: vi.fn(), purgeEverywhere: vi.fn() },
}));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex, measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 144,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: index * 72 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: bodies }, registerListener: () => () => {} }) };
});
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: () => <div data-testid="action-bar-stub" data-quick-action="reply" /> }));
vi.mock('../email/QuickReplyChips', () => ({ QuickReplyChips: () => <div data-testid="quick-replies-stub" /> }));
vi.mock('../TagChips', () => ({ TagChips: () => <div data-testid="tag-chips-stub" /> }));
vi.mock('../../utils/replyTarget', () => ({ replyTarget: async (header) => header }));
vi.mock('../../services/workflows/threadReadTimer', () => timers);
vi.mock('../../utils/composeOpener', () => opener);
vi.mock('../../services/workflows/messageMutations', () => mutations);

const { ThreadView } = await import('../email/ThreadView');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useMailStore } = await import('../../stores/mailStore');
const { useSelectionStore } = await import('../../stores/selectionStore');

const emails = [
  { uid: 7, _mailbox: 'INBOX', date: '2026-09-01', from: { name: 'Older', address: 'old@example.com' }, to: [], subject: 'Earlier', flags: [] },
  { uid: 7, _mailbox: 'Sent', date: '2026-09-02', from: { name: 'Newest', address: 'new@example.com' }, to: [], subject: 'Latest', flags: [] },
];
const thread = { threadId: 'one', subject: 'Conversation', emails, messageCount: 2 };
const expandedFlags = () => screen.getAllByTestId('header-toggle').map(n => n.getAttribute('aria-expanded'));
const frameTheme = () => new DOMParser()
  .parseFromString(document.querySelector('iframe').getAttribute('srcdoc'), 'text/html')
  .documentElement.getAttribute('data-mv-theme');

let spies = [];
beforeEach(() => {
  useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first', emailViewerTheme: 'light' });
  bodies.set('|INBOX|7', { status: 'loaded', email: { uid: 7, html: '<p>Older body</p>', text: 'Older body' } });
  bodies.set('|Sent|7', { status: 'loaded', email: { uid: 7, html: '<p>Newest body</p>', text: 'Newest body' } });
  spies = [
    vi.spyOn(useMailStore, 'setState'),
    vi.spyOn(useSelectionStore, 'setState'),
    vi.spyOn(useSettingsStore, 'setState'),
  ];
});
afterEach(() => {
  cleanup();
  bodies.clear();
  spies.forEach(spy => spy.mockRestore());
  vi.clearAllMocks();
});

describe('ThreadView readOnly', () => {
  it('renders no action bar, quick action, quick reply, tag or thread-level control', () => {
    render(<ThreadView thread={thread} readOnly onComposeReply={vi.fn()} />);

    expect(screen.getAllByTestId('thread-email-header')).toHaveLength(2);
    expect(screen.queryByTestId('action-bar-stub')).toBeNull();
    expect(document.querySelector('[data-quick-action]')).toBeNull();
    expect(screen.queryByTestId('quick-replies-stub')).toBeNull();
    expect(screen.queryByTestId('tag-chips-stub')).toBeNull();
    expect(screen.queryByLabelText('Layout')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    // Export, Archive All and Close act on the reader; none belong here.
    expect(screen.queryAllByRole('button').filter(b => /export|archive|close/i.test(`${b.title} ${b.textContent} ${b.getAttribute('aria-label') || ''}`))).toEqual([]);
    // The address is a reply target in the reader; here it offers none.
    for (const address of screen.getAllByTestId('sender-address')) expect(address.getAttribute('title')).toBeNull();
    // Inside the main window: a press on the header must not drag it.
    expect(document.querySelector('[data-tauri-drag-region]')).toBeNull();
  });

  it('never replies, times a read, registers the reply shortcut, mutates or writes a store', async () => {
    const onComposeReply = vi.fn();
    render(<ThreadView thread={thread} readOnly onComposeReply={onComposeReply} />);

    await act(async () => { fireEvent.click(screen.getAllByTestId('sender-address')[0]); });
    // Folding still works, and folding is not reading either.
    fireEvent.click(screen.getAllByTestId('thread-email-header')[0]);
    fireEvent.click(screen.getAllByTestId('thread-email-header')[1]);

    expect(onComposeReply).not.toHaveBeenCalled();
    expect(timers.startThreadReadTimer).not.toHaveBeenCalled();
    expect(timers.stopThreadReadTimer).not.toHaveBeenCalled();
    expect(timers.forgetThreadReadTimer).not.toHaveBeenCalled();
    expect(opener.registerActiveReply).not.toHaveBeenCalled();
    expect(mutations.applyFlagToKeys).not.toHaveBeenCalled();
    expect(mutations.purgeEverywhere).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('still folds and unfolds', () => {
    render(<ThreadView thread={thread} readOnly />);
    expect(expandedFlags()).toEqual(['false', 'true']);
    fireEvent.click(screen.getAllByTestId('thread-email-header')[0]);
    expect(expandedFlags()).toEqual(['true', 'true']);
    fireEvent.click(screen.getAllByTestId('thread-email-header')[1]);
    expect(expandedFlags()).toEqual(['true', 'false']);
  });

  it('control: the same thread without readOnly does time the read and register the reply', () => {
    render(<ThreadView thread={thread} onComposeReply={vi.fn()} />);
    expect(timers.startThreadReadTimer).toHaveBeenCalled();
    expect(opener.registerActiveReply).toHaveBeenCalled();
    expect(screen.getAllByTestId('action-bar-stub').length).toBeGreaterThan(0);
  });

  it('opens the message the host names instead of the newest', () => {
    render(<ThreadView thread={thread} readOnly openEmailKey="|INBOX|7" />);
    expect(expandedFlags()).toEqual(['true', 'false']);
    expect(scrollToIndex).toHaveBeenLastCalledWith(0, { align: 'start' });
  });

  it('renders the body in the theme the host pins, over the email theme setting', () => {
    const view = render(<ThreadView thread={thread} readOnly emailThemeDark />);
    expect(frameTheme()).toBe('dark');
    view.rerender(<ThreadView thread={thread} readOnly emailThemeDark={false} />);
    expect(frameTheme()).toBe('light');
  });

  it('shows a body the host handed over while the loader has none', () => {
    bodies.clear();
    bodies.set('|INBOX|9', { status: 'loading', email: null });
    const lone = { uid: 9, _mailbox: 'INBOX', date: '2026-09-03', from: { name: 'Them', address: 'them@example.com' }, to: [], subject: 'Lone', html: '<p>Handed body</p>', text: 'Handed body', _bodyLoaded: true };
    render(<ThreadView thread={{ threadId: 'lone', subject: 'Lone', emails: [lone], messageCount: 1 }} readOnly />);

    expect(screen.queryByRole('status', { name: /Loading message/ })).toBeNull();
    expect(document.querySelector('iframe').getAttribute('srcdoc')).toContain('Handed body');
  });
});
