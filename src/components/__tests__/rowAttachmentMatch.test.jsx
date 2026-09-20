// @vitest-environment jsdom

// A search hit whose only match is inside an attachment looked exactly like a
// hit on the subject or the body: the user opened it, read the message, found
// nothing, and had no way to learn the term was in the PDF. The row's own
// paperclip says it — `matchedIn` comes back from the offline index
// (search_index.rs assemble_rows) and is otherwise unread by the app.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
const marker = () => <span data-testid="alert-icon" />;
vi.mock('../LinkAlertIcon', () => ({ LinkAlertIcon: marker }));
vi.mock('../SenderAlertIcon', () => ({ SenderAlertIcon: marker, getSenderAlertLevel: () => null }));
vi.mock('../ReplyToAlertIcon', () => ({ ReplyToAlertIcon: marker, getThreadReplyToMismatch: () => false }));
vi.mock('../TrackerAlertIcon', () => ({ TrackerAlertIcon: marker, getThreadTrackerInfo: () => null }));
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
  const state = { serverUids: { complete: false }, activeMailbox: 'INBOX', activeAccountId: 'acct-1' };
  const hook = (selector) => (selector ? selector(state) : state);
  hook.getState = () => state;
  return { useMailStore: hook };
});

const { EmailRow, CompactEmailRow } = await import('../EmailRow');

const email = (extra = {}) => ({
  uid: 42, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', isArchived: false,
  subject: 'Senate budget review', from: { name: 'Padme', address: 'padme@naboo.gov' },
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'], hasAttachments: true,
  ...extra,
});

const shared = () => ({
  style: {},
  actions: { saveEmailLocally: vi.fn(), saveEmailsLocally: vi.fn(), toggleFlagged: vi.fn() },
  menuOpen: false, onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), onRequestDelete: vi.fn(),
  isSaving: false, onStartSaving: vi.fn(), onStopSaving: vi.fn(),
});

const rows = {
  EmailRow: (e) => <EmailRow email={e} isSelected={false} isChecked={false}
    onSelect={vi.fn()} onToggleSelection={vi.fn()} {...shared()} />,
  CompactEmailRow: (e) => <CompactEmailRow email={e} isSelected={false} isChecked={false}
    onSelect={vi.fn()} onToggleSelection={vi.fn()} {...shared()} />,
};

afterEach(cleanup);

for (const [name, renderRow] of Object.entries(rows)) {
  describe(`${name} — the attachment carried the match`, () => {
    it('marks the paperclip when matchedIn names the attachment', () => {
      const { container } = render(renderRow(email({ matchedIn: ['attachment'] })));
      const clip = container.querySelector('[data-testid="attachment-match"]');
      expect(clip).not.toBeNull();
      expect(clip.getAttribute('title')).toBeTruthy();
    });

    it('leaves the paperclip plain for a subject or body match', () => {
      const { container } = render(renderRow(email({ matchedIn: ['subject', 'body'] })));
      expect(container.querySelector('[data-testid="attachment-match"]')).toBeNull();
      expect(container.querySelector('[data-icon="Paperclip"]')).not.toBeNull();
    });

    it('leaves it plain outside a search, where matchedIn is absent', () => {
      const { container } = render(renderRow(email()));
      expect(container.querySelector('[data-testid="attachment-match"]')).toBeNull();
    });
  });
}
