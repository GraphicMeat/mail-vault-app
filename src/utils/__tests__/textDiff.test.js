import { describe, it, expect } from 'vitest';
import { diffText, clipDiff } from '../textDiff';

const join = (parts, type) => parts.filter(p => p.type === type).map(p => p.text).join('');
const ADDRESS = 'Jasinskio && 14A-37 || mindaugo g. 30 || Vaivorykštės g. 63';

describe('diffText', () => {
  it('marks text added at the end', () => {
    const parts = diffText(ADDRESS, `${ADDRESS}, asd`);
    expect(join(parts, 'add')).toBe(', asd');
    expect(join(parts, 'del')).toBe('');
    expect(join(parts, 'same')).toBe(ADDRESS);
  });

  it('marks text removed from the end', () => {
    const parts = diffText(`${ADDRESS}, asd`, ADDRESS);
    expect(join(parts, 'del')).toBe(', asd');
    expect(join(parts, 'add')).toBe('');
    expect(join(parts, 'same')).toBe(ADDRESS);
  });

  it('keeps a word with accented letters whole', () => {
    const parts = diffText('Vaivorykštės g. 63', 'Vaivorykštė g. 63');
    expect(join(parts, 'del')).toBe('Vaivorykštės');
    expect(join(parts, 'add')).toBe('Vaivorykštė');
  });

  it('shows a replaced word as removed then added, in place', () => {
    const parts = diffText('from bob or alice', 'from bob or carol');
    expect(parts.map(p => p.type)).toEqual(['same', 'del', 'add']);
    expect(join(parts, 'del')).toBe('alice');
    expect(join(parts, 'add')).toBe('carol');
  });

  it('reads an empty side as all added or all removed', () => {
    expect(diffText('', 'invoice')).toEqual([{ type: 'add', text: 'invoice' }]);
    expect(diffText('invoice', '')).toEqual([{ type: 'del', text: 'invoice' }]);
    expect(diffText('', '')).toEqual([]);
  });

  it('reads back to both sides exactly', () => {
    const before = 'a && b || c d';
    const after = 'a || b && c, e d';
    const parts = diffText(before, after);
    expect(parts.filter(p => p.type !== 'add').map(p => p.text).join('')).toBe(before);
    expect(parts.filter(p => p.type !== 'del').map(p => p.text).join('')).toBe(after);
  });

  it('copes with a long text without freezing', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ');
    const after = before.replace('w1500', 'changed');
    const parts = diffText(before, after);
    expect(join(parts, 'add')).toBe('changed');
  });
});

describe('clipDiff', () => {
  it('keeps the change in view when the shared text is longer than the window', () => {
    const parts = clipDiff(diffText(ADDRESS, `${ADDRESS}, asd`), 20);
    expect(parts[0]).toEqual({ type: 'same', text: '…' + ADDRESS.slice(-20) });
    expect(parts[1]).toEqual({ type: 'add', text: ', asd' });
    expect(parts).toHaveLength(2);
  });

  it('trims the shared tail after a change and the middle between two', () => {
    const before = `${'x '.repeat(40)}one${' y'.repeat(40)} two${' z'.repeat(40)}`;
    const after = before.replace('one', 'ONE').replace('two', 'TWO');
    const parts = clipDiff(diffText(before, after), 10);
    const shared = parts.filter(p => p.type === 'same');
    expect(shared.every(p => p.text.length <= 21)).toBe(true);
    expect(shared[0].text.startsWith('…')).toBe(true);
    expect(shared.at(-1).text.endsWith('…')).toBe(true);
    expect(join(parts, 'del')).toBe('onetwo');
  });

  it('leaves short text untouched', () => {
    const parts = diffText('a b', 'a c');
    expect(clipDiff(parts, 20)).toEqual(parts);
  });
});
