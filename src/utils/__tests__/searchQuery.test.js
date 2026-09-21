import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '../searchQuery';

describe('search query filters', () => {
  it('lifts a tag filter out of the text', () => {
    expect(parseSearchQuery('invoice tag:receipt')).toEqual({ text: 'invoice', tags: ['receipt'] });
  });

  it('takes a quoted tag name whole', () => {
    expect(parseSearchQuery('tag:"needs reply" invoice')).toEqual({ text: 'invoice', tags: ['needs reply'] });
  });

  it('collects every tag named', () => {
    expect(parseSearchQuery('tag:receipt tag:clients')).toEqual({ text: '', tags: ['receipt', 'clients'] });
  });

  it('reads the key whatever its case', () => {
    expect(parseSearchQuery('Tag:Receipt')).toEqual({ text: '', tags: ['Receipt'] });
  });

  it('leaves a key it does not know in the text, never an error', () => {
    expect(parseSearchQuery('from:bob hello')).toEqual({ text: 'from:bob hello', tags: [] });
  });

  it('leaves a bare colon alone', () => {
    expect(parseSearchQuery('tag: receipt')).toEqual({ text: 'tag: receipt', tags: [] });
  });
});
