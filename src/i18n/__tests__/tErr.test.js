import { describe, it, expect, afterEach } from 'vitest';
import { tErr, setLocale } from '../index.js';

afterEach(async () => { await setLocale('en'); });

describe('tErr in English', () => {
  it('returns a known error plain, with no self-duplicating brackets', async () => {
    expect(tErr('errors.connectionFailed')).toBe('Connection failed');
  });

  it('passes an unknown raw string straight through', () => {
    expect(tErr('something nobody catalogued')).toBe('something nobody catalogued');
  });
});

describe('tErr in a translated locale', () => {
  it('appends the English original in brackets', async () => {
    await setLocale('de');
    expect(tErr('errors.connectionFailed')).toBe('Verbindung fehlgeschlagen (Connection failed)');
  });

  it('keeps the interpolated values from a prefixed Rust error in the brackets', async () => {
    await setLocale('de');
    const out = tErr('E_UID_GONE: Message UID 42 is no longer in INBOX');
    expect(out).toContain('(Message UID 42 is no longer in INBOX)');
    expect(out.startsWith('Nachricht')).toBe(true);
  });

  it('leaves an unprefixed Rust error as English, since that is already the fallback', async () => {
    await setLocale('de');
    expect(tErr('github device start: timeout')).toBe('github device start: timeout');
  });

  it('does not bracket when the translation equals the English', async () => {
    await setLocale('de');
    expect(tErr('errors.imapTimeout')).toBe('IMAP timeout');
  });

  it('accepts an Error instance, not just a string', async () => {
    await setLocale('de');
    expect(tErr(new Error('errors.connectionFailed')))
      .toBe('Verbindung fehlgeschlagen (Connection failed)');
  });
});
