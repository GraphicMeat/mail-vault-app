// @vitest-environment jsdom

// A sample row in Settings shows its quick actions without being hovered,
// and hands them the set being configured, inert.
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
vi.mock('../LinkAlertIcon', () => ({ LinkAlertIcon: () => null }));
vi.mock('../SenderAlertIcon', () => ({ SenderAlertIcon: () => null, getSenderAlertLevel: () => null }));
vi.mock('../ReplyToAlertIcon', () => ({ ReplyToAlertIcon: () => null, getThreadReplyToMismatch: () => null }));
vi.mock('../TrackerAlertIcon', () => ({ TrackerAlertIcon: () => null }));
vi.mock('../RowQuickActions', () => ({
  RowQuickActions: ({ preview, configOverride }) => <div data-testid="row-quick-actions"
    data-preview={String(!!preview)} data-config={JSON.stringify(configOverride ?? null)} />,
}));
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

const email = {
  uid: 42, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', isArchived: false,
  subject: 'Senate budget review', from: { name: 'Padme', address: 'padme@naboo.gov' },
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'],
};
const noop = () => {};
const rowProps = {
  isSelected: false, onSelect: noop, onToggleSelection: noop, isChecked: false, style: {},
  actions: {}, menuOpen: false, onOpenMenu: noop, onCloseMenu: noop, onRequestDelete: noop,
  isSaving: false, onStartSaving: noop, onStopSaving: noop,
};
const CONFIG = { mode: 'inline', palette: 'neutral', entries: [{ id: 'archive', action: 'archive' }] };

afterEach(cleanup);

for (const [name, Row] of [['EmailRow', EmailRow], ['CompactEmailRow', CompactEmailRow]]) {
  describe(`${name} pinActions`, () => {
    it('mounts no quick actions on a row nobody hovered', () => {
      render(<Row email={email} {...rowProps} />);
      expect(document.querySelector('[data-testid="row-quick-actions"]')).toBeNull();
      expect(document.querySelector('[data-quick-actions-preview]')).toBeNull();
    });

    it('shows them without a hover and hands over the set, inert', () => {
      render(<Row email={email} {...rowProps} pinActions preview configOverride={CONFIG} />);
      const actions = document.querySelector('[data-testid="row-quick-actions"]');
      expect(actions).not.toBeNull();
      expect(actions.parentElement.className).not.toMatch(/(^|\s)invisible(\s|$)/);
      expect(actions.dataset.preview).toBe('true');
      expect(JSON.parse(actions.dataset.config)).toEqual(CONFIG);
      expect(document.querySelector('[data-testid="email-row"]').hasAttribute('data-quick-actions-preview')).toBe(true);
    });
  });
}
