import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// On a phone the hero and the final section show only the main elements: the
// headline, the lead, the email-me-the-link form, the price line and the text
// links. The product shot follows them on every screen size, from the DOM order
// alone; the proof chips stay in the HTML for search engines but are hidden on
// phones. Both price lines read as body text with the amounts in a heavier weight.
const LOCALES = ['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'];
const load = (file) => new JSDOM(readFileSync(file, 'utf8')).window.document;
const homeCss = readFileSync('website/assets/home.css', 'utf8');
const siteCss = readFileSync('website/assets/english-site.css', 'utf8');
const before = (a, b) => Boolean(a.compareDocumentPosition(b) & 4);

// Every `@media <query> { ... }` body in a stylesheet, found by brace counting.
function mediaBlocks(css, query) {
  const blocks = [];
  let at = css.indexOf(query);
  while (at !== -1) {
    const open = css.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}' && --depth === 0) break;
    }
    blocks.push(css.slice(open + 1, end));
    at = css.indexOf(query, end);
  }
  return blocks;
}
// The declarations of the first rule whose selector list contains `selector`.
function ruleFor(css, selector) {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(plain))) {
    if (m[1].split(',').some((s) => s.trim() === selector)) return m[2];
  }
  return null;
}
const PHONE = '@media (max-width:760px)';
const phoneCss = mediaBlocks(homeCss, PHONE).join('\n');

// The English homepage's phone order (badge, headline, lead, price card with the
// form, links, then the visual) is in homepage-clips-layout.test.js; the locale
// homepages are still built from the frozen snapshot of the previous layout.
describe('website/index.html final section on phones', () => {
  it('opens the final section with the form, then the price line', () => {
    const final = load('website/index.html').getElementById('download');
    const form = final.querySelector('#send-link-final');
    expect(before(final.querySelector('h2'), form)).toBe(true);
    expect(before(form, final.querySelector('.hm-price'))).toBe(true);
  });
});

describe.each(['website/i18n/frozen/index.html', ...LOCALES.map((l) => `website/${l}/index.html`)])('%s phone order', (file) => {
  const doc = load(file);

  it('puts the hero form, price line and text links before the product shot', () => {
    const hero = doc.querySelector('.hm-hero');
    const inner = hero.querySelector('.hm-hero-inner');
    const shot = hero.querySelector('.hm-hero-shot');
    const sequence = [
      inner.querySelector('.mv-eyebrow'),
      inner.querySelector('h1'),
      inner.querySelector('.hm-lead'),
      inner.querySelector('#send-link-hero'),
      inner.querySelector('.hm-price'),
      inner.querySelector('a.mv-text-link[href$="#platforms"]'),
      shot,
    ];
    sequence.forEach((el) => expect(el).not.toBeNull());
    sequence.slice(1).forEach((el, i) => expect(before(sequence[i], el)).toBe(true));
  });

  it('keeps the three proof chips in the static HTML', () => {
    expect(doc.querySelectorAll('.hm-hero .hm-facts li')).toHaveLength(3);
  });

  it('opens the final section with the form, then the price line', () => {
    const final = doc.getElementById('download');
    const form = final.querySelector('#send-link-final');
    expect(before(final.querySelector('h2'), form)).toBe(true);
    expect(before(form, final.querySelector('.hm-price'))).toBe(true);
  });
});

describe('home.css on phones', () => {
  it('has a phone block', () => {
    expect(phoneCss.length).toBeGreaterThan(0);
  });

  it('leaves the hero in DOM order: no reordering, no dissolved wrapper', () => {
    expect(phoneCss).not.toMatch(/\border\s*:/);
    expect(phoneCss).not.toMatch(/display\s*:\s*contents/);
  });

  it('hides the proof chips and the platform icons, in the hero and the final section', () => {
    for (const sel of ['.hm-facts', '.hm-platforms']) {
      expect(ruleFor(phoneCss, sel), sel).toMatch(/display\s*:\s*none/);
    }
  });
});

describe('homepage price lines', () => {
  it('reads as body text, not a caption', () => {
    const decl = ruleFor(homeCss, '.hm-price');
    expect(decl).toMatch(/font-size\s*:\s*1rem/);
    // .hm-proof dims its links; the price line must not inherit that.
    expect(ruleFor(homeCss, '.hm-price a')).toMatch(/opacity\s*:\s*1\b/);
  });

  it('sets the amounts in a heavier weight', () => {
    expect(ruleFor(homeCss, '.hm-price [data-mv-price]')).toMatch(/font-weight\s*:\s*7\d\d/);
  });
});

describe.each(['website/pricing.html', ...LOCALES.map((l) => `website/${l}/pricing.html`)])('%s standard price line', (file) => {
  const doc = load(file);

  it.each([['yearly', '{standardYearly}', '$39'], ['monthly', '{standardMonthly}', '$6']])('%s: a line of its own with the amount in a span', (panel, token, amount) => {
    const line = doc.querySelector(`#premium-plan [data-billing-panel="${panel}"] .mv-standard-price`);
    expect(line).not.toBeNull();
    expect(line.tagName).toBe('P');
    expect(line.classList.contains('mv-small')).toBe(false);
    // The localizer replaces the span's text only, so the span survives a price update.
    expect(line.hasAttribute('data-mv-price')).toBe(false);
    expect(line.querySelector(`span[data-mv-price="${token}"]`).textContent).toBe(amount);
  });
});

describe('English standard price line', () => {
  it('keeps the copy word for word', () => {
    const doc = load('website/pricing.html');
    expect(doc.querySelector('[data-billing-panel="yearly"] .mv-standard-price').textContent).toBe('Standard price after early access: $39/year');
    expect(doc.querySelector('[data-billing-panel="monthly"] .mv-standard-price').textContent).toBe('Standard price after early access: $6/month');
  });

  it.each(LOCALES)('%s translates it', (l) => {
    const en = load('website/pricing.html');
    const doc = load(`website/${l}/pricing.html`);
    for (const panel of ['yearly', 'monthly']) {
      const sel = `[data-billing-panel="${panel}"] .mv-standard-price`;
      expect(doc.querySelector(sel).textContent).not.toBe(en.querySelector(sel).textContent);
    }
  });
});

describe('english-site.css standard price', () => {
  it('reads as body text with a heavier amount', () => {
    const decl = ruleFor(siteCss, '.mv-plan .mv-standard-price');
    expect(decl).toMatch(/font-size\s*:\s*\.9\d*rem|font-size\s*:\s*1rem/);
    expect(decl).toMatch(/color\s*:\s*var\(--mv-ink\)/);
    expect(ruleFor(siteCss, '.mv-standard-price [data-mv-price]')).toMatch(/font-weight\s*:\s*7\d\d/);
  });
});
