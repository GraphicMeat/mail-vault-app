import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// pricing-localize.js renders the standard price after early access next to the
// early-bird price. The API sends it as `standard`; an older API that does not
// must never leave a raw token or a price in another currency on the page.
const script = readFileSync('website/pricing-localize.js', 'utf8');
const TEMPLATE = '{yearly} / {standardYearly} / {standardMonthly} / {earlyBirdSavingsPercent}';
const FALLBACK = '$25 / $39 / $6 / 36';

const plans = (currency, monthly, yearly, fmt) => [
  { interval: 'month', currency, amount: monthly, formattedAmount: fmt(monthly) },
  { interval: 'year', currency, amount: yearly, formattedAmount: fmt(yearly) },
];
const fmt = { usd: (a) => '$' + a / 100, eur: (a) => '€' + a / 100, gbp: (a) => '£' + (a % 100 ? (a / 100).toFixed(2) : a / 100) };

async function render({ tags = ['en-US'], response, fail = false, template = TEMPLATE } = {}) {
  const dom = new JSDOM(`<html lang="en"><span data-mv-price="${template}">${FALLBACK}</span></html>`, { runScripts: 'outside-only' });
  Object.defineProperty(dom.window.navigator, 'languages', { value: tags });
  Object.defineProperty(dom.window.navigator, 'language', { value: tags[0] });
  dom.window.fetch = () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true, json: async () => response }));
  dom.window.eval(script);
  await new Promise((r) => setTimeout(r, 0));
  const text = dom.window.document.body.textContent;
  dom.window.close();
  return text;
}

describe('standard price tokens', () => {
  it('renders the standard price the API sends', async () => {
    // Values unlike the built-in table prove the API answer wins.
    const response = { currency: 'usd', plans: plans('usd', 400, 2500, fmt.usd), standard: { monthly: 700, yearly: 4200, formattedMonthly: '$7', formattedYearly: '$42' } };
    expect(await render({ response })).toBe('$25 / $42 / $7 / 40');
  });

  it.each([
    ['gbp', ['en-GB'], [350, 2100], [500, 3300], '£21 / £33 / £5 / 36'],
    ['eur', ['lt-LT'], [400, 2500], [600, 3900], '€25 / €39 / €6 / 36'],
    ['usd', ['en-US'], [400, 2500], [600, 3900], '$25 / $39 / $6 / 36'],
  ])('renders %s from the API with the new fields', async (currency, tags, [m, y], [sm, sy], expected) => {
    const response = { currency, plans: plans(currency, m, y, fmt[currency]), standard: { monthly: sm, yearly: sy, formattedMonthly: fmt[currency](sm), formattedYearly: fmt[currency](sy) } };
    expect(await render({ tags, response })).toBe(expected);
  });

  it.each([
    ['gbp', ['lt-LT'], [350, 2100], '£21 / £33 / £5 / 36'],
    ['eur', ['en-GB'], [400, 2500], '€25 / €39 / €6 / 36'],
    ['usd', ['en-GB'], [400, 2500], '$25 / $39 / $6 / 36'],
  ])('falls back to the %s standard price when an older API omits it', async (currency, tags, [m, y], expected) => {
    // The browser guessed another currency first; the API's currency must win for every token.
    const response = { currency, plans: plans(currency, m, y, fmt[currency]) };
    expect(await render({ tags, response })).toBe(expected);
  });

  it('ignores a malformed standard block instead of printing it', async () => {
    const response = { currency: 'eur', plans: plans('eur', 400, 2500, fmt.eur), standard: { monthly: 'x', formattedYearly: null } };
    expect(await render({ tags: ['de-DE'], response })).toBe('€25 / €39 / €6 / 36');
  });

  it('never prints a raw token when the API gives no amounts', async () => {
    const response = { currency: 'eur', plans: [{ interval: 'month', formattedAmount: '€4' }, { interval: 'year', formattedAmount: '€25' }] };
    for (const template of [TEMPLATE, '{standardYearly}', '{earlyBirdSavingsPercent}%']) {
      const text = await render({ tags: ['en-GB'], response, template });
      expect(text).not.toMatch(/[{}]/);
      expect(text).not.toMatch(/£/);
    }
  });

  it('shows the USD standard price offline', async () => {
    expect(await render({ fail: true })).toBe(FALLBACK);
    expect(await render({ fail: true, tags: ['en-GB'] })).toBe('£21 / £33 / £5 / 36');
  });
});
