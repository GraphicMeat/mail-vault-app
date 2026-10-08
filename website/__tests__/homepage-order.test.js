import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// The locale homepages (built from the frozen English snapshot until the clips
// layout is localized) lead with the vault, back the hero with three checkable
// facts, and reach the comparison table before the grab-bag of small features.
// The English homepage's own layout is in homepage-clips-layout.test.js.
const LOCALES = ['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'];
const load = (file) => new JSDOM(readFileSync(file, 'utf8')).window.document;
const ids = (doc) => [...doc.querySelectorAll('main section[id]')].map((s) => s.id);
const FROZEN = 'website/i18n/frozen/index.html';

describe.each([FROZEN, ...LOCALES.map((l) => `website/${l}/index.html`)])('%s', (file) => {
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

  // Exactly one button in the hero: the demo is a text link beside the others.
  it('keeps the demo as a text link, so the static hero shows one button', () => {
    const inner = doc.querySelector('.hm-hero-inner');
    expect([...inner.querySelectorAll('.mv-button')].filter((el) => !el.closest('[hidden]'))).toHaveLength(1);
    const demo = inner.querySelector('a[data-acquisition-destination="demo"]');
    expect(demo.classList.contains('mv-text-link')).toBe(true);
    expect(demo.classList.contains('mv-button')).toBe(false);
    expect(demo.dataset.acquisitionEvent).toBe('home_cta');
    expect(demo.dataset.acquisitionPlacement).toBe('hero');
    expect(demo.closest('.hm-hero-actions')).toBeNull();
  });

  // The closing section follows the hero: one download, macOS without a script,
  // the rest behind a text link, and the phone's email form from the same code path.
  it('offers one download in the static final section, macOS by default', () => {
    const final = doc.getElementById('download');
    const shown = [...final.querySelectorAll('.mv-button')].filter((el) => !el.closest('[hidden]'));
    expect(shown).toHaveLength(1);
    expect(shown[0].dataset.download).toBe('mac');
    expect(shown[0].dataset.acquisitionPlacement).toBe('final');
    expect(final.querySelector('[data-hero-platform="fallback"]')).toBeNull();
    const other = final.querySelector('a.mv-text-link[href$="/get-started.html?plan=free#platforms"]');
    expect(other).not.toBeNull();
    expect(other.dataset.acquisitionPlacement).toBe('final');
    expect(other.dataset.acquisitionDestination).toBe('setup');
    expect(final.querySelector('#send-link-final').hasAttribute('data-send-link-primary')).toBe(true);
    const opener = final.querySelector('[data-send-link-open][aria-controls="send-link-final"]');
    expect(opener.classList.contains('mv-text-link')).toBe(true);
    expect(opener.classList.contains('mv-button')).toBe(false);
  });

  it('prices Premium under the hero download from the localized price template', () => {
    // Only the phone's "open it on your computer" hint may sit between them.
    const line = doc.querySelector('.hm-hero-actions + .hm-send-hint + .hm-price');
    expect(line).not.toBeNull();
    const link = line.querySelector('a[href$="/pricing.html"]');
    expect(link.dataset.acquisitionPlacement).toBe('hero');
    expect(link.querySelector('[data-mv-price="{yearly}"]').textContent).toBe('$25');
    // The standard price after early access is a plain statement, never a struck "was" price.
    expect(link.querySelector('[data-mv-price="{standardYearly}"]').textContent).toBe('$39');
    expect(line.querySelector('s, del, strike')).toBeNull();
    expect(line.textContent).toMatch(/14/);
    expect(line.textContent).toMatch(/5/);
    expect(line.textContent).not.toMatch(/—/);
    expect(doc.querySelector('script[src^="/pricing-localize.js"]')).not.toBeNull();
  });

  it('repeats the early-bird and standard price under the final download', () => {
    const line = doc.querySelector('#download .mv-actions + .hm-send-hint + .hm-price');
    expect(line).not.toBeNull();
    const link = line.querySelector('a[href$="/pricing.html"]');
    expect(link.dataset.acquisitionEvent).toBe('home_cta');
    expect(link.dataset.acquisitionPlacement).toBe('final');
    expect(link.dataset.acquisitionDestination).toBe('pricing');
    expect(link.querySelector('[data-mv-price="{yearly}"]').textContent).toBe('$25');
    expect(link.querySelector('[data-mv-price="{standardYearly}"]').textContent).toBe('$39');
    expect(line.querySelector('s, del, strike')).toBeNull();
    expect(line.textContent).not.toMatch(/—/);
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

  it('leads with daily use, then keeping your copy', () => {
    const lead = en.querySelector('.hm-lead').textContent;
    expect(lead.startsWith('A fast, private email app')).toBe(true);
    expect(lead.indexOf('Search 50,000 messages')).toBeLessThan(lead.indexOf('your copy stays'));
  });

  it('states the early-bird and standard price under the final download', () => {
    const line = en.querySelector('#download .hm-price');
    expect(line.textContent.trim()).toBe('Early Bird & Family Pricing: Premium $25/year, 36% below the standard price after early access: $39/year.');
    expect(line.querySelector('[data-mv-price="{earlyBirdSavingsPercent}%"]').textContent).toBe('36%');
    // Once every spot is taken only "Premium {yearly}/year." stays.
    const early = [...line.querySelectorAll('[data-mv-early]')].map((el) => el.textContent).join('|');
    expect(early).toBe('Early Bird & Family Pricing: |, 36% below the standard price after early access: $39/year');
  });

  it('prices the final download the same way as the locale pages', () => {
    const line = en.querySelector('#download .mv-actions + .hm-send-hint + .hm-price');
    const link = line.querySelector('a[href$="/pricing.html"]');
    expect(link.dataset.acquisitionPlacement).toBe('final');
    expect(link.dataset.acquisitionDestination).toBe('pricing');
    expect(line.querySelector('s, del, strike')).toBeNull();
  });
});

describe('localized hero', () => {
  const en = load(FROZEN);
  const text = (doc) => [doc.querySelector('.hm-lead'), ...doc.querySelectorAll('.hm-facts li')].map((n) => n.textContent);

  it.each(LOCALES)('%s translates the lead and every fact', (l) => {
    const ours = text(load(`website/${l}/index.html`));
    text(en).forEach((s, i) => expect(ours[i]).not.toBe(s));
  });

  it.each(LOCALES)('%s translates both early-bird price lines', (l) => {
    const doc = load(`website/${l}/index.html`);
    for (const sel of ['.hm-hero .hm-price', '#download .hm-price']) {
      expect(doc.querySelector(sel).textContent).not.toBe(en.querySelector(sel).textContent);
    }
  });
});
