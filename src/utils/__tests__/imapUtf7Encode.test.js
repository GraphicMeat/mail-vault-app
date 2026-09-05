// The other direction: a name the USER typed has to reach the server escaped.
// Decoding is for display; this is the only place a decoded name is allowed to
// turn back into a mailbox identity, and only for a name that was never a path.
import { describe, it, expect } from 'vitest';
import { encodeImapUtf7, decodeImapUtf7 } from '../imapUtf7';

describe('encodeImapUtf7', () => {
  it('escapes a run of non-ASCII as modified base64', () => {
    expect(encodeImapUtf7('Bokelmühle')).toBe('Bokelm&APw-hle');
  });

  it('escapes a literal ampersand as "&-"', () => {
    expect(encodeImapUtf7('A&B')).toBe('A&-B');
  });

  it('passes printable ASCII through untouched', () => {
    expect(encodeImapUtf7('Kunden 2026')).toBe('Kunden 2026');
    expect(encodeImapUtf7('')).toBe('');
  });

  it('round-trips through the decoder', () => {
    const s = 'Ordner Ä Ö';
    expect(decodeImapUtf7(encodeImapUtf7(s))).toBe(s);
  });

  it('round-trips an astral-plane character (a surrogate pair)', () => {
    expect(decodeImapUtf7(encodeImapUtf7('Fun 😀'))).toBe('Fun 😀');
  });

  it('keeps one run per stretch of non-ASCII, not one per character', () => {
    // "&AMQ-&ANY-" would decode the same but is not what a server writes.
    expect(encodeImapUtf7('ÄÖ')).toBe('&AMQA1g-');
  });
});
