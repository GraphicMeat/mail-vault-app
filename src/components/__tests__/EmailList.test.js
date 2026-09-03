// @vitest-environment jsdom

// Stub ResizeObserver for jsdom
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

// Track useVirtualizer calls
let lastVirtualizerConfig = null;

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn((config) => {
    lastVirtualizerConfig = config;
    return {
      getVirtualItems: () =>
        // Simulate windowing: return at most 15 items even if count is 500
        Array.from({ length: Math.min(15, config.count) }, (_, i) => ({
          key: i,
          index: i,
          start: i * (config.estimateSize?.() ?? 56),
          size: config.estimateSize?.() ?? 56,
        })),
      getTotalSize: () => config.count * (config.estimateSize?.() ?? 56),
      scrollToIndex: vi.fn(),
    };
  }),
}));

// Mock framer-motion
vi.mock('framer-motion', () => ({
  motion: { div: React.forwardRef((props, ref) => React.createElement('div', { ...props, ref })) },
  AnimatePresence: ({ children }) => children,
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  // Every icon resolves. A hand-listed set breaks the moment a shared
  // primitive (ui/Button pulls in Loader, ui/Dialog pulls in X) imports one
  // more glyph — vitest then fails the whole file with "No export defined".
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

// Mock child components
vi.mock('../SearchBar', () => ({ SearchBar: () => null }));
vi.mock('../BulkOperationsModal', () => ({ BulkOperationsModal: () => null }));
vi.mock('../BulkOperationProgress', () => ({ BulkOperationProgress: () => null }));
vi.mock('../BulkSelectionBubble', () => ({ BulkSelectionBubble: () => null }));
vi.mock('../LinkAlertIcon', () => ({ LinkAlertIcon: () => null }));
vi.mock('../SenderAlertIcon', () => ({ SenderAlertIcon: () => null, getSenderAlertLevel: () => null }));
vi.mock('../../services/BulkOperationManager', () => ({
  bulkOperationManager: { cancel: vi.fn() },
}));
vi.mock('../../utils/linkSafety', () => ({
  getLinkAlertLevel: () => null,
  getCachedAlerts: () => [],
  getAlertsForEmails: () => [],
}));
vi.mock('../../utils/dateFormat', () => ({
  formatEmailDate: (d) => String(d),
  formatDateOnly: (d) => String(d),
}));

// Build mock emails
function makeEmails(count) {
  return Array.from({ length: count }, (_, i) => ({
    uid: i + 1,
    subject: `Email ${i + 1}`,
    from: [{ address: `sender${i}@test.com`, name: `Sender ${i}` }],
    to: [{ address: 'me@test.com' }],
    date: new Date(2024, 0, 1, 0, 0, i).toISOString(),
    flags: ['\\Seen'],
    source: 'server',
    snippet: 'test snippet',
    has_attachments: false,
    isArchived: false,
  }));
}

// Mock stores
const mockEmails = makeEmails(500);

vi.mock('../../stores/mailStore', () => {
  const state = {
    loading: false,
    loadingMore: false,
    activeMailbox: 'INBOX',
    activeAccountId: 'acc1',
    viewMode: 'all',
    totalEmails: 500,
    selectedEmailId: null,
    selectedEmailIds: new Set(),
    sortedEmails: mockEmails,
    sentEmails: [],
    hasMoreEmails: false,
    _flagSeq: 0,
    archivedEmailIds: new Set(),
    // ConnectedStateIcon reads these for every rendered row — null/false are
    // the real store defaults (messageListSlice), not just test filler.
    backedUpKeys: null,
    serverUids: { uids: new Set(), complete: false },
    accounts: [{ id: 'acc1', email: 'me@test.com' }],
    bulkModalOpen: false,
    openBulkModal: vi.fn(),
    minimizeBulkModal: vi.fn(),
    bulkSession: null,
    endBulkSession: vi.fn(),
    loadEmails: vi.fn(),
    loadMoreEmails: vi.fn(),
    selectEmail: vi.fn(),
    selectThread: vi.fn(),
    toggleEmailSelection: vi.fn(),
    selectAllEmails: vi.fn(),
    clearSelection: vi.fn(),
    getChatEmails: vi.fn(() => []),
    getSentMailboxPath: vi.fn(() => 'Sent'),
    refreshBackedUpUids: vi.fn(),
    unreadOnly: false,
    toggleUnreadOnly: vi.fn(),
    saveEmailLocally: vi.fn(),
    removeLocalEmail: vi.fn(),
    deleteEmailFromServer: vi.fn(),
    unifiedInbox: false,
  };
  const hook = vi.fn((selector) => selector(state));
  hook.getState = () => state;
  hook.setState = (update) => Object.assign(state, typeof update === 'function' ? update(state) : update);
  hook.subscribe = () => () => {};
  return { useMailStore: hook };
});

vi.mock('../../stores/searchStore', () => {
  const state = {
    searchActive: false,
    searchResults: [],
    clearSearch: vi.fn(),
  };
  const hook = vi.fn((selector) => selector(state));
  hook.getState = () => state;
  return { useSearchStore: hook };
});

vi.mock('../../stores/settingsStore', () => {
  // Hoisted, not rebuilt per call: a real Zustand store hands out the SAME
  // `accountColors` object until something writes to it. Minting a fresh one on
  // every read made every row's `accountColors` prop a new reference, which
  // silently defeated React.memo on the rows — and a row that always re-renders
  // cannot fail the memo-staleness test below.
  const state = {
    emailListStyle: 'default',
    emailListGrouping: 'chronological',
    setEmailListGrouping: vi.fn(),
    threadMode: 'grouped',
    setThreadMode: vi.fn(),
    threadSortOrder: 'oldest-first',
    layoutMode: 'three-column',
    accountColors: {},
    // Rows subscribe to this to decide whether the tracker glyph reads
    // "blocked" or "tracks you"; without a profile it is simply off.
    trackerBlockingEnabled: true,
    billingProfile: null,
  };
  const hook = vi.fn((selector) => selector(state));
  hook.getState = () => state;
  hook.setState = (update) => Object.assign(state, update);
  return {
    useSettingsStore: hook,
    getAccountColor: () => '#888',
    getAccountInitial: () => 'T',
    hashColor: () => '#888',
    hasPremiumAccess: () => false,
    isTrackerBlockingActive: () => false,
  };
});

vi.mock('../../utils/emailParser', async (importOriginal) => ({
  ...(await importOriginal()),
  // Group by subject, the way the real threader does for replies. The 500
  // fixture emails all have unique subjects, so this is still one thread per
  // email for every test that does not deliberately build a conversation.
  buildThreads: (emails) => {
    const map = new Map();
    for (const e of emails || []) {
      const key = e.subject;
      const t = map.get(key);
      if (t) {
        t.emails.push(e);
        t.messageCount = t.emails.length;
        t.lastEmail = e;
        t.lastDate = new Date(e.date);
      } else {
        map.set(key, {
          threadId: String(e.uid),
          subject: e.subject,
          messageCount: 1,
          emails: [e],
          lastEmail: e,
          lastDate: new Date(e.date),
          unreadCount: 0,
        });
      }
    }
    return map;
  },
  groupBySender: () => [],
  getSenderName: (e) => e?.from?.[0]?.name || '',
}));

describe('EmailList virtualization', () => {
  beforeEach(() => {
    lastVirtualizerConfig = null;
  });

  it('virtualizer renders only visible rows, not all 500 items (PERF-01)', async () => {
    const { EmailList } = await import('../EmailList.jsx');
    const { container } = render(React.createElement(EmailList));

    // With 500 emails, virtualizer should render at most ~15 items (windowed)
    // Count rendered email row elements (they are absolutely positioned divs inside the virtualizer)
    const virtualizedRows = container.querySelectorAll('[data-index]');
    expect(virtualizedRows.length).toBeLessThanOrEqual(20);
    expect(virtualizedRows.length).toBeGreaterThan(0);
    expect(virtualizedRows.length).toBeLessThan(500);
  });

  it('virtualizer count equals threadedDisplay length (PERF-01)', async () => {
    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList));

    // useVirtualizer should have been called with count matching the display array
    expect(lastVirtualizerConfig).not.toBeNull();
    expect(lastVirtualizerConfig.count).toBe(500);
  });

  it('EmailRow does not use object selectors from useMailStore (PERF-04)', async () => {
    // Verify at module level that EmailRow uses individual selectors
    // by reading the source — the useMailStore mock tracks calls
    const { useMailStore } = await import('../../stores/mailStore');

    // Get the source of EmailList to verify pattern
    // Instead, we verify the mock was called with individual selector functions
    // Each call to useMailStore(s => s.fieldName) returns a scalar
    const calls = useMailStore.mock?.calls || [];

    // Verify none of the selector functions return objects with multiple keys
    // (object selectors like s => ({ a: s.a, b: s.b }) are the anti-pattern)
    const objectSelectorCalls = calls.filter((call) => {
      const selector = call[0];
      if (typeof selector !== 'function') return false;
      const mockState = {
        saveEmailLocally: vi.fn(),
        removeLocalEmail: vi.fn(),
        deleteEmailFromServer: vi.fn(),
        unifiedInbox: false,
        loading: false,
        loadingMore: false,
        activeMailbox: 'INBOX',
        activeAccountId: 'acc1',
        viewMode: 'all',
        totalEmails: 500,
        selectedEmailId: null,
        selectedEmailIds: new Set(),
        sortedEmails: [],
        sentEmails: [],
        hasMoreEmails: false,
        _flagSeq: 0,
        archivedEmailIds: new Set(),
        backedUpKeys: null,
        serverUids: { uids: new Set(), complete: false },
        accounts: [{ id: 'acc1', email: 'me@test.com' }],
        loadEmails: vi.fn(),
        loadMoreEmails: vi.fn(),
        selectEmail: vi.fn(),
        selectThread: vi.fn(),
        toggleEmailSelection: vi.fn(),
        selectAllEmails: vi.fn(),
        clearSelection: vi.fn(),
        getChatEmails: vi.fn(() => []),
        getSentMailboxPath: vi.fn(() => 'Sent'),
      };
      try {
        const result = selector(mockState);
        // If the result is a plain object with multiple keys, it's an object selector
        return result !== null && typeof result === 'object' && !Array.isArray(result)
          && !(result instanceof Set) && !(result instanceof Map)
          && Object.keys(result).length > 1;
      } catch {
        return false;
      }
    });

    expect(objectSelectorCalls.length).toBe(0);
  });

  it('scrolling near the bottom re-arms loadMoreEmails when the auto chain is dead (741-stuck regression)', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    const state = useMailStore.getState();
    state.loadMoreEmails.mockClear();
    useMailStore.setState({ hasMoreEmails: true, loadingMore: false });

    const { EmailList } = await import('../EmailList.jsx');
    const { container } = render(React.createElement(EmailList));
    const scroller = container.querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();

    Object.defineProperty(scroller, 'scrollHeight', { value: 28000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true });

    // Far from the bottom — must NOT fire
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event('scroll'));
    expect(state.loadMoreEmails).not.toHaveBeenCalled();

    // Within 20 rows of the bottom — must fire even though no data changed
    scroller.scrollTop = 27100;
    scroller.dispatchEvent(new Event('scroll'));
    expect(state.loadMoreEmails).toHaveBeenCalled();

    useMailStore.setState({ hasMoreEmails: false });
  });

  // A bulk session is bound to the (account, mailbox, viewMode) it was
  // opened against (uiSlice's openBulkModal). If the user navigates to a
  // different mailbox while a session is minimized, the session (and its
  // selection) must not silently keep applying to the new mailbox —
  // activateAccount already clears selectedEmailIds on switch for exactly
  // this cross-mailbox-bleed reason, and a session outliving its folder
  // would fight that clear.
  it('ends a bulk session bound to a different mailbox than the one now active', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.getState().endBulkSession.mockClear();
    useMailStore.setState({
      bulkSession: { active: true, step: 1, range: { type: 'all' }, action: null, accountId: 'acc1', mailbox: 'INBOX', viewMode: 'all' },
      selectedEmailIds: new Set([1, 2, 3]),
      activeAccountId: 'acc1',
      activeMailbox: 'Sent', // session was bound to INBOX — mismatch
      viewMode: 'all',
    });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList));

    expect(useMailStore.getState().endBulkSession).toHaveBeenCalled();

    useMailStore.setState({ bulkSession: null, selectedEmailIds: new Set(), activeMailbox: 'INBOX' });
  });

  // viewMode is bound the same way: "All" resolves against a different pool
  // in local-only view than in server view for the very same mailbox, so
  // toggling it (the Sidebar's view-mode control) invalidates a session just
  // as surely as switching folders does — independent of any navigation.
  it('ends a bulk session bound to a different viewMode than the one now active', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.getState().endBulkSession.mockClear();
    useMailStore.setState({
      bulkSession: { active: true, step: 1, range: { type: 'all' }, action: null, accountId: 'acc1', mailbox: 'INBOX', viewMode: 'all' },
      selectedEmailIds: new Set([1, 2, 3]),
      activeAccountId: 'acc1',
      activeMailbox: 'INBOX', // same account and mailbox —
      viewMode: 'local', // — only viewMode changed
    });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList));

    expect(useMailStore.getState().endBulkSession).toHaveBeenCalled();

    useMailStore.setState({ bulkSession: null, selectedEmailIds: new Set(), viewMode: 'all' });
  });

  it('does not end a bulk session whose (account, mailbox, viewMode) still match', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.getState().endBulkSession.mockClear();
    useMailStore.setState({
      bulkSession: { active: true, step: 1, range: { type: 'all' }, action: null, accountId: 'acc1', mailbox: 'INBOX', viewMode: 'all' },
      selectedEmailIds: new Set([1, 2, 3]),
      activeAccountId: 'acc1',
      activeMailbox: 'INBOX', // matches
      viewMode: 'all', // matches — no mismatch
    });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList));

    expect(useMailStore.getState().endBulkSession).not.toHaveBeenCalled();

    useMailStore.setState({ bulkSession: null, selectedEmailIds: new Set() });
  });
});

// purgeEverywhere's four outcome counts (deleted/failed/queuedBackup/needsResync)
// are not mutually exclusive, and needsResync had no consumer before this —
// a run that held uids back for a UIDVALIDITY mismatch must not read as silent
// success. These test the pure formatter directly rather than driving it
// through handleBulkConfirm, since the interesting behavior is the message
// composition, not the store plumbing around it (already covered above).
describe('formatPurgeEverywhereOutcome', () => {
  it('returns null for a clean run (nothing to warn about)', async () => {
    const { formatPurgeEverywhereOutcome } = await import('../EmailList.jsx');
    expect(formatPurgeEverywhereOutcome({ deleted: 5, failed: 0, queuedBackup: 0, needsResync: 0 })).toBeNull();
  });

  it('returns null when there is no result (non-delete_everywhere actions)', async () => {
    const { formatPurgeEverywhereOutcome } = await import('../EmailList.jsx');
    expect(formatPurgeEverywhereOutcome(undefined)).toBeNull();
    expect(formatPurgeEverywhereOutcome(null)).toBeNull();
  });

  it('names the queuedBackup count when the backup drive was unreachable', async () => {
    const { formatPurgeEverywhereOutcome } = await import('../EmailList.jsx');
    const msg = formatPurgeEverywhereOutcome({ deleted: 3, failed: 0, queuedBackup: 2, needsResync: 0 });
    expect(msg).toContain('3 removed');
    expect(msg).toContain('2 backup copies will be removed when the backup drive reconnects');
    expect(msg).not.toMatch(/could not be deleted|resync/);
  });

  it('names the failed count and states the local copies were left alone', async () => {
    const { formatPurgeEverywhereOutcome } = await import('../EmailList.jsx');
    const msg = formatPurgeEverywhereOutcome({ deleted: 4, failed: 1, queuedBackup: 0, needsResync: 0 });
    expect(msg).toContain('4 removed');
    expect(msg).toContain('1 could not be deleted from the server and was left untouched locally');
  });

  it('names the needsResync count and tells the user to resync rather than retry', async () => {
    const { formatPurgeEverywhereOutcome } = await import('../EmailList.jsx');
    const msg = formatPurgeEverywhereOutcome({ deleted: 0, failed: 0, queuedBackup: 0, needsResync: 3 });
    expect(msg).toContain('0 removed');
    expect(msg).toContain('3 were skipped because this mailbox needs to resync');
    expect(msg).toContain('resync it, then try again');
  });

  it('composes every non-zero outcome in one message when several happen at once', async () => {
    const { formatPurgeEverywhereOutcome } = await import('../EmailList.jsx');
    const msg = formatPurgeEverywhereOutcome({ deleted: 2, failed: 1, queuedBackup: 3, needsResync: 4 });
    expect(msg).toContain('2 removed');
    expect(msg).toContain('1 could not be deleted from the server');
    expect(msg).toContain('3 backup copies will be removed');
    expect(msg).toContain('4 were skipped because this mailbox needs to resync');
  });

  it('uses singular wording for a count of exactly one', async () => {
    const { formatPurgeEverywhereOutcome } = await import('../EmailList.jsx');
    const msg = formatPurgeEverywhereOutcome({ deleted: 0, failed: 1, queuedBackup: 1, needsResync: 1 });
    expect(msg).toContain('1 could not be deleted from the server and was left untouched locally');
    expect(msg).toContain('1 backup copy will be removed');
    expect(msg).toContain('1 was skipped because this mailbox needs to resync');
  });
});

// ── Unread-only filter ────────────────────────────────────────────────────
// The filter is a view concern: the store keeps handing out the full window
// (bulk operations, the viewer's own lookups and the unread badges all read
// it), and the list narrows what it draws. These drive the real component so
// a filter that is never wired to the virtualizer cannot pass.
describe('unread-only filter', () => {
  const mixed = (count) =>
    Array.from({ length: count }, (_, i) => ({
      uid: i + 1,
      subject: `Email ${i + 1}`,
      from: [{ address: `sender${i}@test.com`, name: `Sender ${i}` }],
      to: [{ address: 'me@test.com' }],
      date: new Date(2024, 0, 1, 0, 0, i).toISOString(),
      // Odd uids unread, even read — the same split the mock IMAP server uses.
      flags: (i + 1) % 2 === 0 ? ['\\Seen'] : [],
      source: 'server',
      snippet: 'test snippet',
      has_attachments: false,
      isArchived: false,
    }));

  afterEach(async () => {
    cleanup();
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.setState({
      unreadOnly: false,
      sortedEmails: mockEmails,
      totalEmails: 500,
      selectedEmailId: null,
    });
  });

  it('draws every row when the filter is off', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.setState({ sortedEmails: mixed(10), totalEmails: 10, unreadOnly: false });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList));

    expect(lastVirtualizerConfig.count).toBe(10);
  });

  it('draws only unread rows when the filter is on', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.setState({ sortedEmails: mixed(10), totalEmails: 10, unreadOnly: true });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList));

    expect(lastVirtualizerConfig.count).toBe(5);
  });

  // Opening an unread message marks it read a beat later. Dropping its row at
  // that moment yanks the message out from under the reader, so the open one
  // stays until the selection moves on.
  it('keeps the open message on screen after it turns read', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    // uid 2 is read — it only survives because it is the selected message.
    useMailStore.setState({ sortedEmails: mixed(10), totalEmails: 10, unreadOnly: true, selectedEmailId: 2 });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList));

    expect(lastVirtualizerConfig.count).toBe(6);
  });

  it('counts the unread rows in the header, not the whole window', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.setState({ sortedEmails: mixed(10), totalEmails: 10, unreadOnly: true });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList));

    expect(screen.getByTestId('email-list-count').textContent).toBe('5 unread');
  });

  it('toggles the filter from the list header', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.getState().toggleUnreadOnly.mockClear();
    useMailStore.setState({ sortedEmails: mixed(10), totalEmails: 10, unreadOnly: false });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList));

    fireEvent.click(screen.getByTestId('unread-filter-toggle'));
    expect(useMailStore.getState().toggleUnreadOnly).toHaveBeenCalled();
  });

  // A filter that hides everything must say so, and offer the way back —
  // otherwise a filtered list is indistinguishable from lost mail.
  it('offers a way out when the filter empties the list', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.getState().toggleUnreadOnly.mockClear();
    useMailStore.setState({
      sortedEmails: mockEmails.slice(0, 4), // every fixture email carries \\Seen
      totalEmails: 4,
      unreadOnly: true,
    });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList));

    expect(screen.getByText(/No unread messages/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/Show all messages/i));
    expect(useMailStore.getState().toggleUnreadOnly).toHaveBeenCalled();
  });
});

// The rows a person sees ARE the store's own email objects: `deriveDisplayRows`
// writes isLocal/isArchived/source onto them in place and hands the same objects
// back (messageListSlice.js — copying every row on every derivation is what this
// list cannot afford). Archiving therefore changes nothing about a row's `email`
// identity. That was harmless while `style={{height}}` and inline row callbacks
// made React.memo a no-op; b7dc706 made every row prop referentially stable, the
// memo started working, and the state icon froze on "on the server" for the rest
// of the session. Two connected-* e2e specs caught it. This pins it in CI.
describe('rows repaint when the derivation mutates them in place', () => {
  afterEach(cleanup);

  it('flips the state icon after an in-place archive', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    const rows = mockEmails.slice(0, 5);
    for (const e of rows) { e.isArchived = false; e.source = 'server'; }
    useMailStore.setState({
      sortedEmails: rows,
      totalEmails: rows.length,
      unreadOnly: false,
      archivedEmailIds: new Set(),
    });

    const { EmailList } = await import('../EmailList.jsx');
    // EmailList is memo'd and takes no props, so a changing throwaway prop is
    // what forces the re-render an archive would really cause.
    const { rerender, container } = render(React.createElement(EmailList, { 'data-render': 1 }));

    const stateOf = () => container.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state');
    expect(stateOf()).toMatch(/^server-only/);

    // Exactly what archiving does: the uid joins archivedEmailIds and the
    // derivation stamps the SAME object, returning a fresh array around it.
    rows[0].isArchived = true;
    rows[0].source = 'local';
    useMailStore.setState({
      sortedEmails: [...rows],
      archivedEmailIds: new Set([rows[0].uid]),
    });
    rerender(React.createElement(EmailList, { 'data-render': 2 }));

    // Same assertion the e2e specs make: the id prefix, not the exact variant.
    expect(stateOf()).toMatch(/^archived/);
  });
});

// The header line is the only place that says how much of the mailbox the
// list is actually showing. It has to stay honest in both directions: the
// filter only sees the loaded window, so "12 unread" on a half-loaded 15k
// mailbox would be a claim the app cannot back.
describe('formatListCount', () => {
  it('reports the mailbox total once the window covers it', async () => {
    const { formatListCount } = await import('../EmailList.jsx');
    expect(formatListCount({ shown: 500, loaded: 500, total: 500, unreadOnly: false })).toBe('500 emails');
  });

  it('reports how much of the mailbox is loaded while it is short', async () => {
    const { formatListCount } = await import('../EmailList.jsx');
    expect(formatListCount({ shown: 741, loaded: 741, total: 15067, unreadOnly: false })).toBe('741 of 15,067 emails');
  });

  it('counts unread when the filter is on and the window is complete', async () => {
    const { formatListCount } = await import('../EmailList.jsx');
    expect(formatListCount({ shown: 12, loaded: 500, total: 500, unreadOnly: true })).toBe('12 unread');
  });

  it('names the loaded window when the filter can only see part of the mailbox', async () => {
    const { formatListCount } = await import('../EmailList.jsx');
    expect(formatListCount({ shown: 12, loaded: 741, total: 15067, unreadOnly: true })).toBe('12 unread of 741 loaded');
  });
});

// The thread cache key used to name only account, mailbox, view mode, row
// count, and the first and last UID. Switching into unified inbox produces two
// lists that agree on every one of those — the account's own INBOX rows, and a
// moment later the same messages re-stamped with `_accountId` once the unified
// load lands. The threads built from the un-stamped rows survived the swap,
// `threadedDisplay` matched them by `accountId:uid`, nothing matched, and the
// list rendered zero rows with a full store behind it. The stamps are part of
// the key now.
describe('thread cache follows the list it was built from', () => {
  const rows = (count, stamped) =>
    Array.from({ length: count }, (_, i) => ({
      uid: i + 1,
      subject: `Email ${i + 1}`,
      from: [{ address: `sender${i}@test.com`, name: `Sender ${i}` }],
      to: [{ address: 'me@test.com' }],
      date: new Date(2024, 0, 1, 0, 0, i).toISOString(),
      flags: ['\\Seen'],
      source: 'server',
      isArchived: false,
      ...(stamped ? { _accountId: 'acc1', _mailbox: 'INBOX' } : {}),
    }));

  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  afterEach(async () => {
    cleanup();
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.setState({
      activeMailbox: 'INBOX',
      unifiedInbox: false,
      sortedEmails: mockEmails,
      totalEmails: 500,
    });
  });

  it('rebuilds when a same-length list is replaced by account-stamped rows', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    // The frame right after the click: the view is already unified, the rows
    // are still the outgoing account's.
    useMailStore.setState({
      activeMailbox: 'UNIFIED',
      unifiedInbox: true,
      sortedEmails: rows(3, false),
      totalEmails: 3,
    });

    // `.type` is the unmemoized component. The export is `memo()`d and takes no
    // props, so a plain rerender bails out before the body runs — and this test
    // is about what the body's caches do on a re-render, not about memo.
    const { EmailList } = await import('../EmailList.jsx');
    const { rerender } = render(React.createElement(EmailList.type));
    await settle();
    expect(lastVirtualizerConfig.count).toBe(3);

    // The unified load lands: same three messages, same UIDs, now stamped.
    useMailStore.setState({ sortedEmails: rows(3, true) });
    rerender(React.createElement(EmailList.type));
    await settle();

    expect(lastVirtualizerConfig.count).toBe(3);
  });
});

// "1,213 of 1,630 loaded in your vault" was read as a download progress bar,
// and it sat one line under a count whose "of" meant the SERVER total. Two
// adjacent lines, two populations, one preposition.
describe('vault share line', () => {
  // This file has no global cleanup — without it the previous test's DOM is
  // still mounted and queryByTestId answers about it.
  afterEach(() => cleanup());

  const row = (uid, isArchived) => ({
    uid, isArchived, subject: `s${uid}`, from: 'a@b.c', date: '2026-01-01T00:00:00Z', flags: ['\\Seen'],
  });

  it('leads with the vault and counts only the loaded window', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.setState({
      totalEmails: 5000,
      sortedEmails: [row(1, true), row(2, true), row(3, false)],
    });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList.type));

    const text = screen.getByTestId('email-list-vault-share').textContent;
    expect(text).toBe('In your vault: 2 of 3 loaded');
    // The server total is the OTHER line's denominator and must not leak here.
    expect(text).not.toContain('5,000');
  });

  it('drops the "loaded" suffix once the whole mailbox is in hand', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.setState({
      totalEmails: 3,
      sortedEmails: [row(1, true), row(2, true), row(3, false)],
    });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList.type));

    // Nothing left to page in, so "loaded" would invite a scroll that can never
    // move either number.
    expect(screen.getByTestId('email-list-vault-share').textContent).toBe('In your vault: 2 of 3');
  });

  it('never calls the vault view partial, however big the server total is', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.setState({
      viewMode: 'local',
      totalEmails: 5000,
      sortedEmails: [row(1, true), row(2, true)],
    });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList.type));

    // These rows come off disk. totalEmails still counts the SERVER, so a bare
    // `loaded < totalEmails` would promise a scroll that pages in nothing.
    expect(screen.getByTestId('email-list-vault-share').textContent).toBe('In your vault: 2 of 2');
    useMailStore.setState({ viewMode: 'all' });
  });

  it('renders nothing at all when no window is loaded', async () => {
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.setState({ totalEmails: 0, sortedEmails: [] });

    const { EmailList } = await import('../EmailList.jsx');
    render(React.createElement(EmailList.type));

    expect(screen.queryByTestId('email-list-vault-share')).toBeNull();
  });
});


describe('thread modes', () => {
  const reply = (uid, subject) => ({
    uid, subject,
    from: [{ address: `p${uid}@test.com`, name: `P${uid}` }],
    to: [{ address: 'me@test.com' }],
    date: new Date(2024, 0, 1, 0, 0, uid).toISOString(),
    flags: ['\\Seen'], source: 'server', isArchived: false,
    _accountId: 'acc1', _mailbox: 'INBOX',
  });
  const conversation = [reply(1, 'Re: Plan'), reply(2, 'Re: Plan'), reply(3, 'Re: Plan')];
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  const mount = async (threadMode) => {
    const { useMailStore } = await import('../../stores/mailStore');
    const { useSettingsStore } = await import('../../stores/settingsStore');
    // Threading in INBOX runs off getChatEmails (INBOX + Sent merged), not
    // sortedEmails — the default `() => []` mock would hand buildThreads an
    // empty list and every mode would render flat for the wrong reason.
    useMailStore.setState({ sortedEmails: conversation, totalEmails: 3, getChatEmails: () => conversation });
    useSettingsStore.setState({ threadMode });
    const { EmailList } = await import('../EmailList.jsx');
    const utils = render(React.createElement(EmailList.type));
    await settle();
    return utils;
  };

  afterEach(async () => {
    cleanup();
    const { useMailStore } = await import('../../stores/mailStore');
    const { useSettingsStore } = await import('../../stores/settingsStore');
    useMailStore.setState({ sortedEmails: mockEmails, totalEmails: 500, getChatEmails: vi.fn(() => []) });
    useSettingsStore.setState({ threadMode: 'grouped' });
    useSettingsStore.getState().setThreadMode.mockClear();
  });

  it('grouped: three replies collapse into one thread row', async () => {
    const { container } = await mount('grouped');
    expect(lastVirtualizerConfig.count).toBe(1);
    expect(container.querySelector('[data-thread-count="3"]')).not.toBeNull();
  });

  it('flat: every message is its own row and nothing is threaded', async () => {
    const { container } = await mount('flat');
    expect(lastVirtualizerConfig.count).toBe(3);
    expect(container.querySelector('[data-thread-count]')).toBeNull();
  });

  it('header button cycles grouped → expandable → flat → grouped', async () => {
    await mount('grouped');
    const { useSettingsStore } = await import('../../stores/settingsStore');
    const btn = screen.getByTestId('thread-mode-toggle');
    expect(btn.getAttribute('data-thread-mode')).toBe('grouped');
    fireEvent.click(btn);
    expect(useSettingsStore.getState().setThreadMode).toHaveBeenLastCalledWith('expandable');
    useSettingsStore.setState({ threadMode: 'expandable' });
    cleanup(); await mount('expandable');
    fireEvent.click(screen.getByTestId('thread-mode-toggle'));
    expect(useSettingsStore.getState().setThreadMode).toHaveBeenLastCalledWith('flat');
    cleanup(); await mount('flat');
    fireEvent.click(screen.getByTestId('thread-mode-toggle'));
    expect(useSettingsStore.getState().setThreadMode).toHaveBeenLastCalledWith('grouped');
  });

  it('header button is hidden while the list is grouped by sender', async () => {
    const { useSettingsStore } = await import('../../stores/settingsStore');
    useSettingsStore.setState({ emailListGrouping: 'sender' });
    try {
      await mount('grouped');
      expect(screen.queryByTestId('thread-mode-toggle')).toBeNull();
      expect(screen.getByTestId('unread-filter-toggle')).toBeTruthy();
    } finally {
      useSettingsStore.setState({ emailListGrouping: 'chronological' });
    }
  });

  it('expandable: the chevron unfolds the replies under the thread row, and folds them back', async () => {
    const { container } = await mount('expandable');
    expect(lastVirtualizerConfig.count).toBe(1);
    const chevron = screen.getByTestId('thread-expand');
    expect(chevron.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(chevron);
    await settle();
    expect(lastVirtualizerConfig.count).toBe(4);
    const members = container.querySelectorAll('[data-testid="thread-member-row"]');
    expect(members.length).toBe(3);
    expect([...members].map(n => n.querySelector('[data-testid="email-row"]').getAttribute('data-uid'))).toEqual(['1', '2', '3']);
    expect(screen.getByTestId('thread-expand').getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByTestId('thread-expand'));
    await settle();
    expect(lastVirtualizerConfig.count).toBe(1);
    expect(container.querySelector('[data-testid="thread-member-row"]')).toBeNull();
  });

  it('expandable: members follow threadSortOrder', async () => {
    const { useSettingsStore } = await import('../../stores/settingsStore');
    useSettingsStore.setState({ threadSortOrder: 'newest-first' });
    try {
      const { container } = await mount('expandable');
      fireEvent.click(screen.getByTestId('thread-expand'));
      await settle();
      const subjects = [...container.querySelectorAll('[data-testid="thread-member-row"] [data-testid="email-row"]')]
        .map(n => n.getAttribute('data-uid'));
      expect(subjects).toEqual(['3', '2', '1']);
    } finally {
      useSettingsStore.setState({ threadSortOrder: 'oldest-first' });
    }
  });

  it('expandable: changing threadSortOrder while unfolded re-orders the members in place', async () => {
    const { useSettingsStore } = await import('../../stores/settingsStore');
    const { container, rerender } = await mount('expandable');
    fireEvent.click(screen.getByTestId('thread-expand'));
    await settle();
    const uids = () => [...container.querySelectorAll('[data-testid="thread-member-row"] [data-testid="email-row"]')].map(n => n.getAttribute('data-uid'));
    expect(uids()).toEqual(['1', '2', '3']);
    try {
      useSettingsStore.setState({ threadSortOrder: 'newest-first' });
      const { EmailList } = await import('../EmailList.jsx');
      rerender(React.createElement(EmailList.type));
      await settle();
      expect(uids()).toEqual(['3', '2', '1']);
    } finally {
      useSettingsStore.setState({ threadSortOrder: 'oldest-first' });
    }
  });

  it('grouped: no chevron is drawn', async () => {
    await mount('grouped');
    expect(screen.queryByTestId('thread-expand')).toBeNull();
  });

  it('clicking the chevron does not open the thread', async () => {
    await mount('expandable');
    const { useMailStore } = await import('../../stores/mailStore');
    useMailStore.getState().selectThread.mockClear();
    fireEvent.click(screen.getByTestId('thread-expand'));
    expect(useMailStore.getState().selectThread).not.toHaveBeenCalled();
  });

  // A mode switch is a live setting change, not a remount: the row cache must
  // notice that the same threads now want different rows.
  it('switching to expandable while mounted grows a chevron that still unfolds', async () => {
    const { useSettingsStore } = await import('../../stores/settingsStore');
    const { rerender } = await mount('grouped');
    expect(screen.queryByTestId('thread-expand')).toBeNull();
    expect(lastVirtualizerConfig.count).toBe(1);

    const { EmailList } = await import('../EmailList.jsx');
    useSettingsStore.setState({ threadMode: 'expandable' });
    rerender(React.createElement(EmailList.type));
    await settle();

    const chevron = screen.getByTestId('thread-expand');
    expect(chevron).not.toBeNull();
    fireEvent.click(chevron);
    await settle();
    expect(lastVirtualizerConfig.count).toBe(4);
  });
});
