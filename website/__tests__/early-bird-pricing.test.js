import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// Early access is open-ended. Today's price is Early Bird & Family Pricing; the
// standard price after early access is stated plainly beside it. Nobody has paid
// the standard price, so it is never shown as a struck-out "was" price, and no
// end date, "limited time" or "for life" claim appears with it.
const LOCALES = ['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'];
const PROMISE = 'your rate stays the same as long as your subscription is active, even after prices increase';
const load = (file) => new JSDOM(readFileSync(file, 'utf8')).window.document;
const pages = (name) => [`website/${name}`, ...LOCALES.map((l) => `website/${l}/${name}`)];
const FORBIDDEN = /limited time|lifetime|for life|for now|—/i;

const newCopy = (doc) => [
  ...doc.querySelectorAll('.mv-early-band, #premium-plan .mv-pixel-grill, [data-mv-price*="{standard"], #early-access-price, .mv-early-pricing'),
];

describe.each(pages('pricing.html'))('%s', (file) => {
  const doc = load(file);

  it('states the three early-bird promises in one band above the plans', () => {
    const band = doc.querySelector('.mv-early-band');
    expect(band).not.toBeNull();
    expect(band.compareDocumentPosition(doc.getElementById('plans')) & 4).toBeTruthy();
    expect(band.querySelectorAll('li')).toHaveLength(3);
  });

  it('badges the paid plan and prints the standard price under each billing period', () => {
    expect(doc.querySelector('#premium-plan .mv-pixel-grill')).not.toBeNull();
    const yearly = doc.querySelector('#premium-plan [data-billing-panel="yearly"] [data-mv-price*="{standardYearly}"]');
    const monthly = doc.querySelector('#premium-plan [data-billing-panel="monthly"] [data-mv-price*="{standardMonthly}"]');
    expect(yearly.textContent).toContain('$39');
    expect(monthly.textContent).toContain('$6');
    expect(yearly.getAttribute('data-mv-price')).not.toContain('$');
    // Below the early-bird price it qualifies, in each panel.
    for (const [line, panel] of [[yearly, 'yearly'], [monthly, 'monthly']]) {
      const price = doc.querySelector(`#premium-plan [data-billing-panel="${panel}"] .mv-price`);
      expect(price.compareDocumentPosition(line) & 4).toBeTruthy();
    }
  });

  it('never strikes through a price', () => {
    expect(doc.querySelector('#plans s, #plans del, #plans strike, .mv-early-band s, .mv-early-band del')).toBeNull();
    expect(readFileSync(file, 'utf8')).not.toMatch(/line-through/);
  });

  it('answers what happens to the price when early access ends', () => {
    const answer = doc.getElementById('early-access-price');
    expect(answer.tagName).toBe('DETAILS');
    expect(answer.closest('.mv-faq')).not.toBeNull();
    expect(answer.querySelector('[data-mv-price="{standardMonthly}"]').textContent).toBe('$6');
    expect(answer.querySelector('[data-mv-price="{standardYearly}"]').textContent).toBe('$39');
  });

  it('keeps structured data on the prices charged today', () => {
    const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent));
    const product = ld.find((d) => d['@type'] === 'Product');
    expect(product.offers.map((o) => [o.price, o.priceCurrency])).toEqual([['25', 'USD'], ['4', 'USD']]);
    expect(JSON.stringify(ld)).not.toMatch(/\b39\b|standard|early access/i);
    // The page has no FAQPage markup, so the new answer has nothing to sync.
    expect(ld.some((d) => d['@type'] === 'FAQPage')).toBe(false);
  });

  it('adds no end date, "for life" or em dash to the new copy', () => {
    for (const el of newCopy(doc)) {
      expect(el.textContent, el.outerHTML.slice(0, 80)).not.toMatch(FORBIDDEN);
      expect(el.getAttribute('data-mv-price') || '').not.toMatch(FORBIDDEN);
    }
  });
});

describe('English pricing copy', () => {
  const doc = load('website/pricing.html');

  it('uses the app’s promise word for word', () => {
    const items = [...doc.querySelectorAll('.mv-early-band li')].map((li) => li.textContent.trim());
    expect(doc.querySelector('.mv-early-band').textContent).toContain('Early Bird & Family Pricing');
    expect(items).toEqual([
      'MailVault is in early access. Lock in discounted pricing today: ' + PROMISE + '.',
      'Up to 5 devices per subscription',
      '14-day free trial on your first yearly subscription',
    ]);
  });

  it('reads the standard price as a plain statement', () => {
    // The line holds the sentence; only its amount is a price token, so the amount can be set in bold.
    expect(doc.querySelector('[data-billing-panel="yearly"] [data-mv-price*="{standardYearly}"]').closest('p').textContent).toBe('Standard price after early access: $39/year');
    expect(doc.querySelector('[data-billing-panel="monthly"] [data-mv-price*="{standardMonthly}"]').closest('p').textContent).toBe('Standard price after early access: $6/month');
    expect(doc.querySelector('#premium-plan .mv-pixel-grill').textContent).toContain('Early Bird & Family Pricing');
  });

  it('answers the early-access question with the promise', () => {
    const answer = doc.getElementById('early-access-price');
    expect(answer.querySelector('summary').textContent).toBe('What happens to my price when early access ends?');
    expect(answer.querySelector('p').textContent).toContain(PROMISE);
    expect(answer.querySelector('p').textContent).toContain('$6/month or $39/year');
  });
});

describe.each(pages('get-started.html'))('%s', (file) => {
  const doc = load(file);

  it('shows each plan its own standard price after early access', () => {
    const yearly = doc.querySelector('.mv-early-pricing[data-plan-copy="yearly"]');
    const monthly = doc.querySelector('.mv-early-pricing[data-plan-copy="monthly"]');
    expect(yearly.querySelector('[data-mv-price="{standardYearly}"]').textContent).toBe('$39');
    expect(monthly.querySelector('[data-mv-price="{standardMonthly}"]').textContent).toBe('$6');
    expect(yearly.querySelector('[data-mv-price*="{standardMonthly}"]')).toBeNull();
    expect(monthly.querySelector('[data-mv-price*="{standardYearly}"]')).toBeNull();
    for (const el of newCopy(doc)) expect(el.textContent).not.toMatch(FORBIDDEN);
  });
});

describe('English setup copy', () => {
  it('names the early-bird pricing and the standard price per plan', () => {
    const doc = load('website/get-started.html');
    expect(doc.querySelector('.mv-early-pricing[data-plan-copy="yearly"]').textContent).toBe('Early Bird & Family Pricing, up to 5 devices. Standard price after early access: $39/year.');
    expect(doc.querySelector('.mv-early-pricing[data-plan-copy="monthly"]').textContent).toBe('Early Bird & Family Pricing, up to 5 devices. Standard price after early access: $6/month.');
  });
});

describe('homepage price lines', () => {
  it.each(['website/index.html', 'index.html', ...LOCALES.map((l) => `website/${l}/index.html`)])('%s adds no end date, "for life" or em dash', (file) => {
    const doc = load(file);
    for (const line of doc.querySelectorAll('.hm-price')) expect(line.textContent).not.toMatch(FORBIDDEN);
  });
});
