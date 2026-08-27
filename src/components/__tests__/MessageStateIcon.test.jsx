// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

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

// Minimal zustand-like mock — mirrors the pattern EmailList.test.js uses for
// the same store, so ConnectedStateIcon's useMailStore(selector) calls and
// useMailStore.getState() both resolve against one mutable object.
let mockStoreState;
vi.mock('../../stores/mailStore', () => {
  const hook = vi.fn((selector) => selector(mockStoreState));
  hook.getState = () => mockStoreState;
  return { useMailStore: hook };
});

import { describeMessageState, MessageStateIcon, ConnectedStateIcon } from '../email/MessageStateIcon';

const server = { source: 'server', isArchived: false };
const archived = { source: 'server', isArchived: true };
const localOnly = { source: 'local-only', isArchived: true };

describe('describeMessageState', () => {
  // id, email, backedUp, serverKnown, icon, tone, dot
  const table = [
    ['server-only',                             server,    false, true,  'cloud', 'server',  null],
    ['server-only-backed-up',                   server,    true,  true,  'cloud', 'server',  'filled'],
    ['server-only-backup-unknown',              server,    null,  true,  'cloud', 'server',  'hollow'],
    ['archived',                                archived,  false, true,  'drive', 'local',   null],
    ['archived-backed-up',                      archived,  true,  true,  'drive', 'local',   'filled'],
    ['archived-backup-unknown',                 archived,  null,  true,  'drive', 'local',   'hollow'],
    ['archived-server-unknown',                 archived,  false, false, 'drive', 'local',   null],
    ['archived-server-unknown-backed-up',       archived,  true,  false, 'drive', 'local',   'filled'],
    ['archived-server-unknown-backup-unknown',  archived,  null,  false, 'drive', 'local',   'hollow'],
    ['local-only',                              localOnly, false, true,  'cloud-off', 'only-copy', null],
    ['local-only-backed-up',                    localOnly, true,  true,  'cloud-off', 'only-copy', 'filled'],
    ['local-only-backup-unknown',               localOnly, null,  true,  'cloud-off', 'only-copy', 'hollow'],
  ];

  for (const [id, email, backedUp, serverKnown, icon, tone, dot] of table) {
    it(`maps to ${id}`, () => {
      const s = describeMessageState(email, { backedUp, serverKnown });
      expect(s.id).toBe(id);
      expect(s.icon).toBe(icon);
      expect(s.tone).toBe(tone);
      expect(s.dot).toBe(dot);
      expect(s.label).toBeTruthy();
      expect(s.detail).toBeTruthy();
    });
  }

  it('never renders the only-copy tone for a vault row with no proof on it', () => {
    // The whole point: gold is a claim that needs proof, and the proof rides
    // on the message (see stores/slices/custody.js). Completeness of the
    // active mailbox's uid set is not proof in either direction — it speaks
    // for one mailbox, and a message archived out of INBOX is still there.
    for (const backedUp of [true, false, null]) {
      for (const serverKnown of [true, false]) {
        const s = describeMessageState({ isArchived: true }, { backedUp, serverKnown });
        expect(s.tone).not.toBe('only-copy');
        const stamped = describeMessageState({ isArchived: true, serverDeleted: true }, { backedUp, serverKnown });
        expect(stamped.tone).toBe('only-copy');
      }
    }
  });

  it('treats a server-sourced row as server-known regardless of the flag', () => {
    // A row in `emails` came from the server by construction.
    expect(describeMessageState(server, { backedUp: false, serverKnown: false }).id)
      .toBe('server-only');
  });

  it('fails closed: an unstamped message is never amber, options or not', () => {
    // The gate still requires proof — the proof just lives on the message now
    // rather than in the caller's options, because a uid set could only ever
    // speak for one mailbox. A caller passing nothing gets the quiet state.
    const unstamped = { isArchived: true };
    expect(describeMessageState(unstamped).tone).not.toBe('only-copy');
    expect(describeMessageState(unstamped, { backedUp: false }).tone).not.toBe('only-copy');
    // And a stamped one is amber without being told anything about the server.
    expect(describeMessageState({ isArchived: true, serverDeleted: true }).tone).toBe('only-copy');
  });
});

describe('MessageStateIcon', () => {
  afterEach(() => cleanup());

  it('exposes the state id as a data attribute', () => {
    render(<MessageStateIcon email={{ source: 'local-only', isArchived: true }} backedUp={true} serverKnown={true} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('local-only-backed-up');
  });

  it('shows the tooltip on hover and hides it on leave', () => {
    render(<MessageStateIcon email={{ source: 'server', isArchived: false }} />);
    expect(screen.queryByTestId('msg-state-tooltip')).toBeNull();

    fireEvent.mouseEnter(screen.getByTestId('msg-state-icon'));
    expect(screen.getByTestId('msg-state-tooltip').textContent).toContain('On the server');

    fireEvent.mouseLeave(screen.getByTestId('msg-state-icon'));
    expect(screen.queryByTestId('msg-state-tooltip')).toBeNull();
  });

  it('shows the tooltip on keyboard focus', () => {
    // Focus is the a11y path AND the only trigger the e2e harness can drive.
    render(<MessageStateIcon email={{ source: 'server', isArchived: true }} serverKnown={false} />);
    const icon = screen.getByTestId('msg-state-icon');
    expect(icon.getAttribute('tabindex')).toBe('0');

    fireEvent.focus(icon);
    expect(screen.getByTestId('msg-state-tooltip').textContent).toContain('Server copy not verified yet');
  });

  it('renders a cloud for server rows and a drive for vault rows', () => {
    const { rerender } = render(<MessageStateIcon email={{ source: 'server', isArchived: false }} />);
    expect(document.querySelector('[data-icon="Cloud"]')).not.toBeNull();

    rerender(<MessageStateIcon email={{ source: 'server', isArchived: true }} />);
    expect(document.querySelector('[data-icon="HardDrive"]')).not.toBeNull();
  });

  it('flips above the icon when there is no room below, so the bottom legend stays visible', () => {
    // The legend sits on the window's bottom edge. A below-anchored tooltip
    // there renders off-screen entirely — the reported bug.
    const rect = (top, left) => () => ({ top, left, bottom: top + 14, right: left + 14, width: 14, height: 14, x: left, y: top });
    render(<MessageStateIcon email={{ source: 'server', isArchived: false }} />);
    const icon = screen.getByTestId('msg-state-icon');

    icon.getBoundingClientRect = rect(window.innerHeight - 20, 400);
    fireEvent.focus(icon);
    let style = screen.getByTestId('msg-state-tooltip').style;
    expect(style.bottom).not.toBe('');
    expect(style.top).toBe('');

    fireEvent.blur(icon);
    icon.getBoundingClientRect = rect(100, 400);
    fireEvent.focus(icon);
    style = screen.getByTestId('msg-state-tooltip').style;
    expect(style.top).toBe('120px');
    expect(style.bottom).toBe('');
  });

  it('clamps a tooltip on an icon near the viewport edge', () => {
    render(<MessageStateIcon email={{ source: 'server', isArchived: false }} />);
    const icon = screen.getByTestId('msg-state-icon');

    icon.getBoundingClientRect = () => ({ top: 100, left: 4, bottom: 114, right: 18, width: 14, height: 14, x: 4, y: 100 });
    fireEvent.focus(icon);
    // Centred it would be at 11px, putting half of a 240px box off-screen.
    expect(screen.getByTestId('msg-state-tooltip').style.left).toBe('128px');
  });

  it('closes the tooltip on scroll, including a non-bubbling scroll from a nested container', () => {
    // Virtualized-list rows scroll an internal container, and `scroll`
    // events don't bubble — testing-library's default `scroll` init is
    // { bubbles: false }, same as the real DOM. A listener that isn't on
    // the capture phase would never see this and the test would fail.
    render(<MessageStateIcon email={{ source: 'server', isArchived: false }} />);
    const icon = screen.getByTestId('msg-state-icon');

    fireEvent.focus(icon);
    expect(screen.getByTestId('msg-state-tooltip')).toBeTruthy();

    fireEvent.scroll(icon);
    expect(screen.queryByTestId('msg-state-tooltip')).toBeNull();
  });
});

describe('ConnectedStateIcon', () => {
  afterEach(() => cleanup());

  // Every fixture states the scope it scanned. Absence from backedUpKeys only
  // means "not mirrored" for a mailbox that was actually read.
  const store = (over = {}) => ({
    backedUpKeys: null,
    backedUpScopes: null,
    backupConfigured: true,
    serverUids: { uids: new Set(), complete: true },
    activeAccountId: 'acc1',
    activeMailbox: 'INBOX',
    ...over,
  });
  const dotOf = () => document.querySelector('[data-dot]')?.getAttribute('data-dot') ?? null;

  // The one rule the whole task hinges on: backedUpKeys === null ("could not
  // determine") must reach the icon as backedUp: null (hollow dot), never
  // collapse via ?.has()/|| into false ("not mirrored" — a different claim).
  it('renders a hollow dot when backedUpKeys is null, not no dot at all', () => {
    mockStoreState = store({ backedUpKeys: null });
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', source: 'server', isArchived: false }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('server-only-backup-unknown');
    expect(dotOf()).toBe('hollow');
  });

  it('renders a filled dot when the accountId:mailbox:uid key is present in backedUpKeys', () => {
    mockStoreState = store({ backedUpKeys: new Set(['acc1:INBOX:5']), backedUpScopes: new Set(['acc1:INBOX']) });
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', _mailbox: 'INBOX', source: 'server', isArchived: false }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('server-only-backed-up');
    expect(dotOf()).toBe('filled');
  });

  it('renders no dot when backedUpKeys is a defined Set without this key (proven not mirrored)', () => {
    mockStoreState = store({ backedUpKeys: new Set(['acc1:INBOX:999']), backedUpScopes: new Set(['acc1:INBOX']) });
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', _mailbox: 'INBOX', source: 'server', isArchived: false }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('server-only');
    expect(dotOf()).toBeNull();
  });

  it('falls back to the active account id when the email carries none', () => {
    mockStoreState = store({ backedUpKeys: new Set(['acc1:INBOX:5']), backedUpScopes: new Set(['acc1:INBOX']) });
    render(<ConnectedStateIcon email={{ uid: 5, source: 'server', isArchived: false }} />);
    expect(dotOf()).toBe('filled');
  });

  it('falls back to the active mailbox when the row carries no folder tag', () => {
    mockStoreState = store({
      activeMailbox: 'Archive',
      backedUpKeys: new Set(['acc1:Archive:5']),
      backedUpScopes: new Set(['acc1:Archive']),
    });
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', source: 'server', isArchived: false }} />);
    expect(dotOf()).toBe('filled');
  });

  it('reads a unified row as INBOX when it carries no folder tag', () => {
    mockStoreState = store({
      activeMailbox: 'UNIFIED',
      backedUpKeys: new Set(['acc2:INBOX:5']),
      backedUpScopes: new Set(['acc2:INBOX']),
    });
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc2', source: 'server', isArchived: false }} />);
    expect(dotOf()).toBe('filled');
  });

  // The bug this key shape exists for. INBOX threads merge Sent copies
  // (getChatEmails stamps them `_mailbox: <sent path>`), and a uid names a
  // message only inside one mailbox — so keyed by account alone, Sent uid 4102
  // matched INBOX's mirror entry 4102 and wore a filled dot it never earned.
  it('does not let an INBOX mirror entry answer for a Sent row with the same uid', () => {
    mockStoreState = store({
      backedUpKeys: new Set(['acc1:INBOX:4102']),
      backedUpScopes: new Set(['acc1:INBOX', 'acc1:Sent']),
    });
    render(<ConnectedStateIcon email={{ uid: 4102, _accountId: 'acc1', _mailbox: 'Sent', source: 'server', isArchived: false }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('server-only');
    expect(dotOf()).toBeNull();
  });

  it('still answers the INBOX row that mirror entry really belongs to', () => {
    mockStoreState = store({
      backedUpKeys: new Set(['acc1:INBOX:4102']),
      backedUpScopes: new Set(['acc1:INBOX', 'acc1:Sent']),
    });
    render(<ConnectedStateIcon email={{ uid: 4102, _accountId: 'acc1', _mailbox: 'INBOX', source: 'server', isArchived: false }} />);
    expect(dotOf()).toBe('filled');
  });

  // Same shape as backedUpKeys === null, one scope down: nobody read this
  // mailbox, so "not on the backup drive" is a claim we have not earned.
  it('says unknown, not "not mirrored", for a mailbox the scan never read', () => {
    mockStoreState = store({
      backedUpKeys: new Set(['acc1:INBOX:5']),
      backedUpScopes: new Set(['acc1:INBOX']),
    });
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', _mailbox: 'Drafts', source: 'server', isArchived: false }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('server-only-backup-unknown');
    expect(dotOf()).toBe('hollow');
  });

  it('says unknown for a row belonging to an account the scan never read', () => {
    mockStoreState = store({
      backedUpKeys: new Set(['acc1:INBOX:5']),
      backedUpScopes: new Set(['acc1:INBOX']),
    });
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc2', _mailbox: 'INBOX', source: 'server', isArchived: false }} />);
    expect(dotOf()).toBe('hollow');
  });

  // A user who has never set up a backup drive should not be told about one.
  // `backedUpKeys === null` says "could not read the drive"; this says there is
  // no drive, and the axis simply does not apply.
  it('draws no dot at all when no backup location is configured', () => {
    mockStoreState = store({ backupConfigured: false, backedUpKeys: null });
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', _mailbox: 'INBOX', source: 'local-only', isArchived: true }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('local-only');
    expect(dotOf()).toBeNull();
  });

  it('still draws the hollow dot for a configured drive it could not read', () => {
    mockStoreState = store({ backupConfigured: true, backedUpKeys: null });
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', _mailbox: 'INBOX', source: 'local-only', isArchived: true }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('local-only-backup-unknown');
    expect(dotOf()).toBe('hollow');
  });

  it('renders the only-copy tone for a row the list stamped local-only', () => {
    mockStoreState = store({ backedUpKeys: new Set(), backedUpScopes: new Set(['acc1:INBOX']) });
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', _mailbox: 'INBOX', source: 'local-only', isArchived: true }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('local-only');
  });

  it('leaves an archived row alone when the only thing missing is the uid set', () => {
    mockStoreState = store({ backedUpKeys: new Set(), backedUpScopes: new Set(['acc1:INBOX']) });
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', _mailbox: 'INBOX', source: 'local', isArchived: true }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('archived');
  });

  // Regression guard for the contradiction Rokas reported: the dot is a
  // MODIFIER riding on all three base glyphs, so it must not be painted in any
  // base state's colour token. Green pip + blue cloud + "Not saved to your
  // vault yet" was one visual channel answering two questions.
  it('paints the backup dot in no custody colour at all', () => {
    mockStoreState = store({ backedUpKeys: new Set(['acc1:INBOX:5']), backedUpScopes: new Set(['acc1:INBOX']) });
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', _mailbox: 'INBOX', source: 'server', isArchived: false }} />);
    const cls = document.querySelector('[data-dot="filled"]').getAttribute('class');
    for (const token of ['mail-local', 'mail-server', 'mail-only-copy']) {
      expect(cls).not.toContain(token);
    }
  });
});

// The bold line is what a scanning eye reads. "On the server and backup drive"
// named two places, neither of them the vault, and left the one fact that
// matters to a detail line the user may never open.
describe('server-only labels never imply the vault has it', () => {
  it('names the vault absence in the label when the drive has it too', () => {
    expect(describeMessageState(server, { backedUp: true, serverKnown: true }).label)
      .toContain('not in your vault');
  });

  it('says so in every server-only variant, label or detail', () => {
    for (const backedUp of [false, true, null]) {
      const s = describeMessageState(server, { backedUp, serverKnown: true });
      expect(`${s.label} ${s.detail}`.toLowerCase()).toContain('vault');
    }
  });
});
