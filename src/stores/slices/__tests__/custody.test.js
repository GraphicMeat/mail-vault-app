// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';

// describeMessageState is pure, but its module imports the store and the icon
// set. Stub both rather than pulling the whole store graph into a unit test.
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
vi.mock('../../mailStore', () => {
  const hook = vi.fn((selector) => selector({ serverUids: { uids: new Set(), complete: true } }));
  hook.getState = () => ({ serverUids: { uids: new Set(), complete: true } });
  return { useMailStore: hook };
});

const { custodySource, custodyProof, custodyRowFor } = await import('../custody');
const { describeMessageState } = await import('../../../components/email/MessageStateIcon');

// The rule this file guards: gold ("your only copy") is a claim about the
// SERVER, and exactly three things prove it — the message never having had a
// server copy, this app having deleted the one it had, and a completed
// Message-ID sweep of every folder coming back empty. Absence from a mailbox
// proves none of them: Gmail's archive, a label move and the Bin all take a
// live message out of INBOX. That is why the third proof is a probe of the
// server (`services/workflows/probeServerCopy`) and not another derivation.

const archived = (extra = {}) => ({ uid: 3, isArchived: true, ...extra });

describe('custodySource', () => {
  it('calls an unarchived row a server row', () => {
    expect(custodySource({ uid: 3, isArchived: false })).toBe('server');
    expect(custodySource(null)).toBe('server');
  });

  it('calls a plain vault row local, whatever the mailbox does not have', () => {
    expect(custodySource(archived())).toBe('local');
  });

  it('calls a message that never had a server copy local-only', () => {
    expect(custodySource(archived({ _origin: 'local_sent' }))).toBe('local-only');
    expect(custodySource(archived({ _origin: 'local_draft' }))).toBe('local-only');
    expect(custodySource(archived({ _localStaged: true }))).toBe('local-only');
  });

  it('does not treat an ordinary archived-from-server entry as local-only', () => {
    // `local` in local-index.json means "archived FROM a server" — the most
    // common entry there is, and the one that must never go gold on its own.
    expect(custodySource(archived({ _origin: 'local' }))).toBe('local');
  });

  it('calls a message whose server copy we deleted local-only', () => {
    expect(custodySource(archived({ serverDeleted: true }))).toBe('local-only');
  });

  it('calls a message the server was asked about and does not have local-only', () => {
    expect(custodySource(archived({ serverAbsent: true }))).toBe('local-only');
  });

  it('ignores a falsy stamp rather than reading it as proof', () => {
    expect(custodySource(archived({ serverDeleted: false }))).toBe('local');
    expect(custodySource(archived({ serverDeleted: 'no' }))).toBe('local');
    // A probe that came back 'unknown' writes nothing, but a stamp torn up
    // after the message turned out to be present writes `false` — and `false`
    // is not evidence of anything.
    expect(custodySource(archived({ serverAbsent: false }))).toBe('local');
    expect(custodySource(archived({ serverAbsent: 'maybe' }))).toBe('local');
  });
});

describe('custodyProof', () => {
  it('names which of the three proofs a row carries', () => {
    expect(custodyProof(archived({ _origin: 'local_sent' }))).toBe('never-on-server');
    expect(custodyProof(archived({ _localStaged: true }))).toBe('never-on-server');
    expect(custodyProof(archived({ serverDeleted: true }))).toBe('we-deleted');
    expect(custodyProof(archived({ serverAbsent: true }))).toBe('server-lost-it');
  });

  it('is null for a row with no proof at all', () => {
    expect(custodyProof(archived())).toBeNull();
    expect(custodyProof(null)).toBeNull();
  });

  it('prefers the strongest claim when a row somehow carries two', () => {
    // A staged send this app then "deleted" from a server it never reached:
    // the honest sentence is the first one, not the second.
    expect(custodyProof(archived({ _origin: 'local_sent', serverDeleted: true })))
      .toBe('never-on-server');
  });
});

describe('describeMessageState over custodySource', () => {
  it('never claims the server lost a message it only cannot see in this mailbox', () => {
    const state = describeMessageState(archived({ source: 'local' }), { serverKnown: true });
    expect(state.tone).toBe('local');
    expect(state.detail).toBe('Also still on the server.');
  });

  it('says who removed the server copy, and does not over-claim for a label store', () => {
    const state = describeMessageState(
      archived({ source: 'local-only', serverDeleted: true }), { serverKnown: true },
    );
    expect(state.tone).toBe('only-copy');
    expect(state.detail).toBe('You deleted the server copy.');
    expect(state.detail).not.toMatch(/Nothing else has it/);
  });

  it('says nothing else has a message that was never sent to a server', () => {
    const state = describeMessageState(
      archived({ source: 'local-only', _origin: 'local_sent' }), { serverKnown: true },
    );
    expect(state.tone).toBe('only-copy');
    expect(state.detail).toBe('It was never on the server. Nothing else has it.');
  });

  it('names someone else when a completed sweep found nothing', () => {
    // The alarm the gold colour was written for: the app did not delete this,
    // and every folder on the server was asked.
    const state = describeMessageState(
      archived({ source: 'local-only', serverAbsent: true }), { serverKnown: true },
    );
    expect(state.tone).toBe('only-copy');
    expect(state.detail).toBe('Someone else deleted the server copy. Nothing else has it.');
  });

  it('derives custody itself when handed a copy the list never stamped', () => {
    // The viewer's object: same message, read back from the vault, no `source`.
    const state = describeMessageState(archived({ serverDeleted: true }), { serverKnown: true });
    expect(state.tone).toBe('only-copy');
  });
});

describe('custodyRowFor', () => {
  const row = { uid: 3, isArchived: true, serverDeleted: true, source: 'local-only' };

  it('finds the list row for the message the viewer is showing', () => {
    expect(custodyRowFor({ uid: 3 }, { sortedEmails: [row], localEmails: [] })).toBe(row);
  });

  it('falls back to the vault rows when the list has not got there yet', () => {
    expect(custodyRowFor({ uid: 3 }, { sortedEmails: [], localEmails: [row] })).toBe(row);
  });

  it('keeps accounts apart in the unified list', () => {
    const a = { uid: 3, _accountId: 'a' };
    const b = { uid: 3, _accountId: 'b' };
    expect(custodyRowFor({ uid: 3, _accountId: 'b' }, { sortedEmails: [a, b] })).toBe(b);
  });

  it('keeps folders apart — a uid is not a key across mailboxes', () => {
    const inbox = { uid: 6, _mailbox: 'INBOX', isArchived: true };
    const sent = { uid: 6, _mailbox: 'Sent', isArchived: true, serverDeleted: true };
    expect(custodyRowFor({ uid: 6, _mailbox: 'INBOX' }, { sortedEmails: [sent, inbox] })).toBe(inbox);
  });

  it('returns null rather than a guess when the message is not in the list', () => {
    expect(custodyRowFor({ uid: 9 }, { sortedEmails: [row] })).toBeNull();
    expect(custodyRowFor(null, { sortedEmails: [row] })).toBeNull();
  });

  it('gives the viewer the same verdict as the row, for one message', () => {
    // The contradiction this pair exists to prevent: a gold row under a green
    // "also still on the server" band.
    const fromRow = describeMessageState(row, { serverKnown: true });
    const viewerCopy = { uid: 3, isArchived: true, source: 'local' }; // vault read stamps 'local'
    const fromViewer = describeMessageState(
      custodyRowFor(viewerCopy, { sortedEmails: [row] }) || viewerCopy, { serverKnown: true },
    );
    expect(fromViewer.tone).toBe(fromRow.tone);
    expect(fromViewer.detail).toBe(fromRow.detail);
  });
});
