// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { describeMessageState } from '../email/MessageStateIcon';

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
});
