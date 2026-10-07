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

  // One download button in the hero. Without a script it is the macOS one;
  // english-site.js swaps in the visitor's own platform.
  it('offers one primary download in the static hero, macOS by default', () => {
    const primary = [...doc.querySelectorAll('.hm-hero-actions .mv-button:not(.mv-secondary)')].filter((el) => !el.closest('[hidden]'));
    expect(primary.length).toBe(1);
    expect(primary[0].dataset.download).toBe('mac');
    expect(primary[0].dataset.acquisitionPlacement).toBe('hero');
    expect(doc.querySelector('.hm-hero [data-hero-platform="fallback"]')).toBeNull();
    expect(doc.querySelector('.hm-hero a.mv-text-link[href$="/get-started.html?plan=free#platforms"]')).not.toBeNull();
  });

  it('prices Premium under the hero download from the localized price template', () => {
    // Only the phone's "open it on your computer" hint may sit between them.
    const line = doc.querySelector('.hm-hero-actions + .hm-send-hint + .hm-price');
    expect(line).not.toBeNull();
    const link = line.querySelector('a[href$="/pricing.html"]');
    expect(link.dataset.acquisitionPlacement).toBe('hero');
    expect(link.querySelector('[data-mv-price="{yearly}"]').textContent).toBe('$25');
    expect(line.textContent).toMatch(/14/);
    expect(doc.querySelector('script[src^="/pricing-localize.js"]')).not.toBeNull();
  });

  it('keeps a single, unchanged headline', () => {
    expect(doc.querySelectorAll('h1')).toHaveLength(1);
    expect(doc.querySelector('.hm-hero h1').id).toBe('hero-title');
  });
});

describe('English hero copy', () => {
  const en = load('website/index.html');

  it('keeps the headline word for word', () => {
    expect(en.querySelector('h1').innerHTML).toBe('Your email.<br><span class="hm-grad">Yours to keep.</span>');
  });

  it('states the free plan, the yearly price and the trial in one line', () => {
    expect(en.querySelector('.hm-price').textContent.trim()).toBe('Free forever, with unlimited manual backups. Premium is $25/year with a 14-day free trial.');
  });

  it('leads with daily use, then keeping your copy', () => {
    const lead = en.querySelector('.hm-lead').textContent;
    expect(lead.startsWith('A fast, private email app')).toBe(true);
    expect(lead.indexOf('Search 50,000 messages')).toBeLessThan(lead.indexOf('your copy stays'));
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
