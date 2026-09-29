import { describe, it, expect } from 'vitest';
import { ownAddresses, ownAddressSet, isOwnAddress } from '../ownAddresses';

// "Is this address mine?" has one answer for the whole app: the login, the
// default From, and every alias the account holds.
describe('ownAddresses', () => {
  const account = { id: 'a1', email: 'me@example.test' };

  it('is the login, the default From, then every alias', () => {
    const out = ownAddresses({
      account,
      sendAsAddress: 'desk@example.test',
      aliases: [{ address: 'desk@example.test' }, { address: 'sales@example.test', name: 'Sales' }],
    });
    expect(out).toEqual(['me@example.test', 'desk@example.test', 'sales@example.test']);
  });

  it('never repeats an address, whatever its case, and skips blanks', () => {
    const out = ownAddresses({
      account,
      sendAsAddress: '  ',
      aliases: [{ address: 'ME@example.test' }, { address: '' }, null, { address: 'Other@Example.test' }],
    });
    expect(out).toEqual(['me@example.test', 'Other@Example.test']);
  });

  it('copes with nothing at all', () => {
    expect(ownAddresses({})).toEqual([]);
    expect(ownAddresses({ account })).toEqual(['me@example.test']);
  });
});

describe('isOwnAddress', () => {
  it('matches case-insensitively and ignores surrounding space', () => {
    expect(isOwnAddress(' Sales@Example.test ', ['me@example.test', 'sales@example.test'])).toBe(true);
    expect(isOwnAddress('stranger@example.test', ['me@example.test'])).toBe(false);
  });

  it('takes a single address, a list or a prepared set', () => {
    expect(isOwnAddress('me@example.test', 'ME@example.test')).toBe(true);
    const set = ownAddressSet(['me@example.test', 'desk@example.test']);
    expect(isOwnAddress('DESK@example.test', set)).toBe(true);
    expect(isOwnAddress('', set)).toBe(false);
    expect(isOwnAddress(null, ['me@example.test'])).toBe(false);
  });

  it('folds dots and plus tags on Gmail addresses only', () => {
    // Gmail delivers j.doe+news@gmail.com to jdoe@gmail.com: it is the same inbox.
    expect(isOwnAddress('j.doe+news@gmail.com', ['jdoe@gmail.com'])).toBe(true);
    expect(isOwnAddress('jdoe@googlemail.com', ['j.doe@gmail.com'])).toBe(true);
    // Elsewhere a dot or a plus tag may name a different mailbox.
    expect(isOwnAddress('j.doe@example.test', ['jdoe@example.test'])).toBe(false);
    expect(isOwnAddress('jdoe+news@example.test', ['jdoe@example.test'])).toBe(false);
  });
});
