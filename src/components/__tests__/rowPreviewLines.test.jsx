// @vitest-environment jsdom

// "Display 1 or 2 or 3 lines of email preview when everything is indexed."
// The preview is the row's `snippet`, which the daemon attaches from the
// offline search index; the list's virtualizer places rows by arithmetic, so
// a row's height is its layout's plus N fixed-height lines, snippet or not.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';

vi.mock('../../stores/safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));
vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
vi.mock('../LinkAlertIcon', () => ({ LinkAlertIcon: () => null }));
vi.mock('../SenderAlertIcon', () => ({ SenderAlertIcon: () => null, getSenderAlertLevel: () => null }));
vi.mock('../ReplyToAlertIcon', () => ({ ReplyToAlertIcon: () => null, getThreadReplyToMismatch: () => false }));
vi.mock('../TrackerAlertIcon', () => ({ TrackerAlertIcon: () => null, getThreadTrackerInfo: () => null }));
vi.mock('../RowQuickActions', () => ({ RowQuickActions: () => null }));
vi.mock('../email/MessageStateIcon', () => ({
  ConnectedStateIcon: () => null,
  describeMessageState: () => ({ tone: 'local' }),
}));
vi.mock('../../utils/linkSafety', () => ({
  getLinkAlertLevel: () => null,
  getAlertsForEmails: () => [],
  getCachedAlerts: () => [],
}));
vi.mock('../../stores/mailStore', () => {
  const state = { serverUids: { complete: false }, activeMailbox: 'INBOX', activeAccountId: 'acct-1' };
  const hook = (selector) => (selector ? selector(state) : state);
  hook.getState = () => state;
  return { useMailStore: hook };
});

const { EmailRow, CompactEmailRow, listRowHeight, SNIPPET_LINE_PX } = await import('../EmailRow');
const { ThreadRow, CompactThreadRow } = await import('../ThreadRow');
const { useSettingsStore } = await import('../../stores/settingsStore');

const SNIPPET = 'Hi Ann, the invoice for September is attached. Let me know if anything looks off.';
const email = (extra = {}) => ({
  uid: 42, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', isArchived: false,
  subject: 'Invoice', from: { name: 'Bob', address: 'bob@example.com' },
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'], snippet: SNIPPET,
  ...extra,
});
const shared = () => ({
  style: {},
  actions: { saveEmailLocally: vi.fn(), saveEmailsLocally: vi.fn(), toggleFlagged: vi.fn() },
  onCloseMenu: vi.fn(), onRequestDelete: vi.fn(), isSaving: false, onStartSaving: vi.fn(), onStopSaving: vi.fn(),
});
const thread = (e) => ({ threadId: 't1', subject: e.subject, messageCount: 1, unreadCount: 0, emails: [e], lastEmail: e });

const rows = {
  EmailRow: (e) => <EmailRow email={e} isSelected={false} isChecked={false} onSelect={vi.fn()} onToggleSelection={vi.fn()} {...shared()} />,
  CompactEmailRow: (e) => <CompactEmailRow email={e} isSelected={false} isChecked={false} onSelect={vi.fn()} onToggleSelection={vi.fn()} {...shared()} />,
  ThreadRow: (e) => <ThreadRow thread={thread(e)} isSelected={false} anyChecked={false} onSelectThread={vi.fn()} onSetSelection={vi.fn()} {...shared()} />,
  CompactThreadRow: (e) => <CompactThreadRow thread={thread(e)} isSelected={false} anyChecked={false} onSelectThread={vi.fn()} onSetSelection={vi.fn()} {...shared()} />,
};

beforeEach(() => act(() => useSettingsStore.setState({ listPreviewLines: 0 })));
afterEach(cleanup);

for (const [name, renderRow] of Object.entries(rows)) {
  describe(`${name} preview lines`, () => {
    it('shows no preview while the setting is off', () => {
      const { container } = render(renderRow(email()));
      expect(container.querySelector('[data-testid="row-snippet"]')).toBeNull();
    });

    it('clamps the snippet to the chosen number of lines', () => {
      act(() => useSettingsStore.setState({ listPreviewLines: 2 }));
      const { container } = render(renderRow(email()));
      const snippet = container.querySelector('[data-testid="row-snippet"]');
      expect(snippet?.textContent).toBe(SNIPPET);
      expect(snippet.style.webkitLineClamp || snippet.style.WebkitLineClamp).toBe('2');
      expect(snippet.style.maxHeight).toBe(`${2 * SNIPPET_LINE_PX}px`);
    });

    it('shows nothing, not a placeholder, for a row whose body is not indexed', () => {
      act(() => useSettingsStore.setState({ listPreviewLines: 3 }));
      const { container } = render(renderRow(email({ snippet: undefined })));
      expect(container.querySelector('[data-testid="row-snippet"]')).toBeNull();
    });
  });
}

describe('row height', () => {
  it('is the layout height plus one fixed line per preview line', () => {
    expect(listRowHeight(false)).toBe(56);
    expect(listRowHeight(true)).toBe(52);
    expect(listRowHeight(true, 2)).toBe(52 + 2 * SNIPPET_LINE_PX);
    expect(listRowHeight(false, 3)).toBe(56 + 3 * SNIPPET_LINE_PX);
  });
});
