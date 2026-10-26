import { describe, it, expect } from 'vitest';
import { wordKey, wordTokens } from '../wordKey';

describe('wordKey', () => {
  it('lowercases and trims punctuation at the edges only', () => {
    expect(wordKey('Smith,')).toBe('smith');
    expect(wordKey('(Ana)')).toBe('ana');
    expect(wordKey('<Ana@X.co>')).toBe('ana@x.co');
    expect(wordKey('"O\'Brien"')).toBe("o'brien");
    expect(wordKey('e-mail')).toBe('e-mail');
  });

  it('keeps letters of any script and digits', () => {
    expect(wordKey('Žemaitis.')).toBe('žemaitis');
    expect(wordKey('王小明，')).toBe('王小明');
    expect(wordKey('+370 ')).toBe('370');
  });

  it('is empty for something with no letter or digit, or no text', () => {
    for (const v of ['—', '...', '', null, undefined]) expect(wordKey(v)).toBe('');
  });
});

describe('wordTokens', () => {
  it('splits on whitespace and bounds each word without its edge punctuation', () => {
    const text = 'Hi Ana, mail <ana@x.co>.';
    const t = wordTokens(text);
    expect(t.map(x => x.key)).toEqual(['hi', 'ana', 'mail', 'ana@x.co']);
    expect(t.map(x => text.slice(x.start, x.end))).toEqual(['Hi', 'Ana', 'mail', 'ana@x.co']);
    expect(t.map(x => x.text)).toEqual(['Hi', 'Ana,', 'mail', '<ana@x.co>.']);
  });

  it('skips runs with nothing to read, and handles newlines and runs of spaces', () => {
    expect(wordTokens('a  —  b\n\nc').map(x => x.key)).toEqual(['a', 'b', 'c']);
    expect(wordTokens('')).toEqual([]);
    expect(wordTokens(null)).toEqual([]);
  });
});
