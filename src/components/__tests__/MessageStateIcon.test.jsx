// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return { Cloud: icon('Cloud'), HardDrive: icon('HardDrive') };
});

import { describeMessageState, MessageStateIcon } from '../email/MessageStateIcon';

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
    ['local-only',                              localOnly, false, true,  'drive', 'warning', null],
    ['local-only-backed-up',                    localOnly, true,  true,  'drive', 'warning', 'filled'],
    ['local-only-backup-unknown',               localOnly, null,  true,  'drive', 'warning', 'hollow'],
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

  it('never renders the warning tone when the server is unverified', () => {
    // The whole point: amber is a claim that needs proof.
    for (const backedUp of [true, false, null]) {
      const s = describeMessageState(localOnly, { backedUp, serverKnown: false });
      expect(s.tone).not.toBe('warning');
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
    expect(describeMessageState(localOnly).tone).not.toBe('warning');
    expect(describeMessageState(localOnly, { backedUp: false }).tone).not.toBe('warning');
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
});
