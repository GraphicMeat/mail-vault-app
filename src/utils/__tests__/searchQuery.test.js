import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '../searchQuery';

describe('search query filters', () => {
  it('lifts a tag filter out of the text', () => {
    expect(parseSearchQuery('invoice tag:receipt')).toEqual({ text: 'invoice', tags: ['receipt'], fields: [] });
  });

  it('takes a quoted tag name whole', () => {
    expect(parseSearchQuery('tag:"needs reply" invoice')).toEqual({ text: 'invoice', tags: ['needs reply'], fields: [] });
  });

  it('collects every tag named', () => {
    expect(parseSearchQuery('tag:receipt tag:clients')).toEqual({ text: '', tags: ['receipt', 'clients'], fields: [] });
  });

  it('reads the key whatever its case', () => {
    expect(parseSearchQuery('Tag:Receipt')).toEqual({ text: '', tags: ['Receipt'], fields: [] });
  });

  it('leaves a key it does not know in the text, never an error', () => {
    expect(parseSearchQuery('from:bob hello')).toEqual({ text: 'from:bob hello', tags: [], fields: [] });
  });

  it('leaves a bare colon alone', () => {
    expect(parseSearchQuery('tag: receipt')).toEqual({ text: 'tag: receipt', tags: [], fields: [] });
  });

  it('lifts a field filter out of the text', () => {
    expect(parseSearchQuery('invoice field:Priority=High')).toEqual({
      text: 'invoice', tags: [], fields: [{ name: 'Priority', value: 'High' }],
    });
  });

  it('takes a quoted field name or value whole', () => {
    expect(parseSearchQuery('field:"Needs invoice"=yes')).toEqual({
      text: '', tags: [], fields: [{ name: 'Needs invoice', value: 'yes' }],
    });
    expect(parseSearchQuery('field:Owner="Ann Lee"')).toEqual({
      text: '', tags: [], fields: [{ name: 'Owner', value: 'Ann Lee' }],
    });
  });

  it('a field named with no value asks which messages have any', () => {
    expect(parseSearchQuery('field:Priority')).toEqual({
      text: '', tags: [], fields: [{ name: 'Priority', value: null }],
    });
  });

  it('leaves a field term it cannot read in the text', () => {
    expect(parseSearchQuery('field: Priority')).toEqual({ text: 'field: Priority', tags: [], fields: [] });
  });
});
