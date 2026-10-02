import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The API is CommonJS and cannot boot here (meatlytics pulls in better-sqlite3),
// so the email-me-the-link pieces live in pure modules tested on their own.
const require = createRequire(import.meta.url);
const token = require('../api/send-link-token.js');
const mail = require('../api/send-link-email.js');
const { createSendLink, recipientHash, DAY_MS } = require('../api/send-link.js');

const KEY = token.deriveKey('test-partner-key');
const LANGS = Object.keys(mail.LOCALES);

describe('send-link email', () => {
  it.each(LANGS)('%s has a subject, a text part and an HTML part', (lang) => {
    const links = mail.linksFor(lang, token.seal(KEY, 'reader@example.com'));
    const { subject, text, html } = mail.buildSendLinkEmail(lang, links);
    expect(subject.length).toBeGreaterThan(5);
    for (const url of Object.values(links)) {
      expect(text).toContain(url);
      expect(html).toContain(url.replace(/&/g, '&amp;'));
    }
    expect(html).toMatch(/<meta name="color-scheme" content="light dark">/);
    expect(html).toMatch(/<meta name="supported-color-schemes" content="light dark">/);
  });

  it.each(LANGS)('%s loads nothing remote and tracks nothing', (lang) => {
    const { html } = mail.buildSendLinkEmail(lang, mail.linksFor(lang, token.seal(KEY, 'reader@example.com')));
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain('http://');
    expect(html).not.toMatch(/\bsrc=/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/<link\b/i);
    // Every link points straight at the site, never through a redirector.
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) expect(href).toMatch(/^https:\/\/mailvaultapp\.com\//);
  });

  it.each(LANGS)('%s keeps the address out of every link', (lang) => {
    const links = mail.linksFor(lang, token.seal(KEY, 'reader@example.com'));
    for (const url of Object.values(links)) expect(url).not.toContain('@');
    expect(links.subscribeUrl).not.toContain('reader');
  });

  it('localizes every language and falls back to English', () => {
    const subjects = LANGS.map((l) => mail.buildSendLinkEmail(l, mail.linksFor(l, 'x')).subject);
    expect(new Set(subjects).size).toBe(LANGS.length);
    const en = mail.buildSendLinkEmail('en', mail.linksFor('en', 'x'));
    expect(mail.buildSendLinkEmail('xx', mail.linksFor('xx', 'x'))).toEqual(en);
    expect(mail.buildSendLinkEmail(undefined, mail.linksFor(undefined, 'x'))).toEqual(en);
    expect(mail.resolveLocale('pt-BR')).toBe('pt-br');
    expect(mail.resolveLocale('zh-Hans')).toBe('zh');
  });

  it('sends a desktop visitor to the homepage download section in their language', () => {
    expect(mail.linksFor('en', 't').downloadUrl).toBe('https://mailvaultapp.com/?utm_source=email_link&utm_medium=email&utm_campaign=mobile_handoff#download');
    expect(mail.linksFor('de', 't').downloadUrl).toBe('https://mailvaultapp.com/de/?utm_source=email_link&utm_medium=email&utm_campaign=mobile_handoff#download');
    expect(mail.linksFor('zh', 't').demoUrl).toContain('/demo/?lang=zh-Hans&');
    expect(mail.linksFor('fr', 'abc').subscribeUrl).toBe('https://mailvaultapp.com/api/send-link/confirm?t=abc&lang=fr');
  });

  it('escapes everything it interpolates', () => {
    const { html } = mail.buildSendLinkEmail('en', { downloadUrl: 'https://mailvaultapp.com/?a=1&b="><script>', demoUrl: 'https://mailvaultapp.com/demo/', subscribeUrl: 'https://mailvaultapp.com/x' });
    expect(html).not.toContain('"><script>');
    expect(html).toContain('a=1&amp;b=&quot;&gt;&lt;script&gt;');
  });

  it('uses no em dash in any language', () => {
    expect(JSON.stringify(mail.COPY)).not.toContain('\u2014');
  });

  it('renders a confirm page that only subscribes on POST', () => {
    const page = mail.renderConfirmPage('de', 'tok"en<');
    expect(page).toContain('<form method="post" action="/api/send-link/subscribe">');
    expect(page).toContain('name="t" value="tok&quot;en&lt;"');
    expect(page).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(page).toContain('lang="de"');
    expect(page).not.toMatch(/<img|http:\/\//);
  });
});

describe('send-link token', () => {
  it('round-trips an address', () => {
    expect(token.open(KEY, token.seal(KEY, 'Reader@Example.com'))).toEqual({ email: 'Reader@Example.com' });
  });

  it('is opaque and URL-safe', () => {
    const t = token.seal(KEY, 'reader@example.com');
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t).not.toContain('reader');
    expect(Buffer.from(t, 'base64url').toString('latin1')).not.toContain('reader');
  });

  it('expires after 30 days', () => {
    const now = Date.UTC(2026, 9, 2);
    const t = token.seal(KEY, 'reader@example.com', now);
    expect(token.open(KEY, t, now + 29 * DAY_MS)).toEqual({ email: 'reader@example.com' });
    expect(token.open(KEY, t, now + 31 * DAY_MS)).toEqual({ error: 'expired' });
  });

  it('rejects a tampered, foreign or malformed token', () => {
    const t = token.seal(KEY, 'reader@example.com');
    const raw = Buffer.from(t, 'base64url');
    for (const i of [0, 13, 30, raw.length - 1]) {
      const bad = Buffer.from(raw);
      bad[i] ^= 1;
      expect(token.open(KEY, bad.toString('base64url'))).toEqual({ error: 'invalid' });
    }
    expect(token.open(token.deriveKey('another-key'), t)).toEqual({ error: 'invalid' });
    for (const junk of ['', 'abc', 'not base64!', 'a'.repeat(2000), null, 42]) expect(token.open(KEY, junk)).toEqual({ error: 'invalid' });
    expect(token.open(null, t)).toEqual({ error: 'invalid' });
  });

  it('needs the partner key', () => {
    expect(token.deriveKey('')).toBeNull();
    expect(() => token.seal(null, 'reader@example.com')).toThrow();
  });
});

describe('send-link requests', () => {
  const setup = (over = {}) => {
    let now = Date.UTC(2026, 9, 2, 12);
    const deps = {
      send: vi.fn().mockResolvedValue({ ok: true }),
      bumpMetric: vi.fn(),
      logError: vi.fn(),
      configured: () => true,
      key: KEY,
      now: () => now,
      ...over,
    };
    return { ...deps, service: createSendLink(deps), advance: (ms) => { now += ms; } };
  };

  it('sends one mail and counts it', async () => {
    const { service, send, bumpMetric } = setup();
    expect(await service.request({ email: ' reader@example.com ', lang: 'de', website: '' })).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
    const [endpoint, payload] = send.mock.calls[0];
    expect(endpoint).toBe('send');
    expect(Object.keys(payload).sort()).toEqual(['fromName', 'html', 'subject', 'text', 'to']);
    expect(payload.to).toBe('reader@example.com');
    expect(payload.subject).toBe(mail.COPY.de.subject);
    expect(bumpMetric).toHaveBeenCalledExactlyOnceWith('send_link_sent');
  });

  it('answers a filled honeypot as sent without sending', async () => {
    const { service, send, bumpMetric } = setup();
    expect(await service.request({ email: 'reader@example.com', website: 'https://spam.example' })).toBe('sent');
    expect(send).not.toHaveBeenCalled();
    expect(bumpMetric).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'nope', 'a@b', 'two words@example.com', `${'a'.repeat(250)}@example.com`, { $gt: '' }])('rejects %s', async (email) => {
    const { service, send } = setup();
    expect(await service.request({ email })).toBe('invalid');
    expect(send).not.toHaveBeenCalled();
  });

  it('mails one address at most once a day, whatever its case', async () => {
    const { service, send, advance } = setup();
    expect(await service.request({ email: 'reader@example.com' })).toBe('sent');
    expect(await service.request({ email: 'READER@example.com' })).toBe('limited');
    expect(await service.request({ email: 'other@example.com' })).toBe('sent');
    advance(DAY_MS + 1);
    expect(await service.request({ email: 'reader@example.com' })).toBe('sent');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('holds the slot while a send is in flight', async () => {
    let finish;
    const { service, send } = setup({ send: vi.fn(() => new Promise((r) => { finish = r; })) });
    const first = service.request({ email: 'reader@example.com' });
    expect(await service.request({ email: 'reader@example.com' })).toBe('limited');
    finish({ ok: true });
    expect(await first).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('caps sends per UTC day', async () => {
    const { service, advance } = setup({ dailyCap: 2 });
    expect(await service.request({ email: 'a@example.com' })).toBe('sent');
    expect(await service.request({ email: 'b@example.com' })).toBe('sent');
    expect(await service.request({ email: 'c@example.com' })).toBe('limited');
    advance(DAY_MS);
    expect(await service.request({ email: 'c@example.com' })).toBe('sent');
  });

  it('gives the slots back when the partner fails, and never logs the address', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('send failed')).mockResolvedValue({ ok: true });
    const { service, bumpMetric, logError } = setup({ send, dailyCap: 1 });
    expect(await service.request({ email: 'reader@example.com' })).toBe('failed');
    expect(bumpMetric).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
    expect(logError.mock.calls[0][0]).not.toContain('reader');
    expect(await service.request({ email: 'reader@example.com' })).toBe('sent');
  });

  it('reports an unconfigured partner without using a slot', async () => {
    let configured = false;
    const { service, send } = setup({ configured: () => configured });
    expect(await service.request({ email: 'reader@example.com' })).toBe('unavailable');
    expect(send).not.toHaveBeenCalled();
    configured = true;
    expect(await service.request({ email: 'reader@example.com' })).toBe('sent');
    const noKey = setup({ key: null });
    expect(await noKey.service.request({ email: 'reader@example.com' })).toBe('unavailable');
  });

  it('keys the limit on a hash, not the address', () => {
    expect(recipientHash('Reader@Example.com ')).toBe(recipientHash('reader@example.com'));
    expect(recipientHash('reader@example.com')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('send-link API wiring', () => {
  const server = readFileSync(resolve('website/api/server.js'), 'utf8');

  it('counts sends and confirmations server-side only', () => {
    const publicMetrics = server.match(/const PUBLIC_METRICS = new Set\(\[([^\]]*)\]\)/)[1];
    expect(publicMetrics).not.toContain('send_link');
    expect(server).toMatch(/const ALL_METRICS = new Set\(\[[^\]]*'send_link_sent', 'send_link_subscribed'\]\)/);
  });

  it('shares one subscribe path between the newsletter and the mail link', () => {
    expect(server.match(/INSERT INTO subscribers/g)).toHaveLength(1);
    expect(server).toMatch(/app\.post\('\/api\/subscribe'[\s\S]*?addSubscriber\(email, req\)/);
    expect(server).toMatch(/app\.post\('\/api\/send-link\/subscribe'[\s\S]*?addSubscriber\(email, req\)/);
  });

  it('never subscribes on GET', () => {
    const get = server.match(/app\.get\('\/api\/send-link\/confirm'[\s\S]*?\n\}\);/)[0];
    expect(get).not.toContain('addSubscriber');
  });

  it('has no em dash in the welcome mail', () => {
    const welcome = server.match(/subject: 'Welcome to MailVault updates!'[\s\S]*?<\/div>`/)[0];
    expect(welcome).not.toContain('\u2014');
  });
});

describe('send-link per-visitor limit', () => {
  const server = readFileSync(resolve('website/api/server.js'), 'utf8');
  it('keys on the visitor behind Cloudflare, not on the shared edge address', () => {
    const limiter = server.match(/const sendLinkLimiter = rateLimit\(\{[\s\S]*?\n\}\);/)[0];
    expect(limiter).toContain('keyGenerator: visitorIP');
    expect(server).toMatch(/const visitorIP = [\s\S]*?cf-connecting-ip/);
  });
});
