/**
 * IMAP modified UTF-7 (RFC 3501 §5.1.3) decoding for display.
 *
 * Reported by bson73 (discussion #1): his Swedish/German folder "Bokelmühle"
 * rendered as "Bokelmu&Awg-hle" everywhere in the app. `&Awg-` is base64 "Awg"
 * → U+0308 COMBINING DIAERESIS: his server stores the name decomposed, so only
 * the accent is escaped and the plain "u" stays literal.
 *
 * Decoding is display-only. The encoded form is the mailbox's identity on the
 * wire (SELECT) and on disk (Maildir dir name), so nothing here may feed back
 * into a path.
 */
import { describe, it, expect } from 'vitest';
import { decodeImapUtf7, mailboxLabel } from '../imapUtf7.js';

describe('decodeImapUtf7', () => {
  it('decodes the reported folder name', () => {
    expect(decodeImapUtf7('Bokelmu&Awg-hle')).toBe('Bokelmühle');
  });

  it('composes a decomposed accent so it matches a typed name', () => {
    // The run yields a bare combining mark; without NFC the string looks right
    // but fails every === against "Bokelmühle".
    expect(decodeImapUtf7('Bokelmu&Awg-hle')).toBe('Bokelmühle'.normalize('NFC'));
    expect(decodeImapUtf7('Bokelmu&Awg-hle').length).toBe('Bokelmühle'.length);
  });

  it('decodes precomposed accents and non-Latin scripts', () => {
    expect(decodeImapUtf7('&APw-ber')).toBe('über');
    expect(decodeImapUtf7('Arkiv.&AOU-&AOQ-&APY-')).toBe('Arkiv.åäö');
    expect(decodeImapUtf7('&ZeVnLIqe-')).toBe('日本語');
  });

  it('decodes a surrogate pair', () => {
    expect(decodeImapUtf7('&2D3eAA-')).toBe('😀');
  });

  it('uses the modified base64 alphabet, where , stands in for /', () => {
    expect(decodeImapUtf7('&,,0-')).toBe('\uFFFD');
  });

  it('turns &- back into a literal ampersand', () => {
    expect(decodeImapUtf7('Arkiv &- Kunder')).toBe('Arkiv & Kunder');
  });

  it('leaves plain names untouched', () => {
    expect(decodeImapUtf7('INBOX.Archive.Projekt')).toBe('INBOX.Archive.Projekt');
    expect(decodeImapUtf7('')).toBe('');
  });

  it('leaves malformed runs alone instead of eating text', () => {
    expect(decodeImapUtf7('R&D-team')).toBe('R&D-team');   // 1 base64 char = 6 bits
    expect(decodeImapUtf7('AT&T-shirt')).toBe('AT&T-shirt');
    expect(decodeImapUtf7('Fish & Chips')).toBe('Fish & Chips'); // no terminator
    expect(decodeImapUtf7('&AB-')).toBe('&AB-');           // 12 bits: not a whole UTF-16 unit
  });

  it('decodes a name embedded in a backend error string', () => {
    expect(decodeImapUtf7('Message UID 34 is no longer in INBOX.Bokelmu&Awg-hle'))
      .toBe('Message UID 34 is no longer in INBOX.Bokelmühle');
  });

  it('passes non-strings through', () => {
    expect(decodeImapUtf7(null)).toBe(null);
    expect(decodeImapUtf7(undefined)).toBe(undefined);
  });
});

describe('mailboxLabel', () => {
  it('decodes and drops the INBOX prefix', () => {
    expect(mailboxLabel('INBOX.Bokelmu&Awg-hle')).toBe('Bokelmühle');
    expect(mailboxLabel('inbox.Bokelmu&Awg-hle')).toBe('Bokelmühle');
  });

  it('keeps INBOX itself', () => {
    expect(mailboxLabel('INBOX')).toBe('INBOX');
  });

  it('leaves a name that only needs decoding', () => {
    expect(mailboxLabel('Bokelmu&Awg-hle')).toBe('Bokelmühle');
  });

  it('passes empty values through', () => {
    expect(mailboxLabel('')).toBe('');
    expect(mailboxLabel(null)).toBe(null);
  });
});
