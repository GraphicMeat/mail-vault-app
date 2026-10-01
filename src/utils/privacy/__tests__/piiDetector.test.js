// src/utils/privacy/__tests__/piiDetector.test.js
import { describe, it, expect } from 'vitest';
import { foldName, buildNameDictionary, findPii, maskText, maskString, EMPTY_DICTIONARY } from '../piiDetector';

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
  it('scans 200 KB against 5,000 names in under 150 ms', () => {
    const names = Array.from({ length: 5000 }, (_, i) => `Person${i} Surname${i}`);
    const big = buildNameDictionary({ names });
    const text = 'Lorem ipsum Person42 Surname42 dolor sit amet, call +1 555 123 4567. '.repeat(3000);
    const t0 = performance.now();
    findPii(text, big);
    expect(performance.now() - t0).toBeLessThan(150);
  });
});
