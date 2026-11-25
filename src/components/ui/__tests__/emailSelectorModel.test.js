import { describe, expect, it } from 'vitest';
import { accountSections, filterSections, selectableRows, findRow } from '../emailSelectorModel';

const A = { id: 'a', email: 'alex@example.test', name: 'Alex Morgan' };
const B = { id: 'b', email: 'b@example.test', name: 'b@example.test' };
const C = { id: 'c', email: 'studio@example.test', name: '' };
const D = { id: 'd', email: 'shop@example.test' };

describe('accountSections', () => {
  it('keeps the given order, ungrouped first, then each sidebar group', () => {
    const sections = accountSections([A, C, B, D], { accountGroups: { c: 'Work', d: 'Work' } });
    expect(sections.map(s => [s.name, s.items.map(i => i.value)])).toEqual([
      [null, ['a', 'b']],
      ['Work', ['c', 'd']],
    ]);
  });

  it('names a row by display name, then account name, never a name that is the address', () => {
    const [{ items }] = accountSections([A, B, C], { displayNames: { c: 'Studio' } });
    expect(items.map(i => [i.name, i.address])).toEqual([
      ['Alex Morgan', 'alex@example.test'],
      ['', 'b@example.test'],
      ['Studio', 'studio@example.test'],
    ]);
  });

  it('takes a row name from the caller before the display name', () => {
    const [{ items }] = accountSections([A, C], { displayNames: { c: 'Studio' }, nameOf: a => (a.id === 'c' ? 'Front Desk' : '') });
    expect(items.map(i => i.name)).toEqual(['Alex Morgan', 'Front Desk']);
  });

  it('drops a name that only repeats its address, on account and alias rows', () => {
    const [{ items }] = accountSections([{ id: 'x', email: 'X@Example.test', name: 'x@example.test' }], {
      nameOf: () => 'X@EXAMPLE.TEST',
      aliasesOf: () => [{ value: 'x2', address: 'two@example.test', name: 'Two@Example.test' }],
    });
    expect(items[0].name).toBe('');
    expect(items[0].aliases[0].name).toBe('');
  });

  it('never names a row by an account name that is its login, even when the row shows another address', () => {
    const [{ items }] = accountSections([{ id: 'l', email: 'luke@mock.test', name: 'luke@mock.test' }], {
      addressOf: () => 'alias@mock.test',
    });
    expect(items[0]).toMatchObject({ name: '', address: 'alias@mock.test' });
  });

  it('takes the value, aliases and lock from the caller', () => {
    const [{ items }] = accountSections([A, B], {
      valueFor: a => `${a.id} ${a.email}`,
      aliasesOf: a => (a.id === 'a' ? [{ value: 'a x@alias.test', address: 'x@alias.test', name: 'X' }] : []),
      lockedOf: a => a.id === 'b',
    });
    expect(items[0]).toMatchObject({ value: 'a alex@example.test', locked: false });
    expect(items[0].aliases).toEqual([{ value: 'a x@alias.test', address: 'x@alias.test', name: 'X' }]);
    expect(items[1]).toMatchObject({ value: 'b b@example.test', locked: true, aliases: [] });
  });
});

describe('filterSections', () => {
  const sections = accountSections([A, C, D], {
    accountGroups: { c: 'Work', d: 'Side projects' },
    displayNames: { c: 'Studio' },
    aliasesOf: a => (a.id === 'c' ? [
      { value: 'c1', address: 'billing@studio.test', name: '' },
      { value: 'c2', address: 'press@studio.test', name: 'Press desk' },
    ] : []),
  });
  const shape = s => s.map(x => [x.name, x.items.map(i => [i.value, i.aliases.map(al => al.value)])]);

  it('returns everything for an empty query', () => {
    expect(filterSections(sections, '  ')).toBe(sections);
  });

  it('matches the address, case-insensitively', () => {
    expect(shape(filterSections(sections, 'SHOP@'))).toEqual([['Side projects', [['d', []]]]]);
  });

  it('matches the display name and keeps the account\'s aliases', () => {
    expect(shape(filterSections(sections, 'studio'))).toEqual([['Work', [['c', ['c1', 'c2']]]]]);
  });

  it('matches a group name and keeps the whole group', () => {
    expect(shape(filterSections(sections, 'work'))).toEqual([['Work', [['c', ['c1', 'c2']]]]]);
  });

  it('on an alias match shows its account with only the matching aliases', () => {
    expect(shape(filterSections(sections, 'press'))).toEqual([['Work', [['c', ['c2']]]]]);
  });

  it('drops groups with nothing left', () => {
    expect(filterSections(sections, 'nothing-here')).toEqual([]);
  });
});

describe('selectableRows / findRow', () => {
  const sections = accountSections([A, C], {
    accountGroups: { c: 'Work' },
    aliasesOf: a => (a.id === 'a' ? [{ value: 'a2', address: 'x@alias.test', name: '' }] : []),
  });

  it('lists leading rows, then each account followed by its aliases, skipping group headers', () => {
    const rows = selectableRows([{ value: 'all', label: 'All accounts' }], sections);
    expect(rows.map(r => [r.kind, r.value])).toEqual([
      ['leading', 'all'], ['account', 'a'], ['alias', 'a2'], ['account', 'c'],
    ]);
  });

  it('finds an alias row with its account', () => {
    const row = findRow([], sections, 'a2');
    expect(row).toMatchObject({ kind: 'alias', value: 'a2', address: 'x@alias.test' });
    expect(row.item.account).toBe(A);
  });

  it('finds a row equal but for case', () => {
    expect(findRow([], sections, 'A2')).toMatchObject({ value: 'a2' });
  });

  it('finds nothing for an unknown value', () => {
    expect(findRow([], sections, 'zzz')).toBeNull();
  });
});
