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

  it('never renders the only-copy tone when the server is unverified', () => {
    // The whole point: amber is a claim that needs proof.
    for (const backedUp of [true, false, null]) {
      const s = describeMessageState(localOnly, { backedUp, serverKnown: false });
      expect(s.tone).not.toBe('only-copy');
    }
  });

  it('treats a server-sourced row as server-known regardless of the flag', () => {
    // A row in `emails` came from the server by construction.
    expect(describeMessageState(server, { backedUp: false, serverKnown: false }).id)
      .toBe('server-only');
  });

  it('fails closed: no options object means no proof, so never amber', () => {
    // The gate exists to require proof. A caller that forgets to pass
    // serverKnown must not get the alarm by default.
    expect(describeMessageState(localOnly).tone).not.toBe('only-copy');
    expect(describeMessageState(localOnly, { backedUp: false }).tone).not.toBe('only-copy');
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

  // The one rule the whole task hinges on: backedUpKeys === null ("could not
  // determine") must reach the icon as backedUp: null (hollow dot), never
  // collapse via ?.has()/|| into false ("not mirrored" — a different claim).
  it('renders a hollow dot when backedUpKeys is null, not no dot at all', () => {
    mockStoreState = { backedUpKeys: null, serverUids: { uids: new Set(), complete: true }, activeAccountId: 'acc1' };
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', source: 'server', isArchived: false }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('server-only-backup-unknown');
    expect(document.querySelector('[data-dot="hollow"]')).not.toBeNull();
  });

  it('renders a filled dot when the accountId:uid key is present in backedUpKeys', () => {
    mockStoreState = { backedUpKeys: new Set(['acc1:5']), serverUids: { uids: new Set(), complete: true }, activeAccountId: 'acc1' };
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', source: 'server', isArchived: false }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('server-only-backed-up');
    expect(document.querySelector('[data-dot="filled"]')).not.toBeNull();
  });

  it('renders no dot when backedUpKeys is a defined Set without this key (proven not mirrored)', () => {
    mockStoreState = { backedUpKeys: new Set(['acc1:999']), serverUids: { uids: new Set(), complete: true }, activeAccountId: 'acc1' };
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', source: 'server', isArchived: false }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('server-only');
    expect(document.querySelector('[data-dot]')).toBeNull();
  });

  it('falls back to the active account id when the email carries none', () => {
    mockStoreState = { backedUpKeys: new Set(['acc1:5']), serverUids: { uids: new Set(), complete: true }, activeAccountId: 'acc1' };
    render(<ConnectedStateIcon email={{ uid: 5, source: 'server', isArchived: false }} />);
    expect(document.querySelector('[data-dot="filled"]')).not.toBeNull();
  });

  it('passes server uid completeness through so a local-only row proven gone renders the only-copy tone', () => {
    mockStoreState = { backedUpKeys: new Set(), serverUids: { uids: new Set(), complete: true }, activeAccountId: 'acc1' };
    render(<ConnectedStateIcon email={{ uid: 5, _accountId: 'acc1', source: 'local-only', isArchived: true }} />);
    expect(screen.getByTestId('msg-state-icon').getAttribute('data-state')).toBe('local-only');
  });
});
