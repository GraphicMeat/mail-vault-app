import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// The homepage leads with the vault, backs the hero with three checkable facts,
// and reaches the comparison table before the grab-bag of small features.
const LOCALES = ['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'];
const load = (file) => new JSDOM(readFileSync(file, 'utf8')).window.document;
const ids = (doc) => [...doc.querySelectorAll('main section[id]')].map((s) => s.id);

describe.each(['website/index.html', 'index.html', ...LOCALES.map((l) => `website/${l}/index.html`)])('%s', (file) => {
  const doc = load(file);

  it('opens the pillars with the vault', () => {
    expect(doc.querySelector('#how-it-works > section').id).toBe('backups');
  });

  it('shows three facts under the hero lead', () => {
    expect(doc.querySelectorAll('.hm-hero .hm-facts li')).toHaveLength(3);
  });

  it('puts the comparison before the small features', () => {
    expect(ids(doc).indexOf('compare')).toBeLessThan(ids(doc).indexOf('more'));
  });
});

describe('localized hero', () => {
  const en = load('website/index.html');
  const text = (doc) => [doc.querySelector('.hm-lead'), ...doc.querySelectorAll('.hm-facts li')].map((n) => n.textContent);

  it.each(LOCALES)('%s translates the lead and every fact', (l) => {
    const ours = text(load(`website/${l}/index.html`));
    text(en).forEach((s, i) => expect(ours[i]).not.toBe(s));
  });
});
