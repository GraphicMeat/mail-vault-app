import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The pages of the web-first purchase path: the pricing form, the /start ad
// landing and the welcome page Stripe returns to. Scripts run the way the
// browser loads them: english-site.js first, then the page's own script.
const root = resolve('website');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const scripts = (...files) => files.map((f) => read(f));
const sessions = [];
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64)';

function page(file, search = '', { fetch = vi.fn().mockRejectedValue(new Error('offline')), userAgent, extra = [], hostname = 'mailvaultapp.com' } = {}) {
  const dom = new JSDOM(read(file), { url: `https://${hostname}/${file}${search}`, runScripts: 'outside-only' });
  sessions.push(dom);
  const w = dom.window;
  if (userAgent) Object.defineProperty(w.navigator, 'userAgent', { configurable: true, value: userAgent });
  w.matchMedia = () => ({ matches: false });
  w.fetch = fetch;
  w.AbortSignal.timeout = () => undefined;
  w.navigator.sendBeacon = vi.fn();
  for (const code of scripts('assets/english-site.js', ...extra)) w.eval(code);
  return { w, doc: w.document, fetch };
}
afterEach(() => { sessions.splice(0).forEach((d) => d.window.close()); });
const tick = () => new Promise((r) => setTimeout(r, 0));
const json = (status, body) => vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
const SESSION = 'cs_test_a1B2c3D4e5F6g7H8i9J0';

describe('pricing page checkout form', () => {
  const form = (doc) => doc.querySelector('form[data-web-checkout]');

  it('posts the plan to the checkout endpoint without JavaScript', () => {
    const { doc } = page('pricing.html');
    const f = form(doc);
    expect(f.method).toBe('post');
    expect(f.getAttribute('action')).toBe('/api/billing/checkout-session');
    expect(f.querySelector('[name="planId"]').value).toBe('yearly');
    expect(f.querySelector('[name="email"]')).toBeNull();
    expect(f.querySelector('button[type="submit"]').textContent).toContain('Start free trial');
  });

  it('keeps the download path beside it', () => {
    const { doc } = page('pricing.html');
    expect(doc.querySelector('[data-premium-cta]').href).toContain('/get-started.html?plan=yearly');
  });

  it('follows the billing toggle and carries utm tags and the landing page', () => {
    const { w, doc } = page('pricing.html', '?utm_source=ads&utm_campaign=launch&other=x', { extra: ['assets/web-checkout.js'] });
    const f = form(doc);
    expect(f.querySelector('[name="utm_source"]').value).toBe('ads');
    expect(f.querySelector('[name="utm_campaign"]').value).toBe('launch');
    expect(f.querySelector('[name="other"]')).toBeNull();
    expect(f.querySelector('[name="landing"]').value).toBe('pricing');
    const monthly = doc.querySelector('input[value="monthly"]');
    monthly.checked = true;
    monthly.dispatchEvent(new w.Event('change'));
    expect(f.querySelector('[name="planId"]').value).toBe('monthly');
  });

  it('says so when Stripe could not be reached', () => {
    const { doc } = page('pricing.html', '?checkout=failed', { extra: ['assets/web-checkout.js'] });
    expect(doc.querySelector('[data-web-checkout-error]').hidden).toBe(false);
    expect(page('pricing.html', '', { extra: ['assets/web-checkout.js'] }).doc.querySelector('[data-web-checkout-error]').hidden).toBe(true);
  });

  it('no longer tells the buyer the trial can only start inside the app', () => {
    expect(read('pricing.html')).not.toContain('Your trial starts when you complete checkout in the app.');
  });
});

describe('/start ad landing', () => {
  const html = () => read('start.html');
  it('is a noindex page outside the sitemap and the translated set', () => {
    expect(html()).toMatch(/<meta name="robots" content="noindex/);
    expect(html()).not.toMatch(/rel="canonical"/);
    expect(html()).not.toMatch(/hreflang=/);
    expect(read('sitemap.xml')).not.toContain('/start');
  });
  it('carries the Meatlytics tag exactly like its siblings', () => {
    const tag = (h) => h.match(/<script defer src="\/gm\.js\?[^"]*" data-site="mailvault" data-tag="[^"]+">/)?.[0];
    expect(tag(html())).toBeTruthy();
    expect(tag(html())).toBe(tag(read('billing-success.html')));
  });
  it('starts checkout with no email field and keeps the free download whole', () => {
    const { doc } = page('start.html', '?utm_source=meta&utm_medium=cpc', { extra: ['assets/web-checkout.js'] });
    const f = doc.querySelector('form[data-web-checkout]');
    expect(f.getAttribute('action')).toBe('/api/billing/checkout-session');
    expect(f.querySelector('[name="email"]')).toBeNull();
    expect(f.querySelector('[name="utm_source"]').value).toBe('meta');
    expect(f.querySelector('[name="landing"]').value).toBe('start');
    expect(doc.querySelectorAll('h1')).toHaveLength(1);
    expect(doc.querySelector('a[href^="/get-started.html?plan=free"]')).not.toBeNull();
  });
  it('quotes the price through the shared pricing script', () => {
    const { doc } = page('start.html');
    expect(doc.querySelector('[data-mv-price="{yearly}"]')).not.toBeNull();
    expect(read('start.html')).toContain('/pricing-localize.js');
  });
});

describe('welcome page', () => {
  const welcome = (search, opts = {}) => page('billing-success.html', search, { extra: ['assets/welcome.js'], ...opts });
  const visible = (doc, sel) => [...doc.querySelectorAll(sel)].filter((el) => !el.hidden);

  it('is noindex and shows the download for the visitor’s own OS', () => {
    expect(read('billing-success.html')).toMatch(/<meta name="robots" content="noindex/);
    for (const [ua, platform] of [[MAC, 'mac'], [WIN, 'windows'], [LINUX, 'linux']]) {
      const { doc } = welcome(`?session_id=${SESSION}`, { userAgent: ua });
      expect(visible(doc, '.mv-actions [data-hero-platform]').map((a) => a.dataset.heroPlatform)).toEqual([platform]);
    }
  });

  it('downloads open in a new tab so the activation button stays on screen', () => {
    const { doc } = welcome(`?session_id=${SESSION}`, { userAgent: MAC });
    for (const a of doc.querySelectorAll('.mv-actions [data-download]')) expect(a.target).toBe('_blank');
  });

  it('after a web checkout offers activation and the email fallback', () => {
    const { doc } = welcome(`?session_id=${SESSION}`);
    expect(doc.querySelector('[data-welcome-activate]').hidden).toBe(false);
    expect(visible(doc, '[data-welcome-app]')).toHaveLength(0);
    expect(doc.body.textContent).toContain('sign in with the email you paid with');
  });

  it('after the in-app checkout (no session id) only asks them to go back to the app', () => {
    const { doc } = welcome('');
    expect(doc.querySelector('[data-welcome-activate]').hidden).toBe(true);
    expect(visible(doc, '[data-welcome-web]')).toHaveLength(0);
    expect(visible(doc, '[data-welcome-app]').length).toBeGreaterThan(0);
  });

  it('ignores a session id that is not one', () => {
    const { doc } = welcome('?session_id=%3Cimg%20src%3Dx%3E');
    expect(doc.querySelector('[data-welcome-activate]').hidden).toBe(true);
  });

  it('trades the session id for a token only when the button is pressed, then opens the deep link', async () => {
    const fetch = json(200, { token: 't', expiresAt: 1, deepLink: 'mailvault://activate?token=abc' });
    const { w, doc } = welcome(`?session_id=${SESSION}`, { fetch });
    // english-site.js makes its own calls on load (stars, hearts); only the token call matters here.
    const tokenCalls = () => fetch.mock.calls.filter(([u]) => u === '/api/billing/activation-token');
    expect(tokenCalls()).toHaveLength(0);
    const clicked = [];
    w.HTMLAnchorElement.prototype.click = function () { clicked.push(this.href); };
    doc.querySelector('[data-welcome-open]').click();
    await tick();
    expect(tokenCalls()).toHaveLength(1);
    const [url, init] = tokenCalls()[0];
    expect(url).toBe('/api/billing/activation-token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ sessionId: SESSION });
    expect(clicked).toEqual(['mailvault://activate?token=abc']);
    expect(doc.querySelector('[data-welcome-msg="opened"]').hidden).toBe(false);
  });

  it.each([404, 409, 410])('explains an unusable link on a %s', async (status) => {
    const { doc } = welcome(`?session_id=${SESSION}`, { fetch: json(status, { error: 'x' }) });
    doc.querySelector('[data-welcome-open]').click();
    await tick();
    expect(doc.querySelector('[data-welcome-msg="expired"]').hidden).toBe(false);
  });

  it('says it failed when the server cannot be reached', async () => {
    const { doc } = welcome(`?session_id=${SESSION}`);
    doc.querySelector('[data-welcome-open]').click();
    await tick();
    expect(doc.querySelector('[data-welcome-msg="failed"]').hidden).toBe(false);
  });

  it('never puts the session id or token in analytics', () => {
    expect(read('assets/welcome.js')).not.toMatch(/gm\(|acquisitionEvent\(/);
  });
});

describe('site rules for the new pages', () => {
  it('keeps /start out of translation but not out of the checks', () => {
    expect(read('i18n/i18n.mjs')).toMatch(/'start\.html'/);
    expect(existsSync(resolve(root, 'de/start.html'))).toBe(false);
  });
});
