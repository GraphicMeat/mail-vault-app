import { describe, it, expect } from 'vitest';
import { rankSendAsCandidates } from '../sendAsSuggestions';

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
