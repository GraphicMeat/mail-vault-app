import { describe, expect, it } from 'vitest';
import { normalizeGroupName, resolveGroupName, groupAccounts } from '../accountGroups';

const accounts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

describe('account groups', () => {
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
});
