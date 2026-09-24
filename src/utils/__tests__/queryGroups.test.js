import { describe, expect, it } from 'vitest';
import { addTyped, dropItem, parseGroups, removeWord, serializeGroups } from '../queryGroups';

describe('view query groups', () => {
  it('reads the notation back as OR groups of AND words', () => {
    expect(parseGroups('(jasinskio && 14a-37) || (mindaugo 30)')).toEqual([['jasinskio', '14a-37'], ['mindaugo 30']]);
    expect(parseGroups('')).toEqual([[]]);
    expect(parseGroups('|| &&')).toEqual([[]]);
  });

  it('reads a query saved before groups as its space-separated words', () => {
    expect(parseGroups('service  jasinskio service')).toEqual([['service', 'jasinskio']]);
  });

  it('writes the notation the daemon reads, dropping empty groups', () => {
    expect(serializeGroups([['jasinskio', '14a-37'], [], ['mindaugo 30']])).toBe('jasinskio && 14a-37 || mindaugo 30');
    expect(serializeGroups([['invoice']])).toBe('invoice');
    expect(serializeGroups([[]])).toBe('');
  });

  it('adds typed words to the last group and opens a group per ||', () => {
    expect(addTyped([['a']], 'b, c && a || d')).toEqual([['a', 'b', 'c'], ['d']]);
    expect(addTyped([['a']], 'b ||')).toEqual([['a', 'b'], []]);
  });

  it('removing a group\'s last word removes the group, never the only one', () => {
    expect(removeWord([['a'], ['b']], 0, 0)).toEqual([['b']]);
    expect(removeWord([['a']], 0, 0)).toEqual([[]]);
  });

  it('moves a dropped word to a group, before a word, or into a new group', () => {
    const groups = [['a', 'b'], ['c']];
    expect(dropItem(groups, { kind: 'word', g: 0, i: 1 }, { g: 1 })).toEqual([['a'], ['c', 'b']]);
    expect(dropItem(groups, { kind: 'word', g: 1, i: 0 }, { g: 0, i: 0 })).toEqual([['c', 'a', 'b']]);
    expect(dropItem(groups, { kind: 'word', g: 0, i: 0 }, { g: 'new' })).toEqual([['b'], ['c'], ['a']]);
    expect(dropItem(groups, { kind: 'word', g: 0, i: 1 }, { g: 0, i: 0 })).toEqual([['b', 'a'], ['c']]);
    expect(dropItem(groups, { kind: 'word', g: 0, i: 0 }, { g: 0 })).toBe(groups);
    expect(dropItem([['a'], ['a', 'b']], { kind: 'word', g: 0, i: 0 }, { g: 1 })).toEqual([['a', 'b']]);
  });

  it('the OR dropped on a word splits its group there, anywhere else adds a group', () => {
    expect(dropItem([['a', 'b', 'c']], { kind: 'or' }, { g: 0, i: 1 })).toEqual([['a'], ['b', 'c']]);
    expect(dropItem([['a', 'b']], { kind: 'or' }, { g: 0, i: 0 })).toEqual([['a', 'b'], []]);
    expect(dropItem([['a']], { kind: 'or' }, { g: 0 })).toEqual([['a'], []]);
  });
});
