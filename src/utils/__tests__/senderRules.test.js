import { describe, it, expect } from 'vitest';
import { normalizeSender, senderMatches, senderState, senderChoices } from '../senderRules';

describe('sender rules', () => {
  it('normalizes a rule the way the index compares it', () => {
    expect(normalizeSender('  @Servico.LT ')).toBe('servico.lt');
    expect(normalizeSender(null)).toBe('');
  });

  it('matches a whole address, or a domain and its subdomains, never a piece', () => {
    expect(senderMatches('bills@servico.lt', 'bills@servico.lt')).toBe(true);
    expect(senderMatches('servico.lt', 'bills@servico.lt')).toBe(true);
    expect(senderMatches('servico.lt', 'bills@mail.servico.lt')).toBe(true);
    expect(senderMatches('ervico.lt', 'bills@servico.lt')).toBe(false);
    expect(senderMatches('ills@servico.lt', 'bills@servico.lt')).toBe(false);
    expect(senderMatches('servico.lt', 'bills@notservico.lt')).toBe(false);
    expect(senderMatches('', 'bills@servico.lt')).toBe(false);
  });

  it('says where a sender stands in a view: blocked wins, then allowed, else open or outside', () => {
    const def = { senders: ['servico.lt'], excludeSenders: ['spam@servico.lt'] };
    expect(senderState(def, 'bills@servico.lt')).toBe('allowed');
    expect(senderState(def, 'spam@servico.lt')).toBe('blocked');
    expect(senderState(def, 'me@x.test')).toBe('outside');
    expect(senderState({ excludeSenders: ['x.test'] }, 'me@x.test')).toBe('blocked');
    expect(senderState({}, 'me@x.test')).toBe('open');
    expect(senderState(null, 'me@x.test')).toBe('open');
  });

  it('offers the sender and its domain, but never a mail provider as a whole', () => {
    expect(senderChoices('Bills@Servico.lt')).toEqual(['bills@servico.lt', 'servico.lt']);
    expect(senderChoices('someone@gmail.com')).toEqual(['someone@gmail.com']);
    expect(senderChoices('x@outlook.com')).toEqual(['x@outlook.com']);
    expect(senderChoices('')).toEqual([]);
    expect(senderChoices('not an address')).toEqual([]);
  });
});
