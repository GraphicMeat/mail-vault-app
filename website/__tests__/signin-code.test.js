import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createSigninCode, RESPONSES, normalizeEmail } = require('../api/signin-code.js');
const mail = require('../api/signin-code-email.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// An in-memory stand-in for the two tables the module touches. It answers the
// exact statements signin-code.js issues and fails loudly on any other.
function fakeDb(customers = {}) {
  const rows = [];
  let nextId = 1;
  const calls = [];
  return {
    rows,
    calls,
    async execute(sql, p = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      calls.push([q, p]);
      if (q.startsWith('SELECT stripe_customer_id FROM billing_customers WHERE email = ?')) {
        return [customers[p[0]] ? [{ stripe_customer_id: customers[p[0]] }] : [], []];
      }
      if (q.startsWith('DELETE FROM billing_signin_codes WHERE expires_at <')) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].expires_at < p[0]) rows.splice(i, 1);
        return [{ affectedRows: 0 }, []];
      }
      if (q.startsWith('UPDATE billing_signin_codes SET used_at = ? WHERE email = ? AND used_at IS NULL')) {
        let n = 0;
        for (const r of rows) if (r.email === p[1] && r.used_at == null) { r.used_at = p[0]; n++; }
        return [{ affectedRows: n }, []];
      }
      if (q.startsWith('INSERT INTO billing_signin_codes')) {
        rows.push({ id: nextId++, email: p[0], code_hash: p[1], expires_at: p[2], attempts: 0, used_at: null });
        return [{ insertId: nextId - 1, affectedRows: 1 }, []];
      }
      if (q.startsWith('SELECT id, code_hash FROM billing_signin_codes WHERE email = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1')) {
        const r = rows.filter((x) => x.email === p[0] && x.used_at == null).sort((a, b) => b.id - a.id)[0];
        return [r ? [{ id: r.id, code_hash: r.code_hash }] : [], []];
      }
      if (q.startsWith('UPDATE billing_signin_codes SET attempts = attempts + 1 WHERE id = ?')) {
        const r = rows.find((x) => x.id === p[0]);
        const ok = r && r.used_at == null && r.attempts < p[1] && r.expires_at > p[2];
        if (ok) r.attempts++;
        return [{ affectedRows: ok ? 1 : 0 }, []];
      }
      if (q.startsWith('UPDATE billing_signin_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')) {
        const r = rows.find((x) => x.id === p[1]);
        const ok = r && r.used_at == null;
        if (ok) r.used_at = p[0];
        return [{ affectedRows: ok ? 1 : 0 }, []];
      }
      throw new Error(`unexpected SQL: ${q}`);
    },
  };
}

function setup({ customers = { 'reader@example.com': 'cus_123' }, ...opts } = {}) {
  const db = fakeDb(customers);
  const sent = [];
  const clock = { t: 1_800_000_000_000 };
  const codes = [];
  const signin = createSigninCode({
    getDb: () => db,
    send: async (endpoint, payload) => { sent.push({ endpoint, ...payload }); },
    configured: () => true,
    now: () => clock.t,
    logError: () => {},
    ...opts,
  });
  const codeOf = (i = sent.length - 1) => sent[i].text.match(/\b(\d{6})\b/)[1];
  return { db, sent, clock, codes, signin, codeOf };
}

describe('signin start', () => {
  it('mails a 6-digit code to a billing customer and answers ok', async () => {
    const { signin, sent, db } = setup();
    expect(await signin.start({ email: 'reader@example.com' })).toBe('ok');
    await signin.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0].endpoint).toBe('send');
    expect(sent[0].to).toBe('reader@example.com');
    expect(sent[0].text).toMatch(/\b\d{6}\b/);
    expect(sent[0].html).toMatch(/\b\d{6}\b/);
    // only a hash is stored, never the code
    const code = sent[0].text.match(/\b(\d{6})\b/)[1];
    expect(JSON.stringify(db.rows)).not.toContain(code);
    expect(db.rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the address case-insensitively, as customers are stored lowercased', async () => {
    const { signin, sent } = setup();
    await signin.start({ email: '  Reader@Example.COM ' });
    await signin.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('reader@example.com');
    expect(normalizeEmail(' A@B.co ')).toBe('a@b.co');
  });

  it('answers the same for an unknown address and sends nothing', async () => {
    const { signin, sent } = setup();
    expect(await signin.start({ email: 'nobody@example.com' })).toBe('ok');
    await signin.drain();
    expect(sent).toHaveLength(0);
    expect(RESPONSES.ok).toEqual([200, { ok: true }]);
  });

  it('answers ok for garbage input without sending', async () => {
    const { signin, sent, db } = setup();
    for (const email of [undefined, 42, '', 'not-an-email', 'a@b.co'.padEnd(300, 'x')]) {
      expect(await signin.start({ email })).toBe('ok');
    }
    await signin.drain();
    expect(sent).toHaveLength(0);
    expect(db.rows).toHaveLength(0);
  });

  it('limits one address to 3 codes an hour, known or not', async () => {
    for (const email of ['reader@example.com', 'nobody@example.com']) {
      const { signin, sent, clock } = setup();
      expect(await signin.start({ email })).toBe('ok');
      expect(await signin.start({ email })).toBe('ok');
      expect(await signin.start({ email })).toBe('ok');
      expect(await signin.start({ email })).toBe('limited');
      expect(RESPONSES.limited).toEqual([429, { error: 'rate_limited' }]);
      await signin.drain();
      if (email.startsWith('reader')) expect(sent).toHaveLength(3);
      clock.t += HOUR + 1;
      expect(await signin.start({ email })).toBe('ok');
    }
  });

  it('is unavailable-silent when mail is not configured, and logs that once', async () => {
    const errors = [];
    const { signin, sent } = setup({ configured: () => false, logError: (m) => errors.push(m) });
    expect(await signin.start({ email: 'reader@example.com' })).toBe('ok');
    await signin.drain();
    expect(sent).toHaveLength(0);
    expect(errors).toEqual(['[signin] mail sender not configured: a sign-in code for a customer was not mailed']);
    // once per process, and never for an unknown address (the answer must not differ)
    expect(await signin.start({ email: 'reader@example.com' })).toBe('ok');
    expect(errors).toHaveLength(1);
    const quiet = [];
    const other = setup({ configured: () => false, logError: (m) => quiet.push(m) });
    expect(await other.signin.start({ email: 'nobody@example.com' })).toBe('ok');
    expect(quiet).toHaveLength(0);
    expect(errors.join(' ')).not.toContain('reader@example.com');
  });

  it('purges rows a day past their expiry without a new start', async () => {
    const { signin, db, clock } = setup();
    expect(await signin.start({ email: 'reader@example.com' })).toBe('ok');
    expect(await signin.start({ email: 'nobody@example.com' })).toBe('ok');
    expect(db.rows).toHaveLength(2);
    clock.t += 10 * MIN + 24 * HOUR - 1;
    await signin.purge();
    expect(db.rows).toHaveLength(2);
    clock.t += 2;
    await signin.purge();
    expect(db.rows).toHaveLength(0);
  });

  it('survives a failing send', async () => {
    const logError = vi.fn();
    const { signin } = setup({ send: async () => { throw new Error('partner down'); }, logError });
    expect(await signin.start({ email: 'reader@example.com' })).toBe('ok');
    await signin.drain();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('partner down'));
    expect(logError.mock.calls[0][0]).not.toContain('reader@example.com');
  });
});

describe('signin verify', () => {
  it('round trips: the mailed code returns the Stripe customer id', async () => {
    const { signin, codeOf } = setup();
    await signin.start({ email: 'reader@example.com' });
    await signin.drain();
    const out = await signin.verify({ email: 'Reader@example.com', code: codeOf() });
    expect(out).toEqual({ customerId: 'cus_123' });
    expect(RESPONSES.customer).toBeUndefined();
  });

  it('refuses a wrong code and counts attempts, locking at 5', async () => {
    const { signin, codeOf, db } = setup();
    await signin.start({ email: 'reader@example.com' });
    await signin.drain();
    const good = codeOf();
    const bad = good === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) expect(await signin.verify({ email: 'reader@example.com', code: bad })).toEqual({ error: 'code_wrong' });
    expect(db.rows[0].attempts).toBe(5);
    // locked: even the right code is refused now
    expect(await signin.verify({ email: 'reader@example.com', code: good })).toEqual({ error: 'code_expired' });
  });

  it('accepts the right code on the 5th attempt', async () => {
    const { signin, codeOf } = setup();
    await signin.start({ email: 'reader@example.com' });
    await signin.drain();
    const good = codeOf();
    const bad = good === '000000' ? '000001' : '000000';
    for (let i = 0; i < 4; i++) await signin.verify({ email: 'reader@example.com', code: bad });
    expect(await signin.verify({ email: 'reader@example.com', code: good })).toEqual({ customerId: 'cus_123' });
  });

  it('expires after 10 minutes', async () => {
    const { signin, codeOf, clock } = setup();
    await signin.start({ email: 'reader@example.com' });
    await signin.drain();
    clock.t += 10 * MIN + 1;
    expect(await signin.verify({ email: 'reader@example.com', code: codeOf() })).toEqual({ error: 'code_expired' });
  });

  it('is still valid just inside 10 minutes', async () => {
    const { signin, codeOf, clock } = setup();
    await signin.start({ email: 'reader@example.com' });
    await signin.drain();
    clock.t += 10 * MIN - 1000;
    expect(await signin.verify({ email: 'reader@example.com', code: codeOf() })).toEqual({ customerId: 'cus_123' });
  });

  it('is single use', async () => {
    const { signin, codeOf } = setup();
    await signin.start({ email: 'reader@example.com' });
    await signin.drain();
    const code = codeOf();
    expect(await signin.verify({ email: 'reader@example.com', code })).toEqual({ customerId: 'cus_123' });
    expect(await signin.verify({ email: 'reader@example.com', code })).toEqual({ error: 'code_expired' });
  });

  it('two racing verifies of one code yield one success', async () => {
    const { signin, codeOf } = setup();
    await signin.start({ email: 'reader@example.com' });
    await signin.drain();
    const code = codeOf();
    const outs = await Promise.all([
      signin.verify({ email: 'reader@example.com', code }),
      signin.verify({ email: 'reader@example.com', code }),
    ]);
    expect(outs.filter((o) => o.customerId)).toHaveLength(1);
  });

  it('a newer code replaces the older one', async () => {
    const { signin, codeOf } = setup();
    await signin.start({ email: 'reader@example.com' });
    await signin.start({ email: 'reader@example.com' });
    await signin.drain();
    const first = codeOf(0);
    const second = codeOf(1);
    if (first !== second) expect(await signin.verify({ email: 'reader@example.com', code: first })).toEqual({ error: 'code_wrong' });
    expect(await signin.verify({ email: 'reader@example.com', code: second })).toEqual({ customerId: 'cus_123' });
  });

  it('never accepts a code minted for another address', async () => {
    const { signin, codeOf } = setup({ customers: { 'a@example.com': 'cus_a', 'b@example.com': 'cus_b' } });
    await signin.start({ email: 'a@example.com' });
    await signin.drain();
    const out = await signin.verify({ email: 'b@example.com', code: codeOf() });
    expect(out.customerId).toBeUndefined();
  });

  it('rejects malformed codes without a customer id', async () => {
    for (const code of [undefined, '', '12345', '1234567', 'abcdef', 123456, { $ne: 1 }, '12 456']) {
      const { signin } = setup();
      await signin.start({ email: 'reader@example.com' });
      const out = await signin.verify({ email: 'reader@example.com', code });
      expect(out.customerId).toBeUndefined();
      expect(out.error).toBe('code_wrong');
    }
  });

  it('an unknown address cannot be told apart from a known one at any step', async () => {
    const known = setup();
    const unknown = setup();
    await known.signin.start({ email: 'reader@example.com' });
    await unknown.signin.start({ email: 'nobody@example.com' });
    const steps = [];
    for (const s of [known, unknown]) {
      const email = s === known ? 'reader@example.com' : 'nobody@example.com';
      const seq = [];
      for (let i = 0; i < 6; i++) seq.push(await s.signin.verify({ email, code: '000000' }));
      steps.push(JSON.stringify(seq));
    }
    expect(steps[0]).toBe(steps[1]);
    // never requested at all answers the same as a spent/expired one, for both
    const fresh = await known.signin.verify({ email: 'never@example.com', code: '123456' });
    expect(fresh).toEqual({ error: 'code_expired' });
  });

  it('a correct code for a customer who no longer exists yields no id', async () => {
    const customers = { 'reader@example.com': 'cus_123' };
    const { signin, codeOf } = setup({ customers });
    await signin.start({ email: 'reader@example.com' });
    await signin.drain();
    delete customers['reader@example.com'];
    const out = await signin.verify({ email: 'reader@example.com', code: codeOf() });
    expect(out).toEqual({ error: 'code_wrong' });
  });

  it('maps outcomes to HTTP statuses', () => {
    expect(RESPONSES.code_wrong[0]).toBe(401);
    expect(RESPONSES.code_expired[0]).toBe(410);
    expect(RESPONSES.rate_limited).toEqual([429, { error: 'rate_limited' }]);
  });

  it('draws codes from a secure uniform 6-digit space', async () => {
    const random = vi.fn(() => 7);
    const { signin, sent } = setup({ randomInt: random });
    await signin.start({ email: 'reader@example.com' });
    await signin.drain();
    expect(random).toHaveBeenCalledWith(0, 1_000_000);
    expect(sent[0].text).toContain('000007');
  });
});

describe('signin mail', () => {
  const LANGS = Object.keys(require('../api/send-link-email.js').LOCALES);
  it.each(LANGS)('%s has subject, code in both parts, no em dash, nothing remote', (lang) => {
    const { subject, text, html } = mail.buildSigninCodeEmail(lang, '482913');
    expect(subject.length).toBeGreaterThan(5);
    expect(text).toContain('482913');
    expect(html).toContain('482913');
    for (const s of [subject, text, html]) expect(s).not.toContain('—');
    expect(html).not.toMatch(/<img|src=|url\(|<link|http:\/\//i);
    expect(html).not.toMatch(/href=/i);
    expect(subject).not.toContain('482913');
  });
  it('localizes and falls back to English', () => {
    const subjects = LANGS.map((l) => mail.buildSigninCodeEmail(l, '111111').subject);
    expect(new Set(subjects).size).toBe(LANGS.length);
    expect(mail.buildSigninCodeEmail('xx', '111111')).toEqual(mail.buildSigninCodeEmail('en', '111111'));
  });
});
