import { describe, it, expect } from 'vitest';
import { rankSendAsCandidates } from '../sendAsSuggestions';

const LOGIN = 'ABC@fastmail.fm';

const sent = (from) => ({ from: { address: from }, to: [], cc: [] });
const received = (from, to = [], cc = []) => ({
  from: { address: from },
  to: to.map(address => ({ address })),
  cc: cc.map(address => ({ address })),
});

describe('rankSendAsCandidates', () => {
  it('surfaces an address the mailbox has already sent as', () => {
    const out = rankSendAsCandidates({ sent: [sent('DEF@fastmail.fm')] }, LOGIN);
    expect(out).toEqual([{ address: 'def@fastmail.fm', source: 'sent', count: 1 }]);
  });

  it('never suggests the login address itself', () => {
    const out = rankSendAsCandidates(
      { sent: [sent(LOGIN), sent('abc@fastmail.fm')] },
      LOGIN
    );
    expect(out).toEqual([]);
  });

  it('ignores a To/Cc address that only ever appears from one sender', () => {
    // A co-recipient on one thread is not a delivery address for this mailbox.
    const out = rankSendAsCandidates({
      inbox: [
        received('boss@corp.com', [LOGIN, 'colleague@corp.com']),
        received('boss@corp.com', [LOGIN, 'colleague@corp.com']),
      ],
    }, LOGIN);
    expect(out).toEqual([]);
  });

  it('surfaces a To address seen from three or more distinct senders', () => {
    const out = rankSendAsCandidates({
      inbox: [
        received('a@x.com', ['DEF@fastmail.fm']),
        received('b@y.com', ['DEF@fastmail.fm']),
        received('c@z.com', ['def@fastmail.fm']),
      ],
    }, LOGIN);
    expect(out).toEqual([{ address: 'def@fastmail.fm', source: 'inbox', count: 3 }]);
  });

  it('ranks sent-proven addresses above inbox-inferred ones', () => {
    const out = rankSendAsCandidates({
      sent: [sent('proven@fastmail.fm')],
      inbox: [
        received('a@x.com', ['guess@fastmail.fm']),
        received('b@y.com', ['guess@fastmail.fm']),
        received('c@z.com', ['guess@fastmail.fm']),
      ],
    }, LOGIN);
    expect(out.map(e => e.address)).toEqual(['proven@fastmail.fm', 'guess@fastmail.fm']);
  });

  it('skips malformed and empty addresses', () => {
    const out = rankSendAsCandidates(
      { sent: [sent(''), sent('not-an-address'), { from: null }] },
      LOGIN
    );
    expect(out).toEqual([]);
  });
});
