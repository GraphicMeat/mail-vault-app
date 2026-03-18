// @vitest-environment jsdom

// Stub ResizeObserver for jsdom
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

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
    RefreshCw: icon('RefreshCw'), HardDrive: icon('HardDrive'), Cloud: icon('Cloud'),
    Paperclip: icon('Paperclip'), MoreHorizontal: icon('MoreHorizontal'), Trash2: icon('Trash2'),
    CheckSquare: icon('CheckSquare'), Square: icon('Square'), Archive: icon('Archive'),
    X: icon('X'), Layers: icon('Layers'), Search: icon('Search'),
    MessageSquare: icon('MessageSquare'), Users: icon('Users'),
  };
});

// Mock child components
vi.mock('../SearchBar', () => ({ SearchBar: () => null }));
vi.mock('../BulkOperationsModal', () => ({ BulkOperationsModal: () => null }));
vi.mock('../BulkOperationProgress', () => ({ BulkOperationProgress: () => null }));
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

vi.mock('../../stores/mailStore', () => ({
  useMailStore: vi.fn((selector) => {
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
      saveEmailLocally: vi.fn(),
      removeLocalEmail: vi.fn(),
      deleteEmailFromServer: vi.fn(),
      unifiedInbox: false,
    };
    return selector(state);
  }),
}));

vi.mock('../../stores/searchStore', () => ({
  useSearchStore: vi.fn((selector) => {
    const state = {
      searchActive: false,
      searchResults: [],
      clearSearch: vi.fn(),
    };
    return selector(state);
  }),
}));

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

vi.mock('../../utils/emailParser', () => ({
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
});
