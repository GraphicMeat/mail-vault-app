import { describe, it, expect } from 'vitest';
import { parseDkimSignature, formatDkimKey } from '../senderCheck';

describe('parseDkimSignature', () => {
  it('reads the algorithm, domain and selector of the summary the daemon stores', () => {
    expect(parseDkimSignature({ dkimSignature: 'a=rsa-sha256; d=brand.test; s=k1' }))
      .toEqual({ algorithm: 'rsa-sha256', domain: 'brand.test', selector: 'k1' });
  });

  it('lowercases what it reads and tolerates missing tags', () => {
    expect(parseDkimSignature({ dkimSignature: 'a=ED25519-SHA256; d=Brand.test' }))
      .toEqual({ algorithm: 'ed25519-sha256', domain: 'brand.test', selector: null });
  });

  it('falls back to header.a / header.d / header.s in Authentication-Results', () => {
    const email = { authenticationResults: 'mx.test; dkim=pass header.d=brand.test header.s=k1 header.a=ed25519-sha256; spf=pass' };
    expect(parseDkimSignature(email)).toEqual({ algorithm: 'ed25519-sha256', domain: 'brand.test', selector: 'k1' });
  });

  it('prefers the signature summary over Authentication-Results, tag by tag', () => {
    const email = { dkimSignature: 'a=rsa-sha256', authenticationResults: 'mx; dkim=pass header.a=rsa-sha1 header.d=brand.test header.s=k9' };
    expect(parseDkimSignature(email)).toEqual({ algorithm: 'rsa-sha256', domain: 'brand.test', selector: 'k9' });
  });

  it('is null when neither source names anything, or there is no message', () => {
    expect(parseDkimSignature({ authenticationResults: 'mx; dkim=pass header.i=@brand.test header.b=abc' })).toBeNull();
    expect(parseDkimSignature({})).toBeNull();
    expect(parseDkimSignature(null)).toBeNull();
  });
});

describe('formatDkimKey', () => {
  it('names the key type and size', () => {
    expect(formatDkimKey({ keyType: 'rsa', bits: 1024, revoked: false })).toBe('RSA 1024-bit');
    expect(formatDkimKey({ keyType: 'rsa', bits: 2048, revoked: false })).toBe('RSA 2048-bit');
    expect(formatDkimKey({ keyType: 'ed25519', bits: 256, revoked: false })).toBe('Ed25519 256-bit');
    expect(formatDkimKey({ keyType: 'ed448', bits: 448, revoked: false })).toBe('Ed448 448-bit');
  });

  it('names a key it could not size by its type alone, and an unknown type as published', () => {
    expect(formatDkimKey({ keyType: 'rsa', bits: null, revoked: false })).toBe('RSA');
    expect(formatDkimKey({ keyType: 'ecdsa', bits: null, revoked: false })).toBe('ecdsa');
  });

  it('is empty for no key and for a revoked one', () => {
    expect(formatDkimKey(null)).toBe('');
    expect(formatDkimKey({ keyType: 'rsa', bits: null, revoked: true })).toBe('');
  });
});
