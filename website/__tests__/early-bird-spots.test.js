import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// pricing-localize.js fills the early-bird discount percentages and the count
// of Early Bird spots taken (GET /api/billing/early-bird). Without an answer the
// static copy stays. Once every spot is taken the page stops offering the
// early-bird price: prices read the standard amounts and [data-mv-early] copy goes.
const script = readFileSync('website/pricing-localize.js', 'utf8');

const fmt = { usd: (a) => '$' + a / 100, eur: (a) => '€' + a / 100, gbp: (a) => '£' + (a % 100 ? (a / 100).toFixed(2) : a / 100) };
const AMOUNTS = { usd: [400, 2500, 600, 3900], eur: [400, 2500, 600, 3900], gbp: [350, 2100, 500, 3300] };
const pricing = (currency) => {
  const [m, y, sm, sy] = AMOUNTS[currency];
  return {
    currency,
    plans: [
      { interval: 'month', currency, amount: m, formattedAmount: fmt[currency](m) },
      { interval: 'year', currency, amount: y, formattedAmount: fmt[currency](y), monthlyEquivalent: fmt[currency](Math.round(y / 12)) },
    ],
    standard: { monthly: sm, yearly: sy, formattedMonthly: fmt[currency](sm), formattedYearly: fmt[currency](sy) },
  };
};

const PAGE = `
<p class="pill"><span>Premium from <span data-mv-price="{yearly}">$25</span>/yr</span><span class="spots" data-mv-spots="{taken} of {cap} spots taken" data-mv-spots-full="All {cap} spots are taken">Only 100 spots in total</span></p>
<p class="limit" data-mv-spots="Limited to the first {cap} subscribers: {taken} of {cap} spots taken." data-mv-spots-full="All {cap} Early Bird spots are taken. Premium is now at the standard price.">Limited to the first 100 subscribers.</p>
<p class="yearly"><span data-mv-price="{yearly}">$25</span>/year <span class="chip-y" data-mv-early data-mv-price="{earlyBirdSavingsPercent}% off">36% off</span></p>
<p class="monthly"><span data-mv-price="{monthly}">$4</span>/month <span class="chip-m" data-mv-early data-mv-price="{earlyBirdMonthlySavingsPercent}% off">33% off</span></p>
<p class="std-y" data-mv-early><span data-mv-price="{earlyBirdSavingsPercent}%">36%</span> below the standard price after early access: <span data-mv-price="{standardYearly}">$39</span>/year</p>
<p class="std-m" data-mv-early><span data-mv-price="{earlyBirdMonthlySavingsPercent}%">33%</span> below the standard price after early access: <span data-mv-price="{standardMonthly}">$6</span>/month</p>
<p class="equiv" data-mv-price="About {monthlyEquivalent}/month, billed yearly">About $2.08/month, billed yearly</p>
<p class="plan-copy" data-mv-early hidden>Early Bird line on a hidden plan</p>`;

const reply = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 503, json: async () => body });

async function load({ tags = ['en-US'], html = PAGE, price, spots } = {}) {
  const dom = new JSDOM(`<html lang="en"><body>${html}</body></html>`, { runScripts: 'outside-only' });
  Object.defineProperty(dom.window.navigator, 'languages', { value: tags });
  Object.defineProperty(dom.window.navigator, 'language', { value: tags[0] });
  const requested = [];
  dom.window.fetch = (url) => {
    requested.push(url);
    if (url.startsWith('/api/billing/early-bird')) return typeof spots === 'function' ? spots() : spots === undefined ? Promise.reject(new Error('offline')) : spots;
    if (url.startsWith('/api/billing/pricing')) return typeof price === 'function' ? price() : price === undefined ? Promise.reject(new Error('offline')) : price;
    return Promise.reject(new Error('unexpected ' + url));
  };
  dom.window.eval(script);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  const doc = dom.window.document;
  const $ = (sel) => doc.querySelector(sel);
  return { dom, doc, $, requested, text: (sel) => $(sel).textContent, shown: (sel) => $(sel).style.display !== 'none' };
}

describe('early-bird discount percentages', () => {
  it.each([
    ['usd', ['en-US'], '36% off', '33% off', '$39', '$6'],
    ['eur', ['de-DE'], '36% off', '33% off', '€39', '€6'],
    ['gbp', ['en-GB'], '36% off', '30% off', '£33', '£5'],
  ])('%s: computes both percentages from the localized amounts', async (currency, tags, yearly, monthly, sy, sm) => {
    const page = await load({ tags, price: reply(pricing(currency)) });
    expect(page.text('.chip-y')).toBe(yearly);
    expect(page.text('.chip-m')).toBe(monthly);
    expect(page.text('.std-y')).toBe(`${yearly.split(' ')[0]} below the standard price after early access: ${sy}/year`);
    expect(page.text('.std-m')).toBe(`${monthly.split(' ')[0]} below the standard price after early access: ${sm}/month`);
  });

  it('computes the GBP percentages offline from the built-in table', async () => {
    const page = await load({ tags: ['en-GB'] });
    expect(page.text('.chip-y')).toBe('36% off');
    expect(page.text('.chip-m')).toBe('30% off');
  });

  it('keeps the shown text when the monthly percentage cannot be computed', async () => {
    const body = pricing('usd');
    body.plans[0].amount = undefined;
    body.standard = { monthly: 'x' };
    const page = await load({ price: reply(body) });
    expect(page.text('.chip-m')).toBe('33% off');
    expect(page.doc.body.textContent).not.toMatch(/[{}]/);
  });
});

describe('early-bird spots line', () => {
  it('fills the count when the endpoint answers', async () => {
    const page = await load({ price: reply(pricing('usd')), spots: reply({ cap: 100, taken: 14, remaining: 86 }) });
    expect(page.text('.spots')).toBe('14 of 100 spots taken');
    expect(page.text('.limit')).toBe('Limited to the first 100 subscribers: 14 of 100 spots taken.');
    expect(page.requested).toContain('/api/billing/early-bird');
    expect(page.shown('.chip-y')).toBe(true);
    expect(page.text('.yearly')).toBe('$25/year 36% off');
  });

  it.each([
    ['the API is unreachable', undefined],
    ['the API errors', reply({ error: 'unavailable' }, false)],
    ['the answer is malformed', reply({ cap: 100, taken: 'many' })],
    ['the answer has no cap', reply({ taken: 3, remaining: 97 })],
  ])('keeps the static line when %s', async (_, spots) => {
    const page = await load({ price: reply(pricing('usd')), spots });
    expect(page.text('.spots')).toBe('Only 100 spots in total');
    expect(page.text('.limit')).toBe('Limited to the first 100 subscribers.');
    expect(page.text('.yearly')).toBe('$25/year 36% off');
    expect(page.doc.body.textContent).not.toMatch(/[{}]/);
  });

  it('asks for the count only on pages that show it', async () => {
    const page = await load({ html: '<span data-mv-price="{yearly}">$25</span>', price: reply(pricing('usd')), spots: reply({ cap: 100, taken: 1, remaining: 99 }) });
    expect(page.requested).not.toContain('/api/billing/early-bird');
  });
});

describe('when every early-bird spot is taken', () => {
  const full = { cap: 100, taken: 100, remaining: 0 };

  it('says so and stops advertising the early-bird price', async () => {
    const page = await load({ price: reply(pricing('usd')), spots: reply(full) });
    expect(page.text('.spots')).toBe('All 100 spots are taken');
    expect(page.text('.limit')).toBe('All 100 Early Bird spots are taken. Premium is now at the standard price.');
    // The current price is the standard price.
    expect(page.$('.pill [data-mv-price="{yearly}"]').textContent).toBe('$39');
    expect(page.$('.yearly [data-mv-price="{yearly}"]').textContent).toBe('$39');
    expect(page.$('.monthly [data-mv-price="{monthly}"]').textContent).toBe('$6');
    expect(page.text('.equiv')).toBe('About $3.25/month, billed yearly');
    // Discount chips and "below the standard price" lines go, hidden plan copy included.
    for (const sel of ['.chip-y', '.chip-m', '.std-y', '.std-m', '.plan-copy']) expect(page.shown(sel), sel).toBe(false);
    expect(page.doc.body.textContent).not.toMatch(/\$25|\$4\b/);
  });

  it('treats a count past the cap as full even without a remaining field', async () => {
    const page = await load({ price: reply(pricing('usd')), spots: reply({ cap: 100, taken: 104 }) });
    expect(page.text('.spots')).toBe('All 100 spots are taken');
    expect(page.$('.yearly [data-mv-price="{yearly}"]').textContent).toBe('$39');
  });

  it('uses the localized standard amounts', async () => {
    const page = await load({ tags: ['en-GB'], price: reply(pricing('gbp')), spots: reply(full) });
    expect(page.$('.yearly [data-mv-price="{yearly}"]').textContent).toBe('£33');
    expect(page.$('.monthly [data-mv-price="{monthly}"]').textContent).toBe('£5');
  });

  it('stays sold out when the price answer lands after the count', async () => {
    let release;
    const late = new Promise((r) => { release = r; });
    const page = await load({ price: () => late, spots: reply(full) });
    expect(page.$('.yearly [data-mv-price="{yearly}"]').textContent).toBe('$39');
    release({ ok: true, json: async () => pricing('usd') });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(page.$('.yearly [data-mv-price="{yearly}"]').textContent).toBe('$39');
    expect(page.$('.monthly [data-mv-price="{monthly}"]').textContent).toBe('$6');
    expect(page.shown('.chip-y')).toBe(false);
  });

  it('applies the sold-out prices when the count lands after the price answer', async () => {
    let release;
    const late = new Promise((r) => { release = r; });
    const page = await load({ tags: ['en-GB'], price: reply(pricing('gbp')), spots: () => late });
    expect(page.$('.yearly [data-mv-price="{yearly}"]').textContent).toBe('£21');
    release({ ok: true, json: async () => full });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(page.$('.yearly [data-mv-price="{yearly}"]').textContent).toBe('£33');
    expect(page.text('.spots')).toBe('All 100 spots are taken');
  });
});

describe('cache keys', () => {
  it('loads one new pricing-localize.js on every page', async () => {
    const { readdirSync } = await import('node:fs');
    const pages = readdirSync('website', { recursive: true })
      .filter((f) => f.endsWith('.html') && !f.includes('node_modules'))
      .map((f) => `website/${f}`)
      .concat('index.html');
    const keys = new Set();
    for (const f of pages) for (const m of readFileSync(f, 'utf8').matchAll(/pricing-localize\.js\?v=([\w-]+)/g)) keys.add(m[1]);
    expect([...keys]).toHaveLength(1);
    expect([...keys][0]).not.toBe('20261007-standard');
  });
});
