import { describe, it, expect } from 'vitest';
import { mergeDiscovery, addAliasToList, isValidAliasAddress } from '../aliasDiscovery';

const LOGIN = 'me@example.test';
const provider = (aliases, status = 'ok') => ({ status, aliases });
const pa = (address, extra = {}) => ({ address, name: '', isPrimary: false, verified: true, ...extra });
const detected = (address, source, extra = {}) => ({ address, name: '', count: 1, source, ...extra });

const merge = (over = {}) => mergeDiscovery({
  aliases: [], dismissed: [], loginEmail: LOGIN, displayName: '',
  result: { provider: provider([]), detected: [] },
  ...over,
});

describe('isValidAliasAddress', () => {
  it('takes a plain address and nothing else', () => {
    expect(isValidAliasAddress('desk@example.test')).toBe(true);
    expect(isValidAliasAddress(' desk@example.test ')).toBe(true);
    for (const bad of ['', 'desk', 'desk@', '@example.test', 'a b@example.test', 'Desk <desk@example.test>', 'a@b', null]) {
      expect(isValidAliasAddress(bad)).toBe(false);
    }
  });
});

describe('addAliasToList', () => {
  it('adds a trimmed address with its name and source', () => {
    const out = addAliasToList({ aliases: [], loginEmail: LOGIN, alias: { address: ' desk@example.test ', name: ' Desk ' } });
    expect(out).toEqual({
      ok: true,
      alias: { address: 'desk@example.test', name: 'Desk', source: 'manual' },
      aliases: [{ address: 'desk@example.test', name: 'Desk', source: 'manual' }],
    });
  });

  it('refuses a malformed address, the login and a duplicate, whatever the case', () => {
    const aliases = [{ address: 'desk@example.test', name: '', source: 'provider' }];
    expect(addAliasToList({ aliases, loginEmail: LOGIN, alias: { address: 'nope' } })).toEqual({ ok: false, reason: 'invalid' });
    expect(addAliasToList({ aliases, loginEmail: LOGIN, alias: { address: 'ME@example.test' } })).toEqual({ ok: false, reason: 'login' });
    expect(addAliasToList({ aliases, loginEmail: LOGIN, alias: { address: 'Desk@Example.test' } })).toEqual({ ok: false, reason: 'duplicate' });
  });
});

describe('mergeDiscovery', () => {
  it('adds every verified provider alias with the provider\'s name', () => {
    const out = merge({ result: { provider: provider([pa(LOGIN, { isPrimary: true }), pa('desk@example.test', { name: 'Front Desk' })]), detected: [] } });
    expect(out.added).toEqual([{ address: 'desk@example.test', name: 'Front Desk', source: 'provider' }]);
    expect(out.aliases).toEqual(out.added);
    expect(out.providerStatus).toBe('ok');
  });

  it('skips the primary, unverified, dismissed, existing and login entries', () => {
    const out = merge({
      aliases: [{ address: 'kept@example.test', name: 'Mine', source: 'manual' }],
      dismissed: ['gone@example.test'],
      result: {
        provider: provider([
          pa('pending@example.test', { verified: false }),
          pa('GONE@example.test'),
          pa('Kept@example.test', { name: 'Provider name' }),
          pa('ME@example.test'),
          pa('not an address'),
        ]),
        detected: [],
      },
    });
    expect(out.added).toEqual([]);
    // The user's own name for an alias is never replaced.
    expect(out.aliases).toEqual([{ address: 'kept@example.test', name: 'Mine', source: 'manual' }]);
  });

  it('fills in a name only where the alias has none', () => {
    const out = merge({
      aliases: [{ address: 'desk@example.test', name: '', source: 'detected' }],
      result: { provider: provider([pa('desk@example.test', { name: 'Front Desk' })]), detected: [] },
    });
    expect(out.aliases).toEqual([{ address: 'desk@example.test', name: 'Front Desk', source: 'detected' }]);
    expect(out.added).toEqual([]);
  });

  it('keeps an alias the provider no longer lists', () => {
    const out = merge({
      aliases: [{ address: 'old@example.test', name: '', source: 'provider' }],
      result: { provider: provider([]), detected: [] },
    });
    expect(out.aliases).toEqual([{ address: 'old@example.test', name: '', source: 'provider' }]);
  });

  it('seeds the account name from the provider\'s primary entry only when none is set', () => {
    const result = { provider: provider([pa(LOGIN, { isPrimary: true, name: 'Me Myself' })]), detected: [] };
    expect(merge({ result }).displayName).toBe('Me Myself');
    expect(merge({ result, displayName: 'Chosen' }).displayName).toBeNull();
    expect(merge().displayName).toBeNull();
  });

  it('adds addresses the account has sent from, and only suggests delivery addresses', () => {
    const out = merge({
      dismissed: ['nope@example.test'],
      result: {
        provider: provider([pa('desk@example.test')]),
        detected: [
          detected('Sent@Example.test', 'sent_from', { name: 'Sender' }),
          detected('desk@example.test', 'sent_from'),
          detected('inbound@example.test', 'delivered_to', { count: 4 }),
          detected('sent@example.test', 'delivered_to'),
          detected('nope@example.test', 'delivered_to'),
          detected('me@example.test', 'delivered_to'),
          detected('inbound@example.test', 'delivered_to'),
        ],
      },
    });
    expect(out.added).toEqual([
      { address: 'desk@example.test', name: '', source: 'provider' },
      { address: 'Sent@Example.test', name: 'Sender', source: 'detected' },
    ]);
    expect(out.suggestions).toEqual([detected('inbound@example.test', 'delivered_to', { count: 4 })]);
    expect(out.aliases.map(a => a.address)).toEqual(['desk@example.test', 'Sent@Example.test']);
  });

  it('still reads the account\'s own mail when the provider cannot answer', () => {
    const out = merge({
      result: {
        provider: provider([pa('desk@example.test')], 'denied'),
        detected: [detected('sent@example.test', 'sent_from')],
      },
    });
    expect(out.providerStatus).toBe('denied');
    expect(out.added).toEqual([{ address: 'sent@example.test', name: '', source: 'detected' }]);
  });

  it('answers an empty or broken reply with an error and changes nothing', () => {
    const aliases = [{ address: 'desk@example.test', name: '', source: 'manual' }];
    const out = merge({ aliases, result: null });
    expect(out).toEqual({ aliases, added: [], suggestions: [], providerStatus: 'error', displayName: null });
  });

  it('drops an alias that is the login itself', () => {
    // A default From saved before aliases existed becomes a manual alias on
    // upgrade, and nothing there knew the login yet.
    const out = merge({ aliases: [{ address: 'Me@Example.test', name: '', source: 'manual' }] });
    expect(out.aliases).toEqual([]);
  });
});
