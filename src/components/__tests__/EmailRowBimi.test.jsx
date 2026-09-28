// @vitest-environment jsdom

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
vi.mock('../TrackerAlertIcon', () => ({ TrackerAlertIcon: ({ info }) => info?.count ? <span data-testid="tracker-alert-icon" /> : null }));
vi.mock('../RowActionMenu', () => ({ RowActionMenu: () => null }));
vi.mock('../RowActionMenuItems', () => ({ RowActionMenuItems: () => null }));
// Renders the one hover action the rows own a handler for, so the archive case
// below can press it.
vi.mock('../RowQuickActions', () => ({
  RowQuickActions: ({ onArchive, openAt }) => <button data-testid="row-archive" onClick={onArchive}
    data-open-at={openAt ? `${openAt.x},${openAt.y}` : ''} />,
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
  // Callable as a hook AND carrying .getState() — EmailRow does both.
  const state = { serverUids: { complete: false }, activeMailbox: 'INBOX', activeAccountId: 'acct-1' };
  const hook = (selector) => (selector ? selector(state) : state);
  hook.getState = () => state;
  return { useMailStore: hook };
});

vi.mock('../../services/daemonClient', () => ({ daemonCall: vi.fn() }));
const { daemonCall } = await import('../../services/daemonClient');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { EmailRow, CompactEmailRow } = await import('../EmailRow');
const { _resetBimiLookups } = await import('../email/BimiLogo');

const LOGO = 'data:image/svg+xml;base64,PHN2Zy8+';
const email = (extra = {}) => ({
  uid: 42, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', isArchived: false,
  subject: 'Two books', from: { name: 'Blurb', address: 'news@blurb.test' },
  authenticationResults: 'mx.test; dkim=pass; dmarc=pass header.from=blurb.test',
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'], ...extra,
});
const rowProps = () => ({
  isSelected: false, onSelect: vi.fn(), onToggleSelection: vi.fn(), isChecked: false, style: {},
  actions: { saveEmailLocally: vi.fn(), saveEmailsLocally: vi.fn(), toggleFlagged: vi.fn() },
  menuOpen: false, onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), onRequestDelete: vi.fn(),
  isSaving: false, onStartSaving: vi.fn(), onStopSaving: vi.fn(),
});
const variants = [
  ['EmailRow', e => <EmailRow email={e} {...rowProps()} />],
  ['CompactEmailRow', e => <CompactEmailRow email={e} {...rowProps()} />],
];

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); _resetBimiLookups(); });

for (const [name, renderRow] of variants) {
  describe(`${name}: BIMI logo`, () => {
    // After the sender, before the star: it vouches for the NAME beside it,
    // and the star and alert glyphs keep their places.
    it('draws the brand logo right after the sender, before the star', async () => {
      daemonCall.mockResolvedValue({ logo: LOGO });
      render(renderRow(email()));
      const logo = await screen.findByTestId('bimi-logo');
      const sender = screen.getByTestId('row-sender');
      const star = screen.getByTestId('star-toggle');
      expect(sender.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(logo.compareDocumentPosition(star) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(logo.getAttribute('src')).toBe(LOGO);
    });

    it('asks nothing for a message without a DMARC pass', () => {
      render(renderRow(email({ authenticationResults: 'mx.test; dmarc=fail' })));
      expect(daemonCall).not.toHaveBeenCalled();
      expect(screen.queryByTestId('bimi-logo')).toBeNull();
    });

    // An archived row the list read from the vault (the registry's stored
    // parse) draws the logo like a server row: it carries the same header.
    it('draws the logo on an archived row read from the vault', async () => {
      daemonCall.mockResolvedValue({ logo: LOGO });
      render(renderRow(email({ source: 'local', isArchived: true, flags: ['\\Seen', 'archived'] })));
      expect((await screen.findByTestId('bimi-logo')).getAttribute('src')).toBe(LOGO);
      expect(daemonCall).toHaveBeenCalledWith('bimi_logo', {
        domain: 'blurb.test', authenticationResults: 'mx.test; dkim=pass; dmarc=pass header.from=blurb.test',
      });
    });

    // What a row parsed by an older build looks like: no header at all.
    it('asks nothing for a row without Authentication-Results', () => {
      render(renderRow(email({ authenticationResults: undefined, source: 'local', isArchived: true })));
      expect(daemonCall).not.toHaveBeenCalled();
      expect(screen.queryByTestId('bimi-logo')).toBeNull();
    });

    it('draws nothing but an SVG data URI', async () => {
      daemonCall.mockResolvedValue({ logo: 'data:text/html;base64,PHNjcmlwdD4=' });
      render(renderRow(email()));
      await vi.waitFor(() => expect(daemonCall).toHaveBeenCalledTimes(1));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(screen.queryByTestId('bimi-logo')).toBeNull();
    });
  });
}

// A failed lookup is not an answer: the next mount asks again and draws it.
it('asks again after a failed lookup', async () => {
  daemonCall.mockRejectedValueOnce(new Error('daemon down')).mockResolvedValue({ logo: LOGO });
  const e = email();
  render(<EmailRow email={e} {...rowProps()} />);
  await vi.waitFor(() => expect(daemonCall).toHaveBeenCalledTimes(1));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.queryByTestId('bimi-logo')).toBeNull();
  cleanup();
  render(<EmailRow email={e} {...rowProps()} />);
  expect((await screen.findByTestId('bimi-logo')).getAttribute('src')).toBe(LOGO);
  expect(daemonCall).toHaveBeenCalledTimes(2);
});

// A virtualized list remounts every row it scrolls back to. A domain with no
// logo is the common answer, and asking again on every scroll is a daemon
// round trip per row per frame.
it('asks once per message for a sender that has no logo, however often the row remounts', async () => {
  daemonCall.mockResolvedValue({ logo: null });
  const e = email();
  render(<EmailRow email={e} {...rowProps()} />);
  await vi.waitFor(() => expect(daemonCall).toHaveBeenCalledTimes(1));
  cleanup();
  render(<EmailRow email={e} {...rowProps()} />);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(daemonCall).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('bimi-logo')).toBeNull();
});

it('prints a preview line without the zero-width padding of a preheader', () => {
  daemonCall.mockResolvedValue({ logo: null });
  useSettingsStore.setState({ listPreviewLines: 2 });
  render(<EmailRow email={email({ previewText: 'Don’t miss 30% off. &zwnj; &zwnj; &zwnj;' })} {...rowProps()} />);
  expect(screen.getByTestId('row-snippet').textContent).toBe('Don’t miss 30% off.');
  useSettingsStore.setState({ listPreviewLines: 0 });
});
