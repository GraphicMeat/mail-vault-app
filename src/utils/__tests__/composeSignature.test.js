// Which signature a message signs with: the alias it leaves from, when that
// alias holds one of its own, else the account's.
import { describe, it, expect } from 'vitest';
import { composeSignature, aliasSignature } from '../sendAsSuggestions';

const account = { id: 'a', email: 'me@example.test' };
const accountSignature = { html: '<p>Best, Me</p>', text: 'Best, Me', enabled: true };
const desk = { address: 'Desk@example.test', name: 'Desk', source: 'manual', signature: { html: '<p>Desk team</p>', text: 'Desk team' } };
const plain = { address: 'shop@example.test', name: '', source: 'manual' };
const sign = (over = {}) => composeSignature({ account, aliases: [desk, plain], accountSignature, ...over });

describe('composeSignature', () => {
  it('signs the login with the account signature', () => {
    expect(sign({ fromAddress: 'me@example.test' })).toBe(accountSignature);
  });

  it("signs an alias that holds its own signature with that one, whatever the address's case", () => {
    expect(sign({ fromAddress: 'desk@EXAMPLE.test' })).toEqual({ html: '<p>Desk team</p>', text: 'Desk team', enabled: true });
  });

  it('follows the account for an alias with no signature of its own', () => {
    expect(sign({ fromAddress: 'shop@example.test' })).toBe(accountSignature);
  });

  it('follows the account switch too: a disabled account signature stays off for such an alias', () => {
    const off = { ...accountSignature, enabled: false };
    expect(sign({ fromAddress: 'shop@example.test', accountSignature: off })).toBe(off);
  });

  it('lets an own signature sign when the account signature is switched off', () => {
    expect(sign({ fromAddress: 'desk@example.test', accountSignature: { ...accountSignature, enabled: false } }).enabled).toBe(true);
  });

  it('signs nothing for an alias whose own signature is empty', () => {
    const quiet = { ...plain, signature: { html: '', text: '' } };
    const result = sign({ aliases: [quiet], fromAddress: 'shop@example.test' });
    expect(result).toEqual({ html: '', text: '', enabled: true });
    expect(result.html || result.text).toBe('');
  });

  it("resolves an empty From through the account's default From, then the login", () => {
    expect(sign({ fromAddress: '', sendAsAddress: 'desk@example.test' }).html).toBe('<p>Desk team</p>');
    expect(sign({ fromAddress: '' })).toBe(accountSignature);
    expect(sign({ fromAddress: '', sendAsAddress: '' })).toBe(accountSignature);
  });

  it('has no signature at all when the account has none and the alias follows it', () => {
    expect(composeSignature({ account, fromAddress: 'shop@example.test', aliases: [plain] }))
      .toEqual({ html: '', text: '', enabled: false });
  });

  it('never matches an address that no alias holds', () => {
    expect(sign({ fromAddress: 'stranger@example.test' })).toBe(accountSignature);
  });
});

describe('aliasSignature', () => {
  it('is null for a missing list, a missing alias or a non-object signature', () => {
    expect(aliasSignature(undefined, 'a@example.test')).toBeNull();
    expect(aliasSignature([desk], 'nobody@example.test')).toBeNull();
    expect(aliasSignature([{ address: 'a@example.test', signature: 'text' }], 'a@example.test')).toBeNull();
    expect(aliasSignature([desk], '')).toBeNull();
  });
});
