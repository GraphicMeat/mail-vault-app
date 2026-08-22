import { describe, it, expect } from 'vitest';
import { rankSendAsCandidates, composeIdentities } from '../sendAsSuggestions';

const LOGIN = 'ABC@fastmail.fm';

const sent = (from, to = [], cc = []) => ({
  from: { address: from },
  to: to.map(address => ({ address })),
  cc: cc.map(address => ({ address })),
});

describe('rankSendAsCandidates', () => {
  it('surfaces an address the mailbox has already sent as', () => {
    const out = rankSendAsCandidates([sent('DEF@fastmail.fm')], LOGIN);
    expect(out).toEqual([{ address: 'def@fastmail.fm', count: 1 }]);
  });

  it('never suggests the login address itself', () => {
    const out = rankSendAsCandidates([sent(LOGIN), sent('abc@fastmail.fm')], LOGIN);
    expect(out).toEqual([]);
  });

  it('ranks the most-used address first', () => {
    const out = rankSendAsCandidates(
      [sent('rare@fastmail.fm'), sent('often@fastmail.fm'), sent('often@fastmail.fm')],
      LOGIN
    );
    expect(out.map(e => e.address)).toEqual(['often@fastmail.fm', 'rare@fastmail.fm']);
  });

  it('never suggests a co-recipient — To/Cc is not evidence of delivery', () => {
    // The bug this source deletion fixed: a logistics mailbox was offered its
    // counterparties' staff because they were Cc'd by many different senders.
    const out = rankSendAsCandidates(
      [
        sent(LOGIN, ['a@corp.com'], ['crew@partner.com']),
        sent(LOGIN, ['b@corp.com'], ['crew@partner.com']),
        sent(LOGIN, ['c@corp.com'], ['crew@partner.com']),
      ],
      LOGIN
    );
    expect(out).toEqual([]);
  });

  it('skips malformed and empty addresses', () => {
    const out = rankSendAsCandidates(
      [sent(''), sent('not-an-address'), { from: null }],
      LOGIN
    );
    expect(out).toEqual([]);
  });

  it('tolerates a missing Sent cache', () => {
    expect(rankSendAsCandidates(null, LOGIN)).toEqual([]);
  });
});

describe('composeIdentities', () => {
  const accounts = [
    { id: 'a1', email: 'one@fastmail.fm' },
    { id: 'a2', email: 'two@corp.com' },
  ];

  it('offers each account its login when nothing else is known', () => {
    expect(composeIdentities(accounts)).toEqual([
      { key: 'a1 one@fastmail.fm', accountId: 'a1', address: 'one@fastmail.fm' },
      { key: 'a2 two@corp.com', accountId: 'a2', address: 'two@corp.com' },
    ]);
  });

  it('leads with the send-as override, then the login', () => {
    const out = composeIdentities([accounts[0]], { a1: 'alias@fastmail.fm' });
    expect(out.map(i => i.address)).toEqual(['alias@fastmail.fm', 'one@fastmail.fm']);
  });

  it('never repeats the override or the login, whatever their case', () => {
    const out = composeIdentities([accounts[0]], { a1: 'alias@fastmail.fm' }, {
      a1: [{ address: 'ALIAS@fastmail.fm' }, { address: 'One@Fastmail.fm' }],
    });
    expect(out.map(i => i.address)).toEqual(['alias@fastmail.fm', 'one@fastmail.fm']);
  });

  it('appends mined addresses in the order given', () => {
    const out = composeIdentities([accounts[0]], {}, {
      a1: [{ address: 'often@fastmail.fm' }, { address: 'rare@fastmail.fm' }],
    });
    expect(out.map(i => i.address)).toEqual([
      'one@fastmail.fm',
      'often@fastmail.fm',
      'rare@fastmail.fm',
    ]);
  });

  it('treats a blank override as no override', () => {
    const out = composeIdentities([accounts[0]], { a1: '   ' });
    expect(out).toEqual([
      { key: 'a1 one@fastmail.fm', accountId: 'a1', address: 'one@fastmail.fm' },
    ]);
  });

  it('keeps accounts in input order, each account contiguous', () => {
    const out = composeIdentities(accounts, { a1: 'alias@fastmail.fm' }, {
      a2: [{ address: 'mined@corp.com' }],
    });
    expect(out.map(i => i.accountId)).toEqual(['a1', 'a1', 'a2', 'a2']);
    expect(out.map(i => i.address)).toEqual([
      'alias@fastmail.fm',
      'one@fastmail.fm',
      'two@corp.com',
      'mined@corp.com',
    ]);
  });
});
