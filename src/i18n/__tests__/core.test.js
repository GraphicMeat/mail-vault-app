import { describe, it, expect } from 'vitest';
import { interpolate, lookup, translate } from '../core.js';

const en = { greet: 'Hi {{name}}', 'n.items_one': '{{count}} item', 'n.items_other': '{{count}} items', only: 'English only' };
const fr = { greet: 'Salut {{name}}', 'n.items_one': '{{count}} élément', 'n.items_other': '{{count}} éléments' };

describe('i18n core', () => {
  it('interpolates known slots and leaves unknown ones', () => {
    expect(interpolate('{{a}} and {{b}}', { a: 1 })).toBe('1 and {{b}}');
    expect(interpolate('plain {{a}}')).toBe('plain {{a}}');
  });

  it('count 1 picks the singular in English', () => {
    expect(translate(en, en, 'en', 'n.items', { count: 1 })).toBe('1 item');
    expect(translate(en, en, 'en', 'n.items', { count: 0 })).toBe('0 items');
  });

  it('a non-English locale uses its own plural rules: French 0 is singular', () => {
    expect(translate(fr, en, 'fr', 'n.items', { count: 0 })).toBe('0 élément');
    expect(translate(fr, en, 'fr', 'n.items', { count: 2 })).toBe('2 éléments');
  });

  it('falls back to English, then to the key', () => {
    expect(translate(fr, en, 'fr', 'only')).toBe('English only');
    expect(lookup(fr, en, 'fr', 'missing.key')).toBe('missing.key');
    expect(translate(fr, en, 'fr', 'greet', { name: 'Ana' })).toBe('Salut Ana');
  });
});
