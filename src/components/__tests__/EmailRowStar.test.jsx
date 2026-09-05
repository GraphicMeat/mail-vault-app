// @vitest-environment jsdom

// The star on a list row, in both row variants.
//
// Three things it has to get right: a lit star is always drawn (it is the
// information a starred-mail list exists for), an unlit one only on hover (an
// empty star on every row of a long list is noise), and the click acts on the
// row it is drawn in — by SELECTION key, not uid, since a merged Sent copy and
// the folder's own message share a number — without also opening the message.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  // Every icon resolves — a hand-listed set breaks the moment a shared
  // primitive imports one more glyph.
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
vi.mock('../LinkAlertIcon', () => ({ LinkAlertIcon: () => null }));
vi.mock('../SenderAlertIcon', () => ({ SenderAlertIcon: () => null, getSenderAlertLevel: () => null }));
vi.mock('../ReplyToAlertIcon', () => ({ ReplyToAlertIcon: () => null, getThreadReplyToMismatch: () => null }));
vi.mock('../TrackerAlertIcon', () => ({ TrackerAlertIcon: () => null }));
vi.mock('../RowActionMenu', () => ({ RowActionMenu: () => null }));
vi.mock('../RowActionMenuItems', () => ({ RowActionMenuItems: () => null }));
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
  // Callable as a hook AND carrying .getState() — EmailRow does both.
  const state = { serverUids: { complete: false }, activeMailbox: 'INBOX', activeAccountId: 'acct-1' };
  const hook = (selector) => (selector ? selector(state) : state);
  hook.getState = () => state;
  return { useMailStore: hook };
});

const { EmailRow, CompactEmailRow } = await import('../EmailRow');

const toggleFlagged = vi.fn();
const onSelect = vi.fn();

const email = (extra = {}) => ({
  uid: 42, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', isArchived: false,
  subject: 'Senate budget review', from: { name: 'Padme', address: 'padme@naboo.gov' },
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'], ...extra,
});

const rowProps = () => ({
  isSelected: false, onSelect, onToggleSelection: vi.fn(), isChecked: false, style: {},
  actions: { saveEmailLocally: vi.fn(), saveEmailsLocally: vi.fn(), toggleFlagged },
  menuOpen: false, onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), onRequestDelete: vi.fn(),
  isSaving: false, onStartSaving: vi.fn(), onStopSaving: vi.fn(),
});

const variants = [
  ['EmailRow', (e) => <EmailRow email={e} {...rowProps()} />],
  ['CompactEmailRow', (e) => <CompactEmailRow email={e} {...rowProps()} />],
];

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

for (const [name, renderRow] of variants) {
  describe(`${name} — star`, () => {
    it('draws a flagged row\'s star lit and never hides it', () => {
      render(renderRow(email({ flags: ['\\Seen', '\\Flagged'] })));

      const star = screen.getByTestId('star-toggle');
      expect(star.getAttribute('aria-pressed')).toBe('true');
      expect(star.className).not.toMatch(/\binvisible\b/);
      expect(star.getAttribute('aria-label')).toBe('Remove star');
    });

    it('keeps an unflagged row\'s star out of the way until the row is hovered', () => {
      render(renderRow(email()));

      const star = screen.getByTestId('star-toggle');
      expect(star.getAttribute('aria-pressed')).toBe('false');
      expect(star.className).toMatch(/\binvisible\b/);
      expect(star.className).toMatch(/group-hover:visible/);
      expect(star.getAttribute('aria-label')).toBe('Star');
    });

    it('toggles this row and does not open the message', () => {
      render(renderRow(email()));

      fireEvent.click(screen.getByTestId('star-toggle'));

      // The mocked store is a single-folder INBOX view, so the row's selection
      // key is its bare uid.
      expect(toggleFlagged).toHaveBeenCalledWith(42);
      expect(onSelect).not.toHaveBeenCalled();
    });
  });
}
