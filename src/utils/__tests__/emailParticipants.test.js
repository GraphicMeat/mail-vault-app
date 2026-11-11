import { describe, it, expect } from 'vitest';
import { emailParticipants } from '../emailParticipants';

const p = (address, name = '') => ({ address, name });

describe('emailParticipants', () => {
  it('lists from, to then cc', () => {
    const out = emailParticipants({ from: p('a@x.io', 'Al'), to: [p('b@x.io')], cc: [p('c@x.io')] }, []);
    expect(out).toEqual([
      { address: 'a@x.io', name: 'Al', role: 'from' },
      { address: 'b@x.io', name: '', role: 'to' },
      { address: 'c@x.io', name: '', role: 'cc' },
    ]);
  });

  it('dedupes an address case-insensitively, first role wins', () => {
    const out = emailParticipants({ from: p('A@x.io'), to: [p('a@X.io'), p('b@x.io')], cc: [p('B@x.io')] }, []);
    expect(out.map((o) => [o.address, o.role])).toEqual([['A@x.io', 'from'], ['b@x.io', 'to']]);
  });

  it('drops own addresses and aliases', () => {
    const out = emailParticipants({ from: p('me@h.io'), to: [p('alias@h.io'), p('b@x.io')], cc: [] }, ['ME@h.io', 'alias@h.io']);
    expect(out.map((o) => o.address)).toEqual(['b@x.io']);
  });

  it('no email gives an empty list', () => {
    expect(emailParticipants(null, [])).toEqual([]);
    expect(emailParticipants({}, [])).toEqual([]);
  });
});
