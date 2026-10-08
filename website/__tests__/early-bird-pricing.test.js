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
// Early Bird & Family Pricing is capped at the first 100 subscribers. The cap is
// stated as a fixed number; pricing-localize.js may add the live count of spots
// taken from /api/billing/early-bird, but the page never counts down spots left.
const SCARCITY = /\b\d+ (spots |places )?left\b|selling fast|hurry|countdown/i;

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

  it('states the 100-subscriber limit in the band and on the paid plan badge', () => {
    const limit = doc.querySelector('.mv-early-band > strong + span');
    expect(limit).not.toBeNull();
    expect(limit.textContent).toMatch(/100/);
    const badge = [...doc.querySelectorAll('#premium-plan .mv-pixel-grill p > span')];
    expect(badge).toHaveLength(2);
    expect(badge[1].textContent).toMatch(/100/);
    for (const el of [limit, ...badge]) expect(el.textContent).not.toMatch(SCARCITY);
    // Translated, not the English fallback.
    if (file !== 'website/pricing.html') {
      expect(limit.textContent).not.toBe('Limited to the first 100 subscribers.');
      expect(badge[1].textContent).not.toBe('Limited to the first 100 subscribers');
    }
  });

  it('fills the band with the live count of spots taken, translated, and a sold-out line', () => {
    const limit = doc.querySelector('.mv-early-band > strong + span');
    for (const attr of ['data-mv-spots', 'data-mv-spots-full']) {
      const tpl = limit.getAttribute(attr);
      expect(tpl, attr).toMatch(/\{cap\}/);
      expect(tpl, attr).not.toMatch(SCARCITY);
      expect(tpl, attr).not.toMatch(FORBIDDEN);
    }
    expect(limit.getAttribute('data-mv-spots')).toMatch(/\{taken\}/);
    if (file !== 'website/pricing.html') {
      expect(limit.getAttribute('data-mv-spots')).not.toBe('{taken} of {cap} Early Bird spots taken.');
      expect(limit.getAttribute('data-mv-spots-full')).not.toBe('All {cap} Early Bird spots are taken. Premium is now at the standard price.');
    }
  });

  it('shows the early-bird discount off the standard price beside each billing period', () => {
    for (const [panel, token, pct] of [['yearly', 'earlyBirdSavingsPercent', '36'], ['monthly', 'earlyBirdMonthlySavingsPercent', '33']]) {
      const root = doc.querySelector(`#premium-plan [data-billing-panel="${panel}"]`);
      const chip = root.querySelector('.mv-price > .mv-tag');
      expect(chip.getAttribute('data-mv-price')).toContain(`{${token}}`);
      expect(chip.textContent).toContain(pct);
      const line = root.querySelector('.mv-standard-price');
      expect(line.querySelector(`[data-mv-price*="{${token}}"]`).textContent).toContain(pct);
      for (const el of [chip, line]) expect(el.hasAttribute('data-mv-early')).toBe(true);
      // Translated chip, never the English "off" on a localized page.
      if (file !== 'website/pricing.html') expect(chip.getAttribute('data-mv-price')).not.toBe(`{${token}}% off`);
    }
  });

  it('drops the early-bird promise, badge and discount once every spot is taken', () => {
    expect(doc.querySelector('#premium-plan .mv-pixel-grill').hasAttribute('data-mv-early')).toBe(true);
    expect(doc.querySelector('.mv-early-band li').hasAttribute('data-mv-early')).toBe(true);
    // Devices and trial stay true at the standard price.
    expect([...doc.querySelectorAll('.mv-early-band li')].slice(1).some((li) => li.hasAttribute('data-mv-early'))).toBe(false);
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
    expect(doc.querySelector('.mv-early-band > strong + span').textContent).toBe('Limited to the first 100 subscribers.');
    expect(items).toEqual([
      'MailVault is in early access. Lock in discounted pricing today: ' + PROMISE + '.',
      'Up to 5 devices per subscription',
      '14-day free trial on your first yearly subscription',
    ]);
  });

  it('reads the standard price as a plain statement', () => {
    // The line holds the sentence; only its amount is a price token, so the amount can be set in bold.
    expect(doc.querySelector('[data-billing-panel="yearly"] [data-mv-price*="{standardYearly}"]').closest('p').textContent).toBe('36% below the standard price after early access: $39/year');
    expect(doc.querySelector('[data-billing-panel="monthly"] [data-mv-price*="{standardMonthly}"]').closest('p').textContent).toBe('33% below the standard price after early access: $6/month');
    expect(doc.querySelector('[data-billing-panel="yearly"] .mv-price').textContent.trim()).toBe('$25/ year36% off');
    expect(doc.querySelector('[data-billing-panel="monthly"] .mv-price').textContent.trim()).toBe('$4/ month33% off');
    expect(doc.querySelector('.mv-early-band > strong + span').dataset.mvSpots).toBe('{taken} of {cap} Early Bird spots taken.');
    expect(doc.querySelector('.mv-early-band > strong + span').dataset.mvSpotsFull).toBe('All {cap} Early Bird spots are taken. Premium is now at the standard price.');
    expect(doc.querySelector('#premium-plan .mv-pixel-grill').textContent).toContain('Early Bird & Family Pricing');
    expect([...doc.querySelectorAll('#premium-plan .mv-pixel-grill p > span')].map((el) => el.textContent)).toEqual(['While MailVault is in early access', 'Limited to the first 100 subscribers']);
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

  it('drops the early-bird lines once every spot is taken', () => {
    for (const el of doc.querySelectorAll('.mv-early-pricing')) expect(el.hasAttribute('data-mv-early')).toBe(true);
  });

  it('states the 100-subscriber limit on both plans', () => {
    for (const plan of ['yearly', 'monthly']) {
      const line = doc.querySelector(`.mv-early-pricing[data-plan-copy="${plan}"]`).textContent;
      expect(line).toMatch(/100/);
      expect(line).not.toMatch(SCARCITY);
      if (file !== 'website/get-started.html') expect(line).not.toMatch(/limited to the first 100 subscribers/);
    }
  });
});

describe('English setup copy', () => {
  it('names the early-bird pricing and the standard price per plan', () => {
    const doc = load('website/get-started.html');
    expect(doc.querySelector('.mv-early-pricing[data-plan-copy="yearly"]').textContent).toBe('Early Bird & Family Pricing is limited to the first 100 subscribers, with up to 5 devices each. Standard price after early access: $39/year.');
    expect(doc.querySelector('.mv-early-pricing[data-plan-copy="monthly"]').textContent).toBe('Early Bird & Family Pricing is limited to the first 100 subscribers, with up to 5 devices each. Standard price after early access: $6/month.');
  });
});

describe('homepage price lines', () => {
  it.each(['website/index.html', 'index.html', ...LOCALES.map((l) => `website/${l}/index.html`)])('%s adds no end date, "for life" or em dash', (file) => {
    const doc = load(file);
    for (const line of doc.querySelectorAll('.hm-price, .hm-badge, .hm-offer')) expect(line.textContent).not.toMatch(FORBIDDEN);
  });
});
