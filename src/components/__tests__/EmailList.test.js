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
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

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
  return {
    RefreshCw: icon('RefreshCw'), HardDrive: icon('HardDrive'), Cloud: icon('Cloud'), CloudOff: icon('CloudOff'),
    Paperclip: icon('Paperclip'), MoreHorizontal: icon('MoreHorizontal'), Trash2: icon('Trash2'),
    CheckSquare: icon('CheckSquare'), Square: icon('Square'), Archive: icon('Archive'),
    X: icon('X'), Layers: icon('Layers'), Search: icon('Search'),
    MessageSquare: icon('MessageSquare'), Users: icon('Users'), Mail: icon('Mail'),
    AlertTriangle: icon('AlertTriangle'),
  };
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

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: vi.fn((selector) => {
    const state = {
      emailListStyle: 'default',
      emailListGrouping: 'chronological',
      setEmailListGrouping: vi.fn(),
      layoutMode: 'three-column',
      accountColors: {},
    };
    return selector(state);
  }),
  getAccountColor: () => '#888',
  getAccountInitial: () => 'T',
  hashColor: () => '#888',
}));

vi.mock('../../utils/emailParser', async (importOriginal) => ({
  ...(await importOriginal()),
  buildThreads: (emails) => {
    // Return a simple Map: each email is its own thread
    const map = new Map();
    if (emails && emails.length) {
      emails.forEach((e) => {
        map.set(e.uid, {
          threadId: String(e.uid),
          messageCount: 1,
          emails: [e],
          lastDate: new Date(e.date),
        });
      });
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
