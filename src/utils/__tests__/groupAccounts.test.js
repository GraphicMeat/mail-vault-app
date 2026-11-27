import { describe, expect, it } from 'vitest';
import { moveGroup, placeGroup, reorderWithinGroup } from '../groupAccounts';

const accounts = ['u1', 'w1', 'p1', 'w2', 'u2', 's1'].map(id => ({ id }));
const groupOf = { w1: 'Work', w2: 'Work', p1: 'Personal', s1: 'Study' };

describe('placeGroup', () => {
  it('drops a named group before another, keeping its accounts together', () => {
    expect(placeGroup(accounts, groupOf, 'Study', 'Work')).toEqual(['u1', 'u2', 's1', 'w1', 'w2', 'p1']);
  });
  it('drops a named group at the end', () => {
    expect(placeGroup(accounts, groupOf, 'Work', null)).toEqual(['u1', 'u2', 'p1', 's1', 'w1', 'w2']);
  });
  it('returns null for an unknown group or a drop that changes nothing', () => {
    expect(placeGroup(accounts, groupOf, 'Missing', 'Work')).toBeNull();
    expect(placeGroup(accounts, groupOf, 'Work', 'Work')).toBeNull();
    expect(placeGroup(accounts, groupOf, 'Work', 'Personal')).toBeNull();
    expect(placeGroup(accounts, groupOf, 'Study', null)).toBeNull();
  });
});

describe('moveGroup', () => {
  it('moves a named group down past the next one, keeping its accounts together', () => {
    expect(moveGroup(accounts, groupOf, 'Work', 1)).toEqual(['u1', 'u2', 'p1', 'w1', 'w2', 's1']);
  });
  it('moves a named group up', () => {
    expect(moveGroup(accounts, groupOf, 'Study', -1)).toEqual(['u1', 'u2', 'w1', 'w2', 's1', 'p1']);
  });
  it('never moves a group above the ungrouped accounts or past the ends', () => {
    expect(moveGroup(accounts, groupOf, 'Work', -1)).toBeNull();
    expect(moveGroup(accounts, groupOf, 'Study', 1)).toBeNull();
    expect(moveGroup(accounts, groupOf, 'Missing', 1)).toBeNull();
  });
});

describe('reorderWithinGroup', () => {
  it('replaces one section order and keeps every other section in place', () => {
    expect(reorderWithinGroup(accounts, groupOf, 'Work', ['w2', 'w1'])).toEqual(['u1', 'u2', 'w2', 'w1', 'p1', 's1']);
    expect(reorderWithinGroup(accounts, groupOf, null, ['u2', 'u1'])).toEqual(['u2', 'u1', 'w1', 'w2', 'p1', 's1']);
  });
});
