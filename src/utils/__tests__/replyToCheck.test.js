import { describe, it, expect } from 'vitest';
import { detectReplyToMismatch } from '../replyToCheck';

describe('detectReplyToMismatch', () => {
  it('returns null when email is missing', () => {
    expect(detectReplyToMismatch(null)).toBeNull();
    expect(detectReplyToMismatch(undefined)).toBeNull();
  });

  it('returns null when from.address is missing', () => {
    expect(detectReplyToMismatch({ replyTo: { address: 'x@y.com' } })).toBeNull();
  });

  it('returns null when reply-to is missing', () => {
    expect(detectReplyToMismatch({ from: { address: 'a@b.com' } })).toBeNull();
    expect(detectReplyToMismatch({ from: { address: 'a@b.com' }, replyTo: null })).toBeNull();
    expect(detectReplyToMismatch({ from: { address: 'a@b.com' }, replyTo: {} })).toBeNull();
  });

  it('returns null when reply-to domain matches from domain exactly', () => {
    const email = {
      from: { address: 'sales@acme.com' },
      replyTo: { address: 'reply@acme.com' },
    };
    expect(detectReplyToMismatch(email)).toBeNull();
  });

  it('returns null when reply-to is a subdomain of from', () => {
    const email = {
      from: { address: 'sales@acme.com' },
      replyTo: { address: 'reply@mail.acme.com' },
    };
    expect(detectReplyToMismatch(email)).toBeNull();
  });

  it('returns null when from is a subdomain of reply-to', () => {
    const email = {
      from: { address: 'notices@corporate.acme.com' },
      replyTo: { address: 'reply@acme.com' },
    };
    expect(detectReplyToMismatch(email)).toBeNull();
  });

  it('flags unrelated reply-to domains', () => {
    const email = {
      from: { address: 'support@bank.com' },
      replyTo: { address: 'victim@attacker.ru' },
    };
    expect(detectReplyToMismatch(email)).toEqual({
      fromDomain: 'bank.com',
      replyToAddress: 'victim@attacker.ru',
      replyToDomain: 'attacker.ru',
    });
  });

  it('handles array-shaped replyTo (from full Email parser)', () => {
    const email = {
      from: { address: 'hello@service.com' },
      replyTo: [{ address: 'admin@phishing.net' }],
    };
    expect(detectReplyToMismatch(email)).toEqual({
      fromDomain: 'service.com',
      replyToAddress: 'admin@phishing.net',
      replyToDomain: 'phishing.net',
    });
  });

  it('handles string-shaped replyTo (some cache paths)', () => {
    const email = {
      from: { address: 'hello@service.com' },
      replyTo: 'admin@phishing.net',
    };
    expect(detectReplyToMismatch(email)).toEqual({
      fromDomain: 'service.com',
      replyToAddress: 'admin@phishing.net',
      replyToDomain: 'phishing.net',
    });
  });

  it('is case-insensitive', () => {
    const email = {
      from: { address: 'User@ACME.com' },
      replyTo: { address: 'Reply@ACME.com' },
    };
    expect(detectReplyToMismatch(email)).toBeNull();
  });

  it('flags differing TLD on same label (.com vs .net)', () => {
    const email = {
      from: { address: 'x@acme.com' },
      replyTo: { address: 'x@acme.net' },
    };
    const m = detectReplyToMismatch(email);
    expect(m).not.toBeNull();
    expect(m.fromDomain).toBe('acme.com');
    expect(m.replyToDomain).toBe('acme.net');
  });
});
