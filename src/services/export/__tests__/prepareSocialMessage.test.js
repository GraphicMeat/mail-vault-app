// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('../renderMessageToCanvas', () => ({ renderMessageToCanvas: vi.fn(), measureMessageHeight: vi.fn() }));
vi.mock('../../../stores/settingsStore', () => ({
  hasPremiumAccess: () => true,
  useSettingsStore: { getState: () => ({ billingProfile: { hasSubscription: true } }) },
}));
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: { getState: () => ({ accounts: [], activeAccountId: 'acct-1', activeMailbox: 'INBOX' }) },
}));

const { prepareSocialMessage } = await import('../exportService');
const { buildNameDictionary } = await import('../../../utils/privacy/piiDetector');
const { PEOPLE, NEEDLES } = await import('../../../test/privacyFixtures');

const dict = buildNameDictionary({ names: PEOPLE.names });
const noLeak = (s) => NEEDLES.forEach(n => expect(s, n).not.toContain(n));

const spam = {
  uid: 5, subject: 'You won', date: new Date('2026-09-01T10:00:00Z'),
  from: { name: 'Prize Desk', address: 'win@prize.example' },
  to: [{ name: 'Rokas Ambrazevičius', address: 'rokas@example.lt' }],
  replyTo: [{ address: 'collect@elsewhere.example' }],
  authenticationResults: 'mx; spf=fail; dkim=none; dmarc=fail',
  html: '<p>Hi Rokas Ambrazevičius, claim at <a href="http://claim.example/c/rokas%40example.lt?t=SECRET">https://bank.example</a>'
    + ' or <a href="javascript:run()">here</a> or <a href="https://fine.example/ok">fine</a></p>',
};
const prepare = (message, opts) => prepareSocialMessage(message, { mirror: false, ...opts });

describe('prepareSocialMessage: details and links', () => {
  it('returns neither unless asked', async () => {
    const r = await prepare(spam);
    expect(r.details).toBeNull();
    expect(r.links).toBeNull();
  });

  it('unredacted: the real sender model and every web or script link, worst first', async () => {
    const r = await prepare(spam, { details: true, links: true });
    expect(r.details).toMatchObject({ address: 'win@prize.example', name: 'Prize Desk', auth: { spf: 'fail', dkim: 'none', dmarc: 'fail' } });
    expect(r.details.issues.map(i => i.level)).toContain('danger');
    expect(r.details.replyTo).toEqual({ address: 'collect@elsewhere.example', matches: false });
    // javascript: is gone from the sanitized body but still listed.
    expect(r.body).not.toContain('javascript:');
    expect(r.links.links.map(l => l.href)).toEqual([
      'http://claim.example/c/rokas%40example.lt?t=SECRET', // red: the text shows bank.example
      'javascript:run()',
      'https://fine.example/ok',
    ]);
    expect(r.links.links.map(l => l.level)).toEqual(['red', 'red', null]);
  });

  it('redacted: masked sender model, host-only links, no person anywhere in what is returned', async () => {
    const r = await prepare(spam, { redact: { dict, format: 'image' }, details: true, links: true });
    expect(r.details.address).toBe('xxx@xxxxx.xxxxxxx');
    expect(r.details.name).toBe('xxxxx xxxx');
    expect(r.details.auth.spf).toBe('fail'); // the verdicts are not people
    expect(r.links.links.map(l => l.href).sort()).toEqual(['http://claim.example', 'https://fine.example', 'javascript:']);
    const all = JSON.stringify({ details: r.details, links: r.links, message: r.message, body: r.body });
    noLeak(all);
    for (const leak of ['SECRET', 'win@prize', 'collect@elsewhere', 'Prize Desk']) expect(all).not.toContain(leak);
  });

  it('redacted with a reveal: the sender stays readable in the header, the model and the body keeps the rest masked', async () => {
    const reveal = new Set(['win@prize.example', 'prize desk', 'collect@elsewhere.example']);
    const r = await prepare(spam, { redact: { dict: { ...dict, reveal }, format: 'image' }, details: true, links: true });
    expect(r.message.from).toEqual({ name: 'Prize Desk', address: 'win@prize.example' });
    expect(r.details).toMatchObject({ address: 'win@prize.example', name: 'Prize Desk', replyTo: { address: 'collect@elsewhere.example' } });
    expect(r.message.to[0].address).toBe('xxxxx@xxxxxxx.xx');
    noLeak(JSON.stringify({ details: r.details, message: { ...r.message, from: null, replyTo: null }, body: r.body }));
  });

  it('reveal survives a cold host: an empty host dictionary with a reveal still reveals', async () => {
    const cold = { ...buildNameDictionary({ names: [] }), reveal: new Set(['win@prize.example']) };
    const r = await prepare(spam, { redact: { dict: cold, format: 'image' } });
    expect(r.message.from.address).toBe('win@prize.example');
    expect(r.message.to[0].address).toBe('xxxxx@xxxxxxx.xx');
  });
});
