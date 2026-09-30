// The vault sets hold `accountId:mailbox:uid`. One place builds those keys and
// every reader asks through it.
import { describe, it, expect } from 'vitest';
import {
  vaultKey, vaultKeys, vaultUids, vaultHas, vaultHasSelection,
} from '../slices/unifiedHelpers';

describe('vaultKeys / vaultUids', () => {
  it('turns one folder\'s bare uids into keys and back', () => {
    const keys = vaultKeys('a', 'INBOX', new Set([5, 6]));
    expect([...keys].sort()).toEqual(['a:INBOX:5', 'a:INBOX:6']);
    expect([...vaultUids(new Set([...keys, 'b:INBOX:5', 'a:Sent:9']), 'a', 'INBOX')].sort()).toEqual([5, 6]);
  });

  it('an unknown read stays unknown, never an empty set', () => {
    expect(vaultKeys('a', 'INBOX', null)).toBeNull();
    expect(vaultKeys('a', 'INBOX', undefined)).toBeUndefined();
  });

  it('answers with the current set when its contents are unchanged', () => {
    const current = new Set(['a:INBOX:5']);
    expect(vaultKeys('a', 'INBOX', new Set([5]), current)).toBe(current);
    expect(vaultKeys('a', 'INBOX', new Set([5, 6]), current)).not.toBe(current);
  });

  it('does not read another folder whose name starts the same way', () => {
    expect([...vaultUids(new Set(['a:INBOX:x:5', 'a:INBOX:7']), 'a', 'INBOX')]).toEqual([7]);
  });
});

describe('vaultHas', () => {
  const view = { activeAccountId: 'a', activeMailbox: 'INBOX' };
  const set = new Set([vaultKey('a', 'INBOX', 5), vaultKey('b', 'INBOX', 6)]);

  it('places a row by its own account and folder', () => {
    expect(vaultHas(set, { uid: 5 }, view)).toBe(true);
    expect(vaultHas(set, { uid: 5, _accountId: 'b', _mailbox: 'INBOX' }, view)).toBe(false);
    expect(vaultHas(set, { uid: 6, _accountId: 'b', _mailbox: 'INBOX' }, view)).toBe(true);
    expect(vaultHas(set, { uid: 5, _accountId: 'a', _mailbox: 'Sent' }, view)).toBe(false);
  });

  it('a row that cannot be placed is in no set', () => {
    expect(vaultHas(set, { uid: 5 }, { activeAccountId: 'a', activeMailbox: 'UNIFIED' })).toBe(false);
    expect(vaultHas(null, { uid: 5 }, view)).toBe(false);
  });
});

describe('vaultHasSelection', () => {
  const set = new Set([vaultKey('a', 'INBOX', 5), vaultKey('b', 'Sent', 6)]);

  it('reads a bare uid as the view\'s folder and a full key as itself', () => {
    const view = { activeAccountId: 'a', activeMailbox: 'INBOX' };
    expect(vaultHasSelection(set, 5, view)).toBe(true);
    expect(vaultHasSelection(set, 6, view)).toBe(false);
    expect(vaultHasSelection(set, 'b:Sent:6', view)).toBe(true);
    expect(vaultHasSelection(set, 'b:INBOX:6', view)).toBe(false);
  });

  it('a bare uid in a view that spans folders names nothing', () => {
    expect(vaultHasSelection(set, 5, { activeAccountId: 'a', activeMailbox: 'UNIFIED' })).toBe(false);
  });
});
