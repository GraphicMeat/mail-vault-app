import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Same arrangement as send-link.test.js: the API cannot boot here, so the
// sign-up pieces are pure modules tested on their own.
const require = createRequire(import.meta.url);
const token = require('../api/send-link-token.js');
const mail = require('../api/send-link-email.js');
const { buildSubscribeConfirmEmail, COPY } = require('../api/subscribe-confirm-email.js');
const { createSubscribeConfirm } = require('../api/subscribe-confirm.js');

const KEY = token.deriveKey('test-partner-key');
const LANGS = Object.keys(mail.LOCALES);
const HOUR = 60 * 60 * 1000;

describe('subscribe confirm email', () => {
  it('has copy for every site locale', () => {
    expect(Object.keys(COPY).sort()).toEqual([...LANGS].sort());
  });

  it.each(LANGS)('%s carries the confirm link in both parts and nothing remote', (lang) => {
    const t = token.seal(KEY, 'reader@example.com');
    const { subject, text, html } = buildSubscribeConfirmEmail(lang, t);
    const url = mail.linksFor(lang, t).subscribeUrl;
    expect(subject.length).toBeGreaterThan(5);
    expect(text).toContain(url);
    expect(html).toContain(url.replace(/&/g, '&amp;'));
    expect(html).not.toMatch(/<img|\bsrc=|url\(|<link\b|http:\/\//i);
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) expect(href).toMatch(/^https:\/\/mailvaultapp\.com\//);
  });

  it.each(LANGS)('%s keeps the address out of the mail', (lang) => {
    const { text, html } = buildSubscribeConfirmEmail(lang, token.seal(KEY, 'reader@example.com'));
    expect(text + html).not.toContain('reader@example.com');
  });
});

function setup(over = {}) {
  let t = Date.UTC(2026, 10, 11, 12);
  const send = vi.fn(async () => ({}));
  const isSubscribed = vi.fn(async () => false);
  const flow = createSubscribeConfirm({
    send, isSubscribed, configured: () => true, key: KEY, now: () => t, logError: () => {}, ...over,
  });
  return { flow, send, isSubscribed, advance: (ms) => { t += ms; } };
}

describe('createSubscribeConfirm', () => {
  it('mails a confirm link and nothing else', async () => {
    const { flow, send } = setup();
    expect(await flow.request({ email: ' Reader@Example.com ', lang: 'de' })).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    const [endpoint, payload] = send.mock.calls[0];
    expect(endpoint).toBe('send'); // transactional: the partner "subscribe" route would store the row
    expect(payload.to).toBe('Reader@Example.com');
    expect(payload.text).toContain('/api/send-link/confirm?t=');
    expect(payload.text).toContain('lang=de');
  });

  it('rejects bad input without mailing', async () => {
    const { flow, send } = setup();
    for (const email of [undefined, 42, '', '  ', 'nope', 'a@b', `${'x'.repeat(250)}@e.co`]) {
      expect(await flow.request({ email })).toBe('invalid');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('a filled honeypot looks like success and mails nothing', async () => {
    const { flow, send } = setup();
    expect(await flow.request({ email: 'bot@example.com', website: 'http://spam' })).toBe('sent');
    expect(send).not.toHaveBeenCalled();
  });

  it('is unavailable without partner config or key', async () => {
    expect(await setup({ configured: () => false }).flow.request({ email: 'a@example.com' })).toBe('unavailable');
    expect(await setup({ key: null }).flow.request({ email: 'a@example.com' })).toBe('unavailable');
  });

  it('mails an address once an hour, however often it is submitted', async () => {
    const { flow, send, advance } = setup();
    expect(await flow.request({ email: 'a@example.com' })).toBe('sent');
    expect(await flow.request({ email: 'A@EXAMPLE.COM' })).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    advance(HOUR + 1);
    await flow.request({ email: 'a@example.com' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('answers sent for an existing subscriber without mailing', async () => {
    const { flow, send, isSubscribed } = setup();
    isSubscribed.mockResolvedValue(true);
    expect(await flow.request({ email: 'member@example.com' })).toBe('sent');
    expect(send).not.toHaveBeenCalled();
  });

  it('stops at the daily cap, and existing subscribers do not use it up', async () => {
    const { flow, send, isSubscribed } = setup({ dailyCap: 2 });
    isSubscribed.mockImplementation(async (a) => a.startsWith('member'));
    await flow.request({ email: 'member1@example.com' });
    await flow.request({ email: 'member2@example.com' });
    expect(await flow.request({ email: 'a1@example.com' })).toBe('sent');
    expect(await flow.request({ email: 'a2@example.com' })).toBe('sent');
    expect(await flow.request({ email: 'a3@example.com' })).toBe('limited');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a failed send frees the address and the daily slot', async () => {
    const { flow, send } = setup({ dailyCap: 1 });
    send.mockRejectedValueOnce(new Error('smtp down'));
    expect(await flow.request({ email: 'a@example.com' })).toBe('failed');
    expect(await flow.request({ email: 'a@example.com' })).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a lookup failure mails nothing and never logs the address', async () => {
    const logError = vi.fn();
    const { flow, send, isSubscribed } = setup({ logError });
    isSubscribed.mockRejectedValue(Object.assign(new Error('boom a@example.com'), { code: 'ECONN' }));
    expect(await flow.request({ email: 'a@example.com' })).toBe('failed');
    expect(send).not.toHaveBeenCalled();
    expect(logError.mock.calls.flat().join(' ')).not.toContain('a@example.com');
  });
});
