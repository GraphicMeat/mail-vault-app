import { describe, expect, it } from 'vitest';
import { normalizeGroupName, resolveGroupName, groupAccounts, accountsInScope, groupUnread, groupNames, matchGroups } from '../accountGroups';

const accounts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

describe('account groups', () => {
  it('scopes visible accounts to a named group', () => {
    const settings = { hiddenAccounts: { c: true }, accountGroups: { a: 'Work', b: 'Personal', c: 'Work' } };
    expect(accountsInScope(accounts, settings)).toEqual([accounts[0], accounts[1], accounts[3]]);
    expect(accountsInScope(accounts, { ...settings, group: 'Work' })).toEqual([accounts[0]]);
    expect(accountsInScope(accounts, { ...settings, group: 'Missing' })).toEqual([]);
    expect(groupUnread(accounts, 'Work', { ...settings, unreadPerAccount: { a: 2, c: 5 } })).toBe(2);
  });
  it('normalizes names and limits them to 40 characters', () => {
    expect(normalizeGroupName('  My   Work  ')).toBe('My Work');
    expect(normalizeGroupName('a'.repeat(41))).toBe('a'.repeat(40));
    expect(normalizeGroupName(' \n ')).toBeNull();
  });
  it('reuses existing casing', () => {
    expect(resolveGroupName(' work ', ['Personal', 'Work'])).toBe('Work');
    expect(resolveGroupName('Study', ['Work'])).toBe('Study');
  });
  it('puts ungrouped first, then groups in first appearance order', () => {
    expect(groupAccounts(accounts, { a: 'Work', b: 'Personal', c: 'Work', stale: 'Study' }))
      .toEqual([
        { name: null, accounts: [accounts[3]] },
        { name: 'Work', accounts: [accounts[0], accounts[2]] },
        { name: 'Personal', accounts: [accounts[1]] },
      ]);
  });
  it('keeps one ungrouped section when no account is grouped', () => {
    expect(groupAccounts(accounts, {})).toEqual([{ name: null, accounts }]);
  });
  it('merges group names case-insensitively and counts accounts', () => {
    expect(groupNames({ a: 'Work', b: 'work', c: 'Home' })).toEqual([
      { name: 'Home', count: 1 }, { name: 'Work', count: 2 },
    ]);
  });
  it('ignores empty and non-string group names', () => {
    expect(groupNames({ a: '', b: null, c: 3, d: '  ', e: 'Work' })).toEqual([{ name: 'Work', count: 1 }]);
  });
  it('matches contained text without case sensitivity', () => {
    expect(matchGroups(groupNames({ a: 'Homework', b: 'Work' }), 'wOr').matches)
      .toEqual([{ name: 'Homework', count: 1 }, { name: 'Work', count: 1 }]);
  });
  it('does not offer creation for an existing name or blank draft', () => {
    const groups = groupNames({ a: 'Work' });
    expect(matchGroups(groups, 'work').canCreate).toBe(false);
    expect(matchGroups(groups, '  ').canCreate).toBe(false);
    expect(matchGroups(groups, 'Study').canCreate).toBe(true);
  });
});
