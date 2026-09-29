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
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'], previewText: SNIPPET,
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
      const { container } = render(renderRow(email({ previewText: undefined })));
      expect(container.querySelector('[data-testid="row-snippet"]')).toBeNull();
    });

    it("shows a vault row's own snippet when the index has not attached one", () => {
      act(() => useSettingsStore.setState({ listPreviewLines: 1 }));
      const { container } = render(renderRow(email({ previewText: undefined, snippet: 'From the vault' })));
      expect(container.querySelector('[data-testid="row-snippet"]')?.textContent).toBe('From the vault');
    });

    // The sender column is a share of its container: a row with a preview
    // and one without must put the subject at the same x, so both get the
    // same wrapper.
    it('lays out a row with a preview and one without the same way', () => {
      act(() => useSettingsStore.setState({ listPreviewLines: 2 }));
      const depth = (e) => {
        const { container } = render(renderRow(e));
        let n = 0;
        for (let el = container.querySelector('[data-testid="row-sender"]'); el && el !== container; el = el.parentElement) n++;
        cleanup();
        return n;
      };
      expect(depth(email({ previewText: undefined }))).toBe(depth(email()));
    });
  });
}

describe('with the setting off', () => {
  it('adds nothing to a row, however much preview text it carries', () => {
    for (const renderRow of Object.values(rows)) {
      const plain = render(renderRow(email({ previewText: undefined, snippet: undefined }))).container.innerHTML;
      cleanup();
      const carrying = render(renderRow(email({ snippet: 'vault text' }))).container.innerHTML;
      cleanup();
      expect(carrying).toBe(plain);
    }
  });
});

describe('row height', () => {
  it('is the layout height plus one fixed line per preview line', () => {
    expect(listRowHeight(false)).toBe(56);
    expect(listRowHeight(true)).toBe(52);
    expect(listRowHeight(true, 2)).toBe(52 + 2 * SNIPPET_LINE_PX);
    expect(listRowHeight(false, 3)).toBe(56 + 3 * SNIPPET_LINE_PX);
  });
});

// Settings > Appearance > Layout > Message list density: the same lines with
// less air, and the virtualizer's arithmetic moves with them.
describe('list density', () => {
  afterEach(() => act(() => useSettingsStore.setState({ listDensity: 'comfortable' })));

  it('keeps the heights every list had, and takes a compact row in by a fixed amount', () => {
    expect(listRowHeight(false, 0, 'comfortable')).toBe(56);
    expect(listRowHeight(true, 0, 'comfortable')).toBe(52);
    expect(listRowHeight(false, 0, undefined)).toBe(56);
    expect(listRowHeight(false, 0, 'compact')).toBe(40);
    expect(listRowHeight(true, 0, 'compact')).toBe(44);
    expect(listRowHeight(true, 2, 'compact')).toBe(44 + 2 * SNIPPET_LINE_PX);
  });

  it('marks every row kind compact only while the setting is', () => {
    for (const renderRow of Object.values(rows)) {
      act(() => useSettingsStore.setState({ listDensity: 'comfortable' }));
      let row = render(renderRow(email())).container.querySelector('[data-testid="email-row"]');
      expect(row.classList.contains('row-dense')).toBe(false);
      cleanup();
      act(() => useSettingsStore.setState({ listDensity: 'compact' }));
      row = render(renderRow(email())).container.querySelector('[data-testid="email-row"]');
      expect(row.classList.contains('row-dense')).toBe(true);
      cleanup();
    }
  });

  // The two-line layout's text block carries its own padding: compact trims it
  // to fit 44px, and its gutter rises with it.
  it('trims the two-line layout\'s text block, and the gutter follows it', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../styles/index.css'), 'utf8');
    for (const renderRow of [rows.CompactEmailRow, rows.CompactThreadRow]) {
      act(() => useSettingsStore.setState({ listDensity: 'comfortable' }));
      expect(render(renderRow(email())).container.querySelector('.py-1\\.5 [data-testid="row-subject"]')).not.toBeNull();
      cleanup();
      act(() => useSettingsStore.setState({ listDensity: 'compact' }));
      const { container } = render(renderRow(email()));
      expect(container.querySelector('.py-1\\.5 [data-testid="row-subject"]')).toBeNull();
      expect(container.querySelector('.py-0\\.5 [data-testid="row-subject"]')).not.toBeNull();
      cleanup();
    }
    expect(css).toMatch(/\.row-compact\.row-dense\s*\{[^}]*--row-gutter-top:\s*2px/);
  });
});

describe('the preview in a row', () => {
  it('never prints an entity the snippet cap cut in half', () => {
    act(() => useSettingsStore.setState({ listPreviewLines: 2 }));
    const head = 'Mokėtina suma 40,25 EUR Būsime dėkingi, jeigu sąskaitą apmokėsite iki ';
    for (const renderRow of Object.values(rows)) {
      const { container } = render(renderRow(email({ previewText: `${head.repeat(3)}&scar` })));
      expect(container.querySelector('[data-testid="row-snippet"]').textContent).toBe(head.repeat(3).trim());
      cleanup();
    }
  });

  // The two-line layout hangs the preview out under the checkbox. The pull is
  // the gutter cell (20px) plus the row's gap: change either and it must move.
  it('hangs out over the two-line layout gutter by exactly the gutter cell and the row gap', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../styles/index.css'), 'utf8');
    act(() => useSettingsStore.setState({ listPreviewLines: 2 }));
    for (const renderRow of [rows.CompactEmailRow, rows.CompactThreadRow]) {
      const row = render(renderRow(email())).container.querySelector('[data-testid="email-row"]');
      expect(row.className).toMatch(/\bgap-2\b/);
      expect(row.className).toContain('row-compact');
      cleanup();
    }
    expect(css).toMatch(/\.row-compact \.row-snippet\s*\{\s*margin-left:\s*-28px;/);
    expect(css).toMatch(/\.row-gutter-slot\s*\{[^}]*width:\s*20px/);
  });
});
