import { describe, it, expect } from 'vitest';
import { rankSendAsCandidates, composeIdentities, composeSenderName, resolveInitialComposeIdentity } from '../sendAsSuggestions';

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
  const alias = (address, name = '', source = 'manual') => ({ address, name, source });

  it('offers each account its login when nothing else is known', () => {
    expect(composeIdentities(accounts)).toEqual([
      { key: 'a1 one@fastmail.fm', accountId: 'a1', address: 'one@fastmail.fm', name: '' },
      { key: 'a2 two@corp.com', accountId: 'a2', address: 'two@corp.com', name: '' },
    ]);
  });

  it('leads with the default From, then the login, then every alias', () => {
    const out = composeIdentities([accounts[0]], { a1: 'desk@fastmail.fm' }, {
      a1: [alias('sales@fastmail.fm', 'Sales'), alias('desk@fastmail.fm', 'Front Desk', 'provider')],
    });
    expect(out).toEqual([
      { key: 'a1 desk@fastmail.fm', accountId: 'a1', address: 'desk@fastmail.fm', name: 'Front Desk' },
      { key: 'a1 one@fastmail.fm', accountId: 'a1', address: 'one@fastmail.fm', name: '' },
      { key: 'a1 sales@fastmail.fm', accountId: 'a1', address: 'sales@fastmail.fm', name: 'Sales' },
    ]);
  });

  it('never repeats the default, the login or an alias, whatever their case', () => {
    const out = composeIdentities([accounts[0]], { a1: 'desk@fastmail.fm' }, {
      a1: [alias('DESK@fastmail.fm'), alias('One@Fastmail.fm'), alias('desk@FASTMAIL.fm')],
    });
    expect(out.map(i => i.address)).toEqual(['desk@fastmail.fm', 'one@fastmail.fm']);
  });

  it('treats a blank default as none', () => {
    const out = composeIdentities([accounts[0]], { a1: '   ' });
    expect(out).toEqual([
      { key: 'a1 one@fastmail.fm', accountId: 'a1', address: 'one@fastmail.fm', name: '' },
    ]);
  });

  it('keeps accounts in input order, each account contiguous', () => {
    const out = composeIdentities(accounts, { a1: 'alias@fastmail.fm' }, {
      a2: [alias('second@corp.com')],
    });
    expect(out.map(i => i.accountId)).toEqual(['a1', 'a1', 'a2', 'a2']);
    expect(out.map(i => i.address)).toEqual([
      'alias@fastmail.fm',
      'one@fastmail.fm',
      'two@corp.com',
      'second@corp.com',
    ]);
  });
});

describe('composeSenderName', () => {
  const account = { id: 'a1', email: 'one@fastmail.fm', name: 'Account Name' };
  const aliases = [{ address: 'desk@fastmail.fm', name: 'Front Desk', source: 'provider' }, { address: 'bare@fastmail.fm', name: '', source: 'manual' }];

  it('names the message after the alias it leaves from', () => {
    expect(composeSenderName({ account, fromAddress: 'Desk@Fastmail.fm', displayName: 'Chosen', aliases })).toBe('Front Desk');
  });

  it('falls back to the account\'s name for the login or an unnamed alias', () => {
    expect(composeSenderName({ account, fromAddress: 'one@fastmail.fm', displayName: 'Chosen', aliases })).toBe('Chosen');
    expect(composeSenderName({ account, fromAddress: 'bare@fastmail.fm', displayName: 'Chosen', aliases })).toBe('Chosen');
    expect(composeSenderName({ account, fromAddress: 'bare@fastmail.fm', displayName: '', aliases })).toBe('Account Name');
  });

  it('keeps the old last resort, which the sender drops as a bare address', () => {
    expect(composeSenderName({ account: { id: 'a1', email: 'one@fastmail.fm' }, fromAddress: '', displayName: '' })).toBe('one@fastmail.fm');
  });
});

describe('resolveInitialComposeIdentity', () => {
  const accounts = [{ id: 'a1', email: 'one@x.com' }, { id: 'a2', email: 'two@y.com' }];
  const base = { replyTo: null, initialData: null, accounts, activeAccountId: 'a1', lastIdentity: null };

  it('opens on the account being read, not the one that last sent', () => {
    const out = resolveInitialComposeIdentity({ ...base, lastIdentity: { accountId: 'a2', address: 'alias@y.com' } });
    expect(out).toEqual({ accountId: 'a1', address: '' });
  });

  it('opens on the last message\'s account in the unified inbox', () => {
    const out = resolveInitialComposeIdentity({ ...base, selectedAccountId: 'a2' });
    expect(out).toEqual({ accountId: 'a2', address: '' });
  });

  it('keeps the remembered alias when it belongs to the account being read', () => {
    const out = resolveInitialComposeIdentity({
      ...base,
      selectedAccountId: 'a2',
      lastIdentity: { accountId: 'a2', address: 'alias@y.com' },
    });
    expect(out).toEqual({ accountId: 'a2', address: 'alias@y.com' });
  });

  it('drops a remembered alias that belongs to another account', () => {
    const out = resolveInitialComposeIdentity({
      ...base,
      selectedAccountId: 'a2',
      lastIdentity: { accountId: 'a1', address: 'alias@x.com' },
    });
    expect(out).toEqual({ accountId: 'a2', address: '' });
  });

  it('ignores a last identity whose account no longer exists', () => {
    const out = resolveInitialComposeIdentity({ ...base, lastIdentity: { accountId: 'gone', address: 'x@y.z' } });
    expect(out).toEqual({ accountId: 'a1', address: '' });
  });

  it('falls back to the active account with nothing selected', () => {
    expect(resolveInitialComposeIdentity(base)).toEqual({ accountId: 'a1', address: '' });
  });

  it('falls back to the active account when the selected account is gone', () => {
    const out = resolveInitialComposeIdentity({ ...base, selectedAccountId: 'gone' });
    expect(out).toEqual({ accountId: 'a1', address: '' });
  });

  it('a reply stays on the account that received the message', () => {
    const out = resolveInitialComposeIdentity({
      ...base,
      replyTo: { _accountId: 'a1' },
      selectedAccountId: 'a2',
      lastIdentity: { accountId: 'a2', address: 'alias@y.com' },
    });
    expect(out).toEqual({ accountId: 'a1', address: '' });
  });

  // Reported 2026-08-26: replied to a message read in one mailbox, and compose
  // opened on the mailbox that had sent last. A body fetched from the server
  // carries no `_accountId`, so the reply fell through to the last identity.
  it('a reply follows the mailbox being read when the message carries no account', () => {
    const out = resolveInitialComposeIdentity({
      ...base,
      replyTo: { uid: 7, subject: 'no provenance' },
      lastIdentity: { accountId: 'a2', address: 'alias@y.com' },
    });
    expect(out).toEqual({ accountId: 'a1', address: '' });
  });

  it('a forward of a search hit follows the account the hit came from', () => {
    const out = resolveInitialComposeIdentity({
      ...base,
      replyTo: { _srcAccountId: 'a2' },
      lastIdentity: { accountId: 'a1', address: 'other@x.com' },
    });
    expect(out).toEqual({ accountId: 'a2', address: '' });
  });

  it('a reply whose account is gone falls back to the one being read, not the last sender', () => {
    const out = resolveInitialComposeIdentity({
      ...base,
      replyTo: { _accountId: 'removed' },
      lastIdentity: { accountId: 'a2', address: 'alias@y.com' },
    });
    expect(out).toEqual({ accountId: 'a1', address: '' });
  });

  it('a restored draft keeps its saved account and From address', () => {
    const out = resolveInitialComposeIdentity({
      ...base,
      initialData: { _accountId: 'a2', _fromAddress: 'alias@y.com' },
      lastIdentity: { accountId: 'a1', address: 'other@x.com' },
    });
    expect(out).toEqual({ accountId: 'a2', address: 'alias@y.com' });
  });

  it('a restored draft without saved account info uses the active account, not the last identity', () => {
    const out = resolveInitialComposeIdentity({
      ...base,
      initialData: { to: 'a@b.c' },
      lastIdentity: { accountId: 'a2', address: 'alias@y.com' },
    });
    expect(out).toEqual({ accountId: 'a1', address: '' });
  });

  it('a mailto: prefill leaves from the account the message arrived on', () => {
    const out = resolveInitialComposeIdentity({
      ...base,
      initialData: { to: 'a@b.c', _prefill: true, _accountId: 'a2' },
      lastIdentity: { accountId: 'a1', address: 'other@x.com' },
    });
    expect(out).toEqual({ accountId: 'a2', address: '' });
  });

  it('a mailto: prefill with no account behaves like a fresh compose, not a restore', () => {
    // Only unified-inbox rows carry `_accountId`. Without one this is the
    // Compose button by another name, so it follows the same precedence —
    // which is now the mailbox being read, not the identity that last sent.
    const out = resolveInitialComposeIdentity({
      ...base,
      initialData: { to: 'a@b.c', _prefill: true },
      lastIdentity: { accountId: 'a2', address: 'alias@y.com' },
    });
    expect(out).toEqual({ accountId: 'a1', address: '' });
  });

  it('a mailto: prefill with no account still follows the mailbox being read', () => {
    const out = resolveInitialComposeIdentity({
      ...base,
      initialData: { to: 'a@b.c', _prefill: true },
      selectedAccountId: 'a2',
    });
    expect(out).toEqual({ accountId: 'a2', address: '' });
  });
});
