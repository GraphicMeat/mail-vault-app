import { describe, expect, it } from 'vitest';
import { parseSearchQuery as parse } from '../searchQuery';

/// Every operator at rest: what a query with none of them parses to.
const NONE = {
  sender: null, to: null, folder: null, hasAttachments: false, unread: false, dateFrom: null, dateTo: null, exclude: [],
};
const parseSearchQuery = (query) => {
  const { text, tags, fields, ...rest } = parse(query);
  expect(rest).toEqual(NONE);
  return { text, tags, fields };
};

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
    expect(parseSearchQuery('foo:bob hello')).toEqual({ text: 'foo:bob hello', tags: [], fields: [] });
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

describe('search operators', () => {
  const ops = (query) => {
    const { tags, fields, ...rest } = parse(query);
    expect(tags).toEqual([]);
    expect(fields).toEqual([]);
    return rest;
  };

  it.each([
    ['from:bob invoice', { text: 'invoice', sender: 'bob' }],
    ['from:"John Smith" invoice', { text: 'invoice', sender: 'John Smith' }],
    ['FROM:bob', { text: '', sender: 'bob' }],
    ['to:ann@x.test', { text: '', to: 'ann@x.test' }],
    ['to:"Ann Lee" report', { text: 'report', to: 'Ann Lee' }],
    ['in:inbox', { text: '', folder: 'INBOX' }],
    ['in:sent', { text: '', folder: 'Sent' }],
    ['in:Trash', { text: '', folder: 'Trash' }],
    ['in:spam', { text: '', folder: 'Junk' }],
    ['in:archive', { text: '', folder: 'Archive' }],
    ['in:anywhere', { text: '', folder: 'all' }],
    ['in:Projects/2026', { text: '', folder: 'Projects/2026' }],
    ['in:"Client work" memo', { text: 'memo', folder: 'Client work' }],
    ['has:attachment', { text: '', hasAttachments: true }],
    ['has:attachments', { text: '', hasAttachments: true }],
    ['Is:Unread', { text: '', unread: true }],
    ['after:2026-09-01', { text: '', dateFrom: '2026-09-01' }],
    ['after:2026/9/1', { text: '', dateFrom: '2026-09-01' }],
    // `before:` is exclusive; the filter's end date is inclusive.
    ['before:2026-09-10', { text: '', dateTo: '2026-09-09' }],
    ['before:2026-03-01', { text: '', dateTo: '2026-02-28' }],
    ['before:2024-03-01', { text: '', dateTo: '2024-02-29' }],
    ['before:2026-01-01', { text: '', dateTo: '2025-12-31' }],
    ['-spam', { text: '', exclude: ['spam'] }],
    ['report -"weekly digest" -draft', { text: 'report', exclude: ['weekly digest', 'draft'] }],
  ])('%s', (query, expected) => {
    expect(ops(query)).toEqual({ ...NONE, ...expected });
  });

  it.each([
    'e-mail',
    'a - b',
    'is:starred',
    'has:drive',
    'before:2026-13-45',
    'after:2026-02-30',
    'before:yesterday',
    'foo:bar',
    'from: bob',
  ])('%s stays free text', (query) => {
    expect(ops(query)).toEqual({ ...NONE, text: query });
  });

  it('reads every operator in one query, around the free text', () => {
    expect(ops('from:bob is:unread invoice in:sent has:attachment after:2026-01-01 before:2026-02-01 -paid to:me@x.test')).toEqual({
      text: 'invoice',
      sender: 'bob',
      to: 'me@x.test',
      folder: 'Sent',
      hasAttachments: true,
      unread: true,
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      exclude: ['paid'],
    });
  });

  it('keeps tags and fields beside the operators', () => {
    const parsed = parse('tag:receipt from:bob field:Priority=High');
    expect(parsed).toMatchObject({ text: '', tags: ['receipt'], sender: 'bob', fields: [{ name: 'Priority', value: 'High' }] });
  });
});
