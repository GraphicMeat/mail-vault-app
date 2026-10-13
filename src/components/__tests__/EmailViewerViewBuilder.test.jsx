// @vitest-environment jsdom

// The view builder opens from the email being read: a toggle beside Sender
// insights, in the single reader and on every message of a thread. It stays
// open across emails (it reloads per email) and closes only on its own close
// button or the toggle.
//
// With "hide view mail" on, adding a word to a view (or making one) can make
// the open email a view's member, which takes its row out of the folder list.
// The reader must keep showing it: the list losing a row is not the message
// going away.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const daemon = vi.hoisted(() => ({ members: { available: true, members: {} } }));
vi.mock('../../services/daemonClient', async (importOriginal) => ({
  ...(await importOriginal()),
  daemonCall: vi.fn(async (method) => {
    if (method === 'views.hidden_members') return daemon.members;
    throw new Error('no daemon');
  }),
}));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 700,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: index * 72 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: emails => ({
    bodiesMapRef: { current: new Map(emails.map(email => [emailKey(email), { status: 'loaded', email }])) },
    registerListener: () => () => {},
  }) };
});

const { useMailStore } = await import('../../stores/mailStore');
const { useThemeStore } = await import('../../stores/themeStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useViewHideStore } = await import('../../stores/viewHideStore');
const { useViewStore, refreshHiddenMembers } = await import('../../stores/viewStore');
const { invalidateChatAndThreadCaches } = await import('../../stores/slices/messageListSlice');
const { serverUids } = await import('../../stores/slices/serverUids');
const { buildThreads } = await import('../../utils/emailParser');
const { useViewBuilderStore } = await import('../../stores/viewBuilderStore');
const { EmailViewer } = await import('../EmailViewer');

const message = (uid, extra = {}) => ({
  uid, _accountId: 'acct-1', _mailbox: 'INBOX', messageId: `<m${uid}@x.test>`,
  subject: `Fondue night ${uid}`, from: { name: 'Anna', address: 'anna@x.test' }, to: [{ address: 'me@x.test' }],
  html: '', text: `Body ${uid}`, attachments: [], flags: ['\\Seen'], date: `2026-10-0${uid}T10:00:00Z`, source: 'server',
  ...extra,
});
const OPEN = message(5);
const OTHER = message(4);
const held = (...uids) => ({ available: true, members: { 'acct-1': { INBOX: { uids, unread: 0 } } } });

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const panels = () => screen.queryAllByTestId('view-builder-panel');
const shownUids = () => useMailStore.getState().sortedEmails.map(e => e.uid);

let loadKeywords;
let addTermsToView;

beforeEach(async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  daemon.members = { available: true, members: {} };
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({
    emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline',
    threadSortOrder: 'oldest-first', signatureDisplay: 'smart', hideViewMail: false,
  });
  useViewHideStore.setState({ keys: null, unreadByMailbox: null, hiddenByMailbox: null });
  useViewBuilderStore.setState({ open: false });
  loadKeywords = vi.fn(async () => ({ available: true, keywords: [{ term: 'fondue', tf: 3, df: 4 }] }));
  // What a save does once the daemon has it: the hide membership is asked again.
  addTermsToView = vi.fn(async () => {
    daemon.members = held(5);
    await refreshHiddenMembers();
    return { ok: true, wasEmpty: false };
  });
  useViewStore.setState({ views: [{ id: 'v1', name: 'Food', def: { query: 'cheese' } }], loadKeywords, addTermsToView });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@x.test' }],
    activeAccountId: 'acct-1', activeMailbox: 'INBOX', unifiedInbox: false, mailboxScope: null, viewMode: 'all',
    emails: [OPEN, OTHER], localEmails: [], sentEmails: [], serverUids: serverUids(new Set([5, 4]), { complete: true }),
    savedEmailIds: new Set(), archivedEmailIds: new Set(), deleteTombstones: new Set(), totalEmails: 2,
    selectedEmail: OPEN, selectedEmailId: '5', selectedThread: null, threadFocusKey: null,
    loadingEmail: false, selectedEmailSource: 'server', _sortedEmailsFingerprint: '',
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('view builder in the single reader', () => {
  it('the toggle opens and closes the panel', async () => {
    render(<EmailViewer />);
    const toggle = screen.getByTestId('view-builder-toggle');
    expect(toggle.getAttribute('aria-label')).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(panels()).toHaveLength(0);

    fireEvent.click(toggle);
    await flush();
    expect(panels()).toHaveLength(1);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(loadKeywords).toHaveBeenCalledWith(expect.objectContaining({ uid: 5 }));

    fireEvent.click(toggle);
    await waitFor(() => expect(panels()).toHaveLength(0));
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('closes from its own close button', async () => {
    render(<EmailViewer />);
    fireEvent.click(screen.getByTestId('view-builder-toggle'));
    await flush();
    fireEvent.click(within(panels()[0]).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(panels()).toHaveLength(0));
  });

  it('opens beside sender insights, each on its own toggle', async () => {
    render(<EmailViewer />);
    fireEvent.click(screen.getByTestId('sender-insights-toggle'));
    fireEvent.click(screen.getByTestId('view-builder-toggle'));
    await flush();
    expect(screen.queryAllByTestId('sender-insights-panel')).toHaveLength(1);
    expect(panels()).toHaveLength(1);

    fireEvent.click(screen.getByTestId('sender-insights-toggle'));
    await waitFor(() => expect(screen.queryAllByTestId('sender-insights-panel')).toHaveLength(0));
    expect(panels()).toHaveLength(1);
  });

  it('survives the reader unmounting (two-column layout while an email loads)', async () => {
    const first = render(<EmailViewer />);
    fireEvent.click(screen.getByTestId('view-builder-toggle'));
    await flush();
    first.unmount();
    expect(useViewBuilderStore.getState().open).toBe(true);

    act(() => useMailStore.setState({ selectedEmail: OTHER, selectedEmailId: '4' }));
    render(<EmailViewer />);
    await flush();
    expect(panels()).toHaveLength(1);
    expect(screen.getByTestId('view-builder-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(loadKeywords).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 4 }));
  });

  it('stays open when another email is opened, and reloads for it', async () => {
    render(<EmailViewer />);
    fireEvent.click(screen.getByTestId('view-builder-toggle'));
    await flush();
    expect(panels()).toHaveLength(1);

    // What selectEmail publishes: the reader loads (no email), then the next one.
    act(() => useMailStore.setState({ selectedEmail: null, selectedEmailId: '4', loadingEmail: true }));
    await flush();
    expect(screen.getByTestId('email-viewer-loading')).toBeTruthy();
    act(() => useMailStore.setState({ selectedEmail: OTHER, loadingEmail: false }));
    await flush();
    expect(panels()).toHaveLength(1);
    expect(loadKeywords).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 4 }));
  });
});

describe('view builder in the thread reader', () => {
  const REPLY = message(6, { inReplyTo: '<m5@x.test>', references: ['<m5@x.test>'], subject: 'Re: Fondue night 5' });
  const openThread = () => {
    const [thread] = [...buildThreads([OPEN, REPLY]).values()];
    expect(thread.emails).toHaveLength(2);
    act(() => useMailStore.setState({
      emails: [OPEN, REPLY], serverUids: serverUids(new Set([5, 6]), { complete: true }),
      selectedThread: thread, selectedEmail: null, selectedEmailId: '6',
    }));
    invalidateChatAndThreadCaches();
    useMailStore.getState().updateSortedEmails();
    return thread;
  };
  const rowOf = (container, uid) => container.querySelector(`[data-email-key="acct-1|INBOX|${uid}"]`);

  it('one panel, on the focused message; a toggle elsewhere moves it there', async () => {
    openThread();
    const { container } = render(<EmailViewer />);
    expect(screen.getAllByTestId('view-builder-toggle')).toHaveLength(2);

    // The focused message is the one the thread opened on: the newest.
    fireEvent.click(within(rowOf(container, 6)).getByTestId('view-builder-toggle'));
    await flush();
    expect(panels()).toHaveLength(1);
    expect(within(rowOf(container, 6)).queryAllByTestId('view-builder-panel')).toHaveLength(1);

    fireEvent.click(within(rowOf(container, 5)).getByTestId('view-builder-toggle'));
    await flush();
    await waitFor(() => expect(panels()).toHaveLength(1));
    expect(within(rowOf(container, 5)).queryAllByTestId('view-builder-panel')).toHaveLength(1);
    expect(within(rowOf(container, 5)).getByTestId('view-builder-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(within(rowOf(container, 6)).getByTestId('view-builder-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(loadKeywords).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 5 }));

    fireEvent.click(within(rowOf(container, 5)).getByTestId('view-builder-toggle'));
    await waitFor(() => expect(panels()).toHaveLength(0));
    expect(useViewBuilderStore.getState().open).toBe(false);
  });

  it('opened in the single reader, it stays open on the thread opened next', async () => {
    const { container } = render(<EmailViewer />);
    fireEvent.click(screen.getByTestId('view-builder-toggle'));
    await flush();
    openThread();
    await flush();
    expect(panels()).toHaveLength(1);
    expect(within(rowOf(container, 6)).queryAllByTestId('view-builder-panel')).toHaveLength(1);
  });

  it('in split layout it follows the message picked', async () => {
    useSettingsStore.setState({ threadReaderLayout: 'split' });
    useViewBuilderStore.setState({ open: true });
    openThread();
    render(<EmailViewer />);
    await flush();
    expect(panels()).toHaveLength(1);
    expect(loadKeywords).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 6 }));
    fireEvent.click(screen.getByRole('button', { name: /^Anna\s*Fondue night 5/ }));
    await flush();
    await waitFor(() => expect(panels()).toHaveLength(1));
    expect(loadKeywords).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 5 }));
  });

  it('a toggle click does not fold the message', async () => {
    openThread();
    const { container } = render(<EmailViewer />);
    const header = within(rowOf(container, 6));
    expect(header.getByTestId('header-toggle').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header.getByTestId('view-builder-toggle'));
    await flush();
    expect(header.getByTestId('header-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the message a view now holds, with its panel', async () => {
    useSettingsStore.setState({ hideViewMail: true });
    await flush();
    openThread();
    const { container } = render(<EmailViewer />);
    fireEvent.click(within(rowOf(container, 5)).getByTestId('view-builder-toggle'));
    await flush();

    fireEvent.click(screen.getByRole('checkbox', { name: /fondue/ }));
    fireEvent.click(screen.getByTestId('view-builder-add'));
    await flush();
    expect(addTermsToView).toHaveBeenCalledWith('v1', ['fondue']);

    // The list dropped the row, and re-read its threads from what is left.
    expect(shownUids()).toEqual([6]);
    act(() => useMailStore.getState().syncSelectedThread(buildThreads(useMailStore.getState().sortedEmails)));
    await flush();

    const open = useMailStore.getState().selectedThread;
    expect(open.emails.map(e => e.uid).sort()).toEqual([5, 6]);
    expect(rowOf(container, 5)).not.toBeNull();
    expect(within(rowOf(container, 5)).queryAllByTestId('view-builder-panel')).toHaveLength(1);
    expect(screen.getByTestId('view-builder-notice')).toBeTruthy();
  });

  it('a list re-read keeps an open member a view holds', () => {
    useSettingsStore.setState({ hideViewMail: true });
    const thread = openThread();
    useViewHideStore.getState().setMembers(held(5));
    expect(shownUids()).toEqual([6]);
    act(() => useMailStore.getState().syncSelectedThread(buildThreads(useMailStore.getState().sortedEmails)));
    const open = useMailStore.getState().selectedThread;
    expect(open.emails.map(e => e.uid)).toEqual([5, 6]);
    // Nothing else changed: the same members do not swap the open thread again.
    act(() => useMailStore.getState().syncSelectedThread(buildThreads(useMailStore.getState().sortedEmails)));
    expect(useMailStore.getState().selectedThread).toBe(open);
    expect(open.threadId).toBe(thread.threadId);
  });

  it('with the setting off, a member gone from the list leaves the reader', () => {
    openThread();
    useViewHideStore.getState().setMembers(held(5));
    act(() => useMailStore.getState().syncSelectedThread(buildThreads([REPLY])));
    expect(useMailStore.getState().selectedThread.emails.map(e => e.uid)).toEqual([6]);
  });

  it('does not keep a held member that left the folder (deleted or moved elsewhere)', () => {
    useSettingsStore.setState({ hideViewMail: true });
    openThread();
    useViewHideStore.getState().setMembers(held(5));
    // Another client removed message 5: gone from the pool, yet still held by a stale answer.
    act(() => useMailStore.setState({ emails: [REPLY] }));
    act(() => useMailStore.getState().syncSelectedThread(buildThreads([REPLY])));
    expect(useMailStore.getState().selectedThread.emails.map(e => e.uid)).toEqual([6]);
  });

  it('still drops a member that really left the thread', () => {
    useSettingsStore.setState({ hideViewMail: true });
    useViewHideStore.getState().setMembers(held(6));
    openThread();
    // Message 5 is gone from the folder (not held by any view): the reader follows.
    act(() => useMailStore.getState().syncSelectedThread(buildThreads([REPLY])));
    expect(useMailStore.getState().selectedThread.emails.map(e => e.uid)).toEqual([6]);
  });
});

describe('hide view mail while reading', () => {
  it('a word added to a view hides the row, not the open email', async () => {
    useSettingsStore.setState({ hideViewMail: true });
    await flush();
    expect(shownUids()).toEqual([5, 4]);

    render(<EmailViewer />);
    fireEvent.click(screen.getByTestId('view-builder-toggle'));
    await flush();
    fireEvent.click(screen.getByRole('checkbox', { name: /fondue/ }));
    fireEvent.click(screen.getByTestId('view-builder-add'));
    await flush();

    expect(addTermsToView).toHaveBeenCalledWith('v1', ['fondue']);
    expect(useViewHideStore.getState().keys?.has('acct-1|INBOX|5')).toBe(true);
    expect(shownUids()).toEqual([4]);
    expect(useMailStore.getState().selectedEmail).toBe(OPEN);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Fondue night 5');
    expect(panels()).toHaveLength(1);
    expect(screen.getByTestId('view-builder-notice')).toBeTruthy();
  });
});
