// @vitest-environment jsdom
//
// Mark-as-read in the thread reader. The single-message reader marks what it
// opens (selectEmail's _autoMarkRead); the thread reader shows several
// messages at once and used to mark none of them. Rule: every expanded unread
// message runs its own countdown, keyed by message, for as long as it stays
// expanded in the thread it was opened in. `auto` marks on expand, `delay`
// after markAsReadDelay seconds, `manual` never.
//
// Driven through the rendered reader against the real store: what is under
// test is which server writes happen, and those only come out of the whole
// chain (expand -> countdown -> flag core -> server).
import React, { createElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const { mockUpdateEmailFlags, mockGetLocalEmailLight } = vi.hoisted(() => ({
  mockUpdateEmailFlags: vi.fn(),
  mockGetLocalEmailLight: vi.fn(),
}));

vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 400,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({
    index, key: options.getItemKey ? options.getItemKey(index) : index, start: index * 72,
  })),
}) }));
vi.mock('../../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: new Map() }, registerListener: () => () => {} }) };
});
vi.mock('../../../components/email/EmailActionBar', () => ({ EmailActionBar: () => null }));
vi.mock('../../../utils/replyTarget', () => ({ replyTarget: async (header) => header }));
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal()),
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  queueOp: vi.fn().mockResolvedValue(1),
  clearOps: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal()),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  vaultApplyFlags: vi.fn().mockResolvedValue({ renamed: 0 }),
  fetchEmailLight: vi.fn().mockRejectedValue(new Error('no fetch in this suite')),
}));
vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
vi.mock('../../attachmentUtils', async (importOriginal) => ({
  ...(await importOriginal()),
  hydrateInlineImages: (email) => Promise.resolve(email),
}));

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

const { ThreadView } = await import('../../../components/email/ThreadView');
const { ChatBubbleView } = await import('../../../components/ChatBubbleView');
const { useMailStore } = await import('../../../stores/mailStore');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { applyFlagToKeys } = await import('../messageMutations');

const ACCOUNT = { id: 'acct1', email: 'me@mock.test' };
const ACCOUNT_B = { id: 'acct2', email: 'other@mock.test' };

const row = (uid, day, flags = [], extra = {}) => ({
  uid, messageId: `m${uid}@mock`, date: `2026-09-${String(day).padStart(2, '0')}T10:00:00Z`,
  subject: 'Topic', from: { name: `Sender ${uid}`, address: `s${uid}@mock.test` },
  to: [{ address: 'me@mock.test' }], flags, ...extra,
});

function prime(emails, extra = {}) {
  useMailStore.setState({
    accounts: [ACCOUNT], activeAccountId: 'acct1', activeMailbox: 'INBOX', mailboxScope: null,
    emails, sortedEmails: emails, localEmails: [], sentEmails: [],
    selectedThread: null, selectedEmail: null, selectedEmailId: null, markReadProgress: null,
    selectedEmailIds: new Set(), emailCache: new Map(),
    ...extra,
  });
}

const threadOf = (threadId, emails) => ({
  threadId, subject: 'Topic', emails, messageCount: emails.length, lastEmail: emails[emails.length - 1],
});

function Reader() {
  const thread = useMailStore(s => s.selectedThread);
  return thread ? createElement(ThreadView, { thread }) : null;
}

function openThread(threadId, emails) {
  act(() => { useMailStore.getState().selectThread(threadOf(threadId, emails)); });
}

// Server \Seen writes, as "account/mailbox/uid", in the order they were sent.
const marked = () => mockUpdateEmailFlags.mock.calls
  .filter(c => c[2]?.includes('\\Seen') && c[3] === 'add')
  .map(c => `${c[0].id}/${c[4]}/${c[1]}`);

const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

// Headers in display order (oldest first).
const headers = () => screen.getAllByTestId('thread-email-header');
const expandedFlags = () => screen.getAllByTestId('header-toggle').map(n => n.getAttribute('aria-expanded'));
const toggle = (index) => act(() => { fireEvent.click(headers()[index]); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  mockUpdateEmailFlags.mockReset().mockResolvedValue(undefined);
  mockGetLocalEmailLight.mockReset().mockResolvedValue(null);
  useSettingsStore.setState({
    markAsReadMode: 'delay', markAsReadDelay: 3,
    threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first',
  });
});

afterEach(async () => {
  // Unmount first, so every countdown the reader started is stopped by the
  // reader itself; then close, which drops anything left.
  cleanup();
  act(() => { useMailStore.getState().closeEmail(); });
  await vi.advanceTimersByTimeAsync(10000);
  vi.useRealTimers();
});

describe('thread reader: mark-as-read countdown per expanded message', () => {
  it('1. marks the auto-expanded newest unread message after the delay', async () => {
    const emails = [row(1, 1, ['\\Seen']), row(2, 2)];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));

    await advance(2900);
    expect(marked()).toEqual([]);
    expect(screen.queryByRole('progressbar')).not.toBeNull();

    await advance(200);
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/2']));
  });

  it('2. marks nothing when the newest message is already read', async () => {
    const emails = [row(1, 1, ['\\Seen']), row(2, 2, ['\\Seen'])];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));

    await advance(5000);
    expect(marked()).toEqual([]);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('3. marks an older unread message the user expands, and no collapsed one', async () => {
    const emails = [row(1, 1), row(2, 2), row(3, 3, ['\\Seen'])];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));

    toggle(1);
    expect(expandedFlags()).toEqual(['false', 'true', 'true']);
    await advance(3100);
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/2']));
    await advance(5000);
    expect(marked()).not.toContain('acct1/INBOX/1');
  });

  it('4. collapsing a message before its delay ends cancels its countdown', async () => {
    const emails = [row(1, 1), row(2, 2)];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));

    toggle(0);                       // expand the older one
    await advance(1000);
    toggle(0);                       // and fold it again
    await advance(5000);

    // The newest one stayed open and was marked; the folded one was not.
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/2']));
  });

  it('5. two expanded unread messages each run their own countdown', async () => {
    const emails = [row(1, 1), row(2, 2)];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));

    await advance(1000);
    toggle(0);                       // older one opened a second later
    await advance(2100);
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/2']));
    await advance(1000);
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/2', 'acct1/INBOX/1']));
  });

  it('6. opening another thread before the delay cancels every countdown of the first', async () => {
    const first = [row(1, 1), row(2, 2)];
    const second = [row(3, 3, ['\\Seen']), row(4, 4)];
    prime([...first, ...second]);
    openThread('t1', first);
    render(createElement(Reader));
    toggle(0);

    await advance(1000);
    openThread('t2', second);
    await advance(3100);

    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/4']));
    await advance(5000);
    expect(marked()).toEqual(['acct1/INBOX/4']);
  });

  it('7. closing the reader before the delay cancels the countdown', async () => {
    const emails = [row(1, 1), row(2, 2)];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));

    await advance(1000);
    act(() => { useMailStore.getState().closeEmail(); });
    await advance(5000);

    expect(marked()).toEqual([]);
    expect(useMailStore.getState().markReadProgress).toBeNull();
  });

  it('8. a hand-set read state cancels that message\'s countdown and wins', async () => {
    const emails = [row(1, 1), row(2, 2)];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));
    toggle(0);

    await advance(1000);
    await act(async () => { await applyFlagToKeys([2], '\\Seen', false); });
    await advance(5000);

    // The other expanded message kept its own countdown.
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/1']));
    expect(useMailStore.getState().selectedThread.emails.find(e => e.uid === 2).flags).not.toContain('\\Seen');
  });

  it('8b. a message set unread by hand stays unread when its row is redrawn', async () => {
    const emails = [row(1, 1, ['\\Seen']), row(2, 2)];
    prime(emails);
    openThread('t1', emails);
    let view = render(createElement(Reader));

    // A redraw that cuts a countdown short starts it again...
    await advance(1000);
    view.unmount();
    view = render(createElement(Reader));
    await advance(3100);
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/2']));

    // ...but one after the user set the message unread by hand does not.
    await act(async () => { await applyFlagToKeys([2], '\\Seen', false); });
    view.unmount();
    render(createElement(Reader));
    await advance(5000);
    expect(marked()).toEqual(['acct1/INBOX/2']);
  });

  it('8c. clicking the row of the thread already open keeps its countdown', async () => {
    const emails = [row(1, 1, ['\\Seen']), row(2, 2)];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));

    await advance(1000);
    openThread('t1', emails);
    await advance(2100);
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/2']));
  });

  it('9. auto mode marks a message as soon as it is expanded', async () => {
    useSettingsStore.setState({ markAsReadMode: 'auto' });
    const emails = [row(1, 1), row(2, 2, ['\\Seen'])];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));

    toggle(0);
    await advance(0);
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/1']));
  });

  it('10. manual mode never marks anything', async () => {
    useSettingsStore.setState({ markAsReadMode: 'manual' });
    const emails = [row(1, 1), row(2, 2)];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));
    toggle(0);

    await advance(10000);
    expect(marked()).toEqual([]);
  });

  it('11. the user\'s own Sent message, already \\Seen, gets no write', async () => {
    const sent = row(2, 2, ['\\Seen'], { _mailbox: 'Sent', from: { name: 'Me', address: 'me@mock.test' } });
    const emails = [row(1, 1), sent];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));
    toggle(0);

    await advance(3100);
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/1']));
    await advance(5000);
    expect(marked()).toEqual(['acct1/INBOX/1']);
  });

  it('12. a message that arrives while the thread is open stays folded and unread', async () => {
    const emails = [row(1, 1, ['\\Seen']), row(2, 2)];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));

    await advance(1000);
    const arrival = row(3, 3);
    act(() => {
      useMailStore.setState(s => ({
        emails: [...s.emails, arrival],
        selectedThread: threadOf('t1', [...s.selectedThread.emails, arrival]),
      }));
    });
    await advance(5000);

    expect(expandedFlags()[2]).toBe('false');
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/2']));
    expect(marked()).not.toContain('acct1/INBOX/3');
  });

  it('12b. a reply that arrives already read (your own) still opens in place of the newest', async () => {
    const emails = [row(1, 1, ['\\Seen']), row(2, 2, ['\\Seen'])];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));

    const reply = row(3, 3, ['\\Seen'], { _mailbox: 'Sent', from: { name: 'Me', address: 'me@mock.test' } });
    act(() => {
      useMailStore.setState(s => ({ selectedThread: threadOf('t1', [...s.selectedThread.emails, reply]) }));
    });
    expect(expandedFlags()).toEqual(['false', 'false', 'true']);
  });

  it('13. a unified thread spanning two accounts marks each message in its own account and folder', async () => {
    const a = row(5, 1, [], { _accountId: 'acct1', _mailbox: 'INBOX' });
    const b = row(5, 2, [], { _accountId: 'acct2', _mailbox: 'INBOX', messageId: 'b5@mock' });
    prime([a, b], { accounts: [ACCOUNT, ACCOUNT_B], activeMailbox: 'UNIFIED' });
    openThread('t1', [a, b]);
    render(createElement(Reader));
    toggle(0);

    await advance(3100);
    await vi.waitFor(() => expect(marked().sort()).toEqual(['acct1/INBOX/5', 'acct2/INBOX/5']));
  });

  it('14. marked unread by hand, then folded and expanded again: the countdown starts again', async () => {
    const emails = [row(1, 1, ['\\Seen']), row(2, 2)];
    prime(emails);
    openThread('t1', emails);
    render(createElement(Reader));

    await advance(3100);
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/2']));

    // Unread by hand while it is still open: it stays unread.
    await act(async () => { await applyFlagToKeys([2], '\\Seen', false); });
    await advance(5000);
    expect(marked()).toEqual(['acct1/INBOX/2']);

    toggle(1);
    toggle(1);
    await advance(3100);
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/2', 'acct1/INBOX/2']));
  });

  it('15. the chat view marks every unread message in the conversation after the delay', async () => {
    const mine = row(3, 3, ['\\Seen'], { _mailbox: 'Sent', from: { name: 'Me', address: 'me@mock.test' } });
    const emails = [row(1, 1), row(2, 2), mine];
    prime(emails);
    const topic = { subject: 'Topic', emails };
    render(createElement(ChatBubbleView, {
      correspondent: { email: 's1@mock.test', name: 'Sender 1', emails },
      threadId: 'chat-1', threadsMap: new Map([['chat-1', topic]]), userEmail: ['me@mock.test'],
      onBack: () => {}, onReply: () => {},
    }));

    await advance(2900);
    expect(marked()).toEqual([]);
    await advance(200);
    await vi.waitFor(() => expect(marked().sort()).toEqual(['acct1/INBOX/1', 'acct1/INBOX/2']));
  });

  it('15b. chat: a message set unread by hand stays unread when the conversation is rebuilt', async () => {
    const emails = [row(1, 1), row(2, 2)];
    prime(emails);
    const chat = () => {
      const rows = useMailStore.getState().emails;
      return createElement(ChatBubbleView, {
        correspondent: { email: 's1@mock.test', name: 'Sender 1', emails: rows },
        threadId: 'chat-1', threadsMap: new Map([['chat-1', { subject: 'Topic', emails: rows }]]),
        userEmail: ['me@mock.test'], onBack: () => {}, onReply: () => {},
      });
    };
    const view = render(chat());
    await advance(3100);
    await vi.waitFor(() => expect(marked().sort()).toEqual(['acct1/INBOX/1', 'acct1/INBOX/2']));

    await act(async () => { await applyFlagToKeys([1], '\\Seen', false); });
    // Mail from the same correspondent arrives: the conversation is rebuilt.
    act(() => { useMailStore.setState(s => ({ emails: [...s.emails, row(3, 3)] })); });
    view.rerender(chat());
    await advance(5000);

    await vi.waitFor(() => expect(marked()).toContain('acct1/INBOX/3'));
    expect(marked().filter(k => k === 'acct1/INBOX/1')).toHaveLength(1);
  });

  it('16. a single message still goes through selectEmail and marks after the delay', async () => {
    const emails = [row(1, 1)];
    prime(emails);
    mockGetLocalEmailLight.mockResolvedValue({ ...row(1, 1), html: '<p>vault</p>', text: 'vault' });

    await act(async () => { await useMailStore.getState().selectEmail(1); });
    expect(useMailStore.getState().markReadProgress).not.toBeNull();
    expect(marked()).toEqual([]);

    await advance(3100);
    await vi.waitFor(() => expect(marked()).toEqual(['acct1/INBOX/1']));
  });
});
