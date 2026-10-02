// src/utils/privacy/__tests__/piiDetector.test.js
import { describe, it, expect } from 'vitest';
import { foldName, buildNameDictionary, findPii, maskText, maskString, unionDictionaries, EMPTY_DICTIONARY } from '../piiDetector';

const dict = buildNameDictionary({ names: ['Rokas Ambrazevičius', 'John Smith', 'Mark Post', 'Amélie Dupont'] });
const kinds = (text, d = dict) => findPii(text, d).map(s => [text.slice(s.start, s.end), s.kind]);

describe('foldName', () => {
  it('strips diacritics and lowercases', () => {
    expect(foldName('Ambrazevičius')).toBe('ambrazevicius');
    expect(foldName('AMÉLIE')).toBe('amelie');
  });
});

describe('findPii — names', () => {
  it('matches full names and single capitalised tokens', () => {
    expect(kinds('Hi John Smith, see Smith later')).toEqual([['John Smith', 'name'], ['Smith', 'name']]);
  });
  it('matches diacritics in every spelling and ALL CAPS', () => {
    expect(kinds('Ambrazevičius / AMBRAZEVIČIUS / Ambrazevicius')).toEqual([
      ['Ambrazevičius', 'name'], ['AMBRAZEVIČIUS', 'name'], ['Ambrazevicius', 'name'],
    ]);
  });
  it('does not match lowercase words or stoplisted tokens alone', () => {
    expect(kinds('please post this mark on the smith account')).toEqual([]);
    expect(kinds('Post it on Monday, Mark')).toEqual([]); // stoplisted single tokens
  });
  it('still matches a stoplisted token inside a full-name match', () => {
    expect(kinds('Thanks, Mark Post')).toEqual([['Mark Post', 'name']]);
  });
  it('does not split words around non-ASCII letters (no \\b)', () => {
    expect(kinds('Rokasžodis')).toEqual([]);
  });
});

describe('findPii — email, phone, address', () => {
  it('emails, including unicode local parts', () => {
    expect(kinds('mail jürgen.x@example.de now', EMPTY_DICTIONARY)).toEqual([['jürgen.x@example.de', 'email']]);
  });
  it('phones but not dates, times or long ids', () => {
    expect(kinds('Call +370 612 34567 or (555) 123-4567', EMPTY_DICTIONARY)).toEqual([
      ['+370 612 34567', 'phone'], ['(555) 123-4567', 'phone'],
    ]);
    expect(kinds('On 2026-10-01 at 12:30, order 12345678901234567890', EMPTY_DICTIONARY)).toEqual([]);
  });
  it('street addresses in EN, LT and DE order, with postcode', () => {
    expect(kinds('Ship to 221B Baker Street, London', EMPTY_DICTIONARY)).toEqual([['221B Baker Street', 'address']]);
    expect(kinds('Gedimino pr. 9, LT-01103 Vilnius', EMPTY_DICTIONARY)).toEqual([['Gedimino pr. 9, LT-01103 Vilnius', 'address']]);
    expect(kinds('Hauptstraße 5, 10115 Berlin', EMPTY_DICTIONARY)).toEqual([['Hauptstraße 5, 10115 Berlin', 'address']]);
  });
  it('email wins over a name inside it', () => {
    expect(kinds('john.smith@x.com', dict)).toEqual([['john.smith@x.com', 'email']]);
  });
});

describe('masking', () => {
  it('maskText keeps length, spaces and punctuation', () => {
    expect(maskText('John S. +370')).toBe('xxxx x. +xxx');
  });
  it('maskString replaces only detected spans', () => {
    expect(maskString('Re: lunch with John Smith', dict)).toBe('Re: lunch with xxxx xxxxx');
  });
});

describe('performance', () => {
  // Letter-only, distinct: base-26 suffixes, so 5,000 names really are 10,000 tokens.
  const letters = (i) => { let r = ''; let n = i; do { r = String.fromCharCode(97 + (n % 26)) + r; n = Math.floor(n / 26); } while (n); return r.padStart(4, 'a'); };
  const nameOf = (i) => `P${letters(i)} S${letters(i)}`;
  it('scans 200 KB against 5,000 names in under 150 ms', () => {
    const names = Array.from({ length: 5000 }, (_, i) => nameOf(i));
    const big = buildNameDictionary({ names });
    expect(big.tokens.size).toBe(10000);
    const text = `Lorem ipsum ${nameOf(42)} dolor sit amet, call +1 555 123 4567. `.repeat(3000);
    const t0 = performance.now();
    const spans = findPii(text, big);
    expect(performance.now() - t0).toBeLessThan(150);
    expect(spans.filter(x => x.kind === 'name')).toHaveLength(3000);
  });
  it('scans long unspaced runs and digit soup in under 150 ms', () => {
    const text = `${'a'.repeat(100000)} ${'A'.repeat(50000)} ${'0123456789 '.repeat(9000)}`;
    const t0 = performance.now();
    findPii(text, dict);
    expect(performance.now() - t0).toBeLessThan(150);
  });
});

describe('fix round 1: leak classes', () => {
  const d = (...names) => buildNameDictionary({ names });

  it('buildNameDictionary skips emails, stoplisted and short tokens', () => {
    const b = d('a@b.com', 'Will Ng', 'Jo Li', 'Anna Smith-Jones', "Pat O’Brien");
    expect([...b.tokens].sort()).toEqual(['anna', 'brien', 'jones', "o'brien", 'pat', 'smith', 'smith-jones']);
    expect(b.fullNames.has('will ng')).toBe(true);
    expect(b.fullNames.has('a')).toBe(false);
    expect(b.size).toBe(b.tokens.size + b.fullNames.size + b.unspaced.size);
  });

  it('masks possessives, hyphenated and apostrophe names', () => {
    expect(kinds("John Smith's invoice")).toEqual([["John Smith's", 'name']]);
    expect(kinds('Ms Smith', d('Anna Smith-Jones'))).toEqual([['Smith', 'name']]);
    expect(kinds('Mr Smith-Jones', d('Smith'))).toEqual([['Smith-Jones', 'name']]);
    expect(kinds('Hi O’Brien', d("Pat O'Brien"))).toEqual([['O’Brien', 'name']]);
  });

  it('masks names in caseless and unspaced scripts', () => {
    expect(kinds('请联系王小明。', d('王小明'))).toEqual([['王小明', 'name']]);
    expect(kinds('Hi محمد علي', d('محمد علي'))).toEqual([['محمد علي', 'name']]);
  });

  it('keeps the uncovered part of a partly overlapped span', () => {
    expect(kinds('Baker Street 5, 10115\nJohn Smith')).toEqual([['Baker Street 5, 10115', 'address'], ['John Smith', 'name']]);
    expect(kinds('Anna Smith@x.com', d('Anna Smith'))).toEqual([['Anna', 'name'], ['Smith@x.com', 'email']]);
    expect(kinds('123 456 7890 Main Street', EMPTY_DICTIONARY)).toEqual([['123 456', 'phone'], ['7890 Main Street', 'address']]);
  });

  it('finds a phone inside a rejected run', () => {
    expect(kinds('01.10.2026 861234567', EMPTY_DICTIONARY)).toEqual([['861234567', 'phone']]);
    expect(kinds('861234567 01.10.2026', EMPTY_DICTIONARY)).toEqual([['861234567', 'phone']]);
  });

  it('emails with underscores', () => {
    expect(kinds('xx_john@x.com', EMPTY_DICTIONARY)).toEqual([['xx_john@x.com', 'email']]);
  });

  it('addresses in ALL CAPS, leading street words and more suffixes', () => {
    expect(kinds('221B BAKER STREET', EMPTY_DICTIONARY)).toEqual([['221B BAKER STREET', 'address']]);
    expect(kinds('HAUPTSTRASSE 5', EMPTY_DICTIONARY)).toEqual([['HAUPTSTRASSE 5', 'address']]);
    expect(kinds('at 10 Rue Lafayette', EMPTY_DICTIONARY)).toEqual([['10 Rue Lafayette', 'address']]);
    expect(kinds('Calle Mayor 5', EMPTY_DICTIONARY)).toEqual([['Calle Mayor 5', 'address']]);
    expect(kinds('Via Roma 10', EMPTY_DICTIONARY)).toEqual([['Via Roma 10', 'address']]);
    expect(kinds('7 Elm Crescent', EMPTY_DICTIONARY)).toEqual([['7 Elm Crescent', 'address']]);
  });

  it('maskText drops combining marks', () => {
    expect(maskText('Ambrazevičius'.normalize('NFD'))).toBe('x'.repeat(13));
  });

  it('folds letters NFD leaves alone', () => {
    expect(kinds('Łukasz wrote', d('Lukasz Nowak'))).toEqual([['Łukasz', 'name']]);
    expect(kinds('Herr STRAUSS', d('Strauß'))).toEqual([['STRAUSS', 'name']]);
    expect(foldName('Ørsted Đurić Œuvre')).toBe('orsted duric oeuvre');
  });
});

// A spam sender's address can stay readable; nothing else does.
describe('dictionary reveal', () => {
  const prize = buildNameDictionary({ names: ['Prize Team'] });
  const withReveal = (d, ...values) => ({ ...d, reveal: new Set(values) });

  it('drops only the email spans whose whole text is in the set, case-insensitively', () => {
    const d = withReveal(prize, 'spam@prize.example');
    expect(kinds('From SPAM@Prize.example and other@prize.example', d)).toEqual([['other@prize.example', 'email']]);
  });

  it('is exact: a longer address, a prefix and a name are not revealed', () => {
    const d = withReveal(prize, 'spam@prize.example');
    expect(kinds('xspam@prize.example spam@prize.example.org', d).map(([t]) => t)).toEqual(['xspam@prize.example', 'spam@prize.example.org']);
    expect(kinds('Prize Team wrote', withReveal(prize, 'prize team'))).toEqual([['Prize Team', 'name']]);
  });

  it('name tokens inside a revealed address stay unmasked as a whole, not masked piecemeal', () => {
    // "prize" is a name token, but the address claimed its characters first.
    expect(maskString('mail spam@prize.example now', withReveal(prize, 'spam@prize.example'))).toBe('mail spam@prize.example now');
  });

  it('a dictionary without reveal behaves as before', () => {
    expect(kinds('spam@prize.example', prize)).toEqual([['spam@prize.example', 'email']]);
  });

  it('unionDictionaries carries reveal through every path', () => {
    const a = withReveal(prize, 'a@x.example');
    const b = withReveal(buildNameDictionary({ names: ['Owen Ashcombe'] }), 'b@x.example');
    const both = unionDictionaries(a, b);
    expect([...both.reveal].sort()).toEqual(['a@x.example', 'b@x.example']);
    expect(both.tokens.has('prize') && both.tokens.has('owen')).toBe(true);
    // A cold host (empty dictionary) on either side must not drop it.
    expect([...unionDictionaries(withReveal(EMPTY_DICTIONARY, 'c@x.example'), prize).reveal]).toEqual(['c@x.example']);
    expect([...unionDictionaries(prize, withReveal(EMPTY_DICTIONARY, 'd@x.example')).reveal]).toEqual(['d@x.example']);
    expect(unionDictionaries(withReveal(EMPTY_DICTIONARY, 'c@x.example'), prize).tokens.has('prize')).toBe(true);
    expect(unionDictionaries(prize, prize)).not.toHaveProperty('reveal');
    // Neither input is mutated (the host's dictionary is shared, the empty one frozen).
    expect(prize).not.toHaveProperty('reveal');
    expect(EMPTY_DICTIONARY).not.toHaveProperty('reveal');
  });
});
