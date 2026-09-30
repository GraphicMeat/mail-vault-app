import { describe, expect, it } from 'vitest';
import {
  addTags, commitText, formatTag, operatorMenu, parseTag, pickOperator, removeTag, replaceTag,
  serializeTags, slashQuery, tokenizeQuery,
} from '../searchTags';
import { SEARCH_OPERATORS, parseSearchQuery } from '../searchQuery';

describe('tokenizeQuery', () => {
  it('splits on whitespace and keeps a quoted run whole, wherever it sits in the token', () => {
    expect(tokenizeQuery('  invoice  from:ann   has:attachment ')).toEqual(['invoice', 'from:ann', 'has:attachment']);
    expect(tokenizeQuery('tag:"Needs reply" -"a b" field:"Two words"=v field:Name="a b"'))
      .toEqual(['tag:"Needs reply"', '-"a b"', 'field:"Two words"=v', 'field:Name="a b"']);
    expect(tokenizeQuery('"quarterly report" q3')).toEqual(['"quarterly report"', 'q3']);
  });

  it('runs an unclosed quote to the end instead of losing it', () => {
    expect(tokenizeQuery('from:"Ann Lee')).toEqual(['from:"Ann Lee']);
  });

  it('keeps an operator with no value, and every duplicate, as it was typed', () => {
    expect(tokenizeQuery('from: alice')).toEqual(['from:', 'alice']);
    expect(tokenizeQuery('a || b || c')).toEqual(['a', '||', 'b', '||', 'c']);
    expect(tokenizeQuery('x x')).toEqual(['x', 'x']);
  });

  it('reads nothing out of nothing', () => {
    expect(tokenizeQuery('')).toEqual([]);
    expect(tokenizeQuery('   ')).toEqual([]);
    expect(tokenizeQuery(null)).toEqual([]);
  });
});

describe('serializeTags', () => {
  it('is a plain space join, dropping nothing', () => {
    expect(serializeTags(['invoice', 'from:', 'tag:"Needs reply"'])).toBe('invoice from: tag:"Needs reply"');
    expect(serializeTags([])).toBe('');
  });

  // The daemon's search contract is the one query string. Whatever the box
  // shows as tags, the string it hands over must mean exactly what the
  // string it read meant.
  it('round-trips every query to one the parser reads the same way', () => {
    const corpus = [
      'invoice', 'quarterly report 2025', 'a || b || c', 'x && y', 'field:"Two words"=v',
      'field:Name="a b"', 'field:Name', 'tag:"Needs reply" urgent', '-"a b" -newsletter', 'FROM:x',
      'from:', 'from: alice', 'from:x from:y', 'in:sent is:unread has:attachment',
      'after:2026-01-31 before:2026-03-01', '"quarterly report"', 'from:"Ann Lee" to:bob@x.test',
      'is:starred', 'before:2026-13-45', 'e-mail -', 'x x',
    ];
    for (const query of corpus) {
      expect(parseSearchQuery(serializeTags(tokenizeQuery(query))), query).toEqual(parseSearchQuery(query));
    }
  });
});

describe('parseTag and formatTag', () => {
  it('names the operator a tag carries and its bare value', () => {
    expect(parseTag('from:ann@x.test')).toEqual({ key: 'from', value: 'ann@x.test' });
    expect(parseTag('FROM:"Ann Lee"')).toEqual({ key: 'from', value: 'Ann Lee' });
    expect(parseTag('from:')).toEqual({ key: 'from', value: '' });
    expect(parseTag('-"a b"')).toEqual({ key: '-', value: 'a b' });
    expect(parseTag('field:"Two words"="a b"')).toEqual({ key: 'field', value: 'Two words=a b' });
    expect(parseTag('invoice')).toEqual({ key: null, value: 'invoice' });
    expect(parseTag('http://x.test')).toEqual({ key: null, value: 'http://x.test' }, 'not an operator');
    expect(parseTag('-')).toEqual({ key: null, value: '-' });
  });

  it('quotes a value with spaces the way the operator parser takes it, and never inside', () => {
    expect(formatTag('from', 'Ann Lee')).toBe('from:"Ann Lee"');
    expect(formatTag('from', ' ann@x.test ')).toBe('from:ann@x.test');
    expect(formatTag('tag', 'say "hi" now')).toBe('tag:"say hi now"');
    expect(formatTag('-', 'a b')).toBe('-"a b"');
    expect(formatTag('field', 'Two words=a b')).toBe('field:"Two words"="a b"');
    expect(formatTag('field', 'Status')).toBe('field:Status');
    expect(formatTag('from', '  ')).toBe('');
    expect(formatTag(null, 'invoice')).toBe('invoice');
  });

  it('formats what it parses back to a tag the parser reads the same way', () => {
    for (const tag of ['from:"Ann Lee"', 'tag:"Needs reply"', '-"a b"', 'field:"Two words"="a b"', 'in:sent']) {
      const { key, value } = parseTag(tag);
      expect(parseSearchQuery(formatTag(key, value)), tag).toEqual(parseSearchQuery(tag));
    }
  });
});

describe('editing a list of tags', () => {
  it('commits typed text as its words, never adding quotes the server lane would search for', () => {
    expect(commitText('  quarterly report ')).toEqual(['quarterly', 'report']);
    expect(commitText('from:ann invoice')).toEqual(['from:ann', 'invoice']);
    expect(commitText('"quarterly report"')).toEqual(['"quarterly report"'], 'quotes the person typed stay');
    expect(commitText('  ')).toEqual([]);
  });

  it('adds only what is not there yet, ignoring case', () => {
    expect(addTags(['invoice', 'from:ann'], ['Invoice', 'q3', 'q3', 'FROM:ann'])).toEqual(['invoice', 'from:ann', 'q3']);
    expect(addTags([], [])).toEqual([]);
  });

  it('replaces one tag with what its edit became, and an empty edit removes it', () => {
    expect(replaceTag(['a', 'from:ann', 'b'], 1, ['from:bob'])).toEqual(['a', 'from:bob', 'b']);
    expect(replaceTag(['a', 'from:ann', 'b'], 1, ['x', 'y'])).toEqual(['a', 'x', 'y', 'b']);
    expect(replaceTag(['a', 'from:ann', 'b'], 1, [])).toEqual(['a', 'b']);
    expect(replaceTag(['a', 'from:ann', 'b'], 1, ['A'])).toEqual(['a', 'b'], 'an edit that duplicates another tag merges into it');
    expect(removeTag(['a', 'b'], 0)).toEqual(['b']);
  });
});

describe('the operator menu', () => {
  it('opens on a slash at the start of a word only', () => {
    expect(slashQuery('/')).toEqual({ before: '', filter: '' });
    expect(slashQuery('invoice /fr')).toEqual({ before: 'invoice', filter: 'fr' });
    expect(slashQuery('a/b')).toBeNull();
    expect(slashQuery('/fr om')).toBeNull();
    expect(slashQuery('')).toBeNull();
  });

  it('lists every operator, narrowed by what follows the slash', () => {
    expect(operatorMenu('')).toEqual(SEARCH_OPERATORS);
    expect(operatorMenu('fr').map(op => op.id)).toEqual(['from']);
    expect(operatorMenu('HAS').map(op => op.id)).toEqual(['hasAttachment']);
    expect(operatorMenu('zz')).toEqual([]);
  });

  it('inserts a complete operator whole and leaves the others waiting for a value', () => {
    const op = id => SEARCH_OPERATORS.find(entry => entry.id === id);
    expect(pickOperator(op('hasAttachment'))).toEqual({ tag: 'has:attachment', key: null });
    expect(pickOperator(op('isUnread'))).toEqual({ tag: 'is:unread', key: null });
    expect(pickOperator(op('from'))).toEqual({ tag: 'from:', key: 'from' });
    expect(pickOperator(op('field'))).toEqual({ tag: 'field:', key: 'field' });
    expect(pickOperator(op('exclude'))).toEqual({ tag: '-', key: '-' });
  });
});
