import { describe, it, expect } from 'vitest';
import { buildThreads, normalizeSubject } from '../emailParser';

const mk = (over = {}) => ({
  uid: Math.floor(Math.random() * 1e9),
  messageId: `<${Math.random().toString(36).slice(2)}@example.com>`,
  subject: 'Hello',
  date: '2026-07-01T10:00:00Z',
  from: { address: 'a@example.com' },
  ...over,
});

describe('buildThreads subject fallback', () => {
  it('does NOT merge unrelated same-subject automated emails (digests)', () => {
    const emails = [
      mk({ uid: 1, subject: '[snapcraft.io] Summary', from: { address: 'forum@forum.snapcraft.io' } }),
      mk({ uid: 2, subject: '[snapcraft.io] Summary', from: { address: 'forum@forum.snapcraft.io' } }),
      mk({ uid: 3, subject: '[snapcraft.io] Summary', from: { address: 'forum@forum.snapcraft.io' } }),
    ];
    const threads = buildThreads(emails);
    expect(threads.size).toBe(3);
  });

  it('does NOT merge same-subject contact-form emails with digests', () => {
    const emails = [
      mk({ uid: 1, subject: '[snapcraft.io] Summary' }),
      mk({ uid: 2, subject: 'Contact form — Robertgat' }),
      mk({ uid: 3, subject: 'Contact form — Robertgat' }),
    ];
    const threads = buildThreads(emails);
    expect(threads.size).toBe(3);
  });

  it('does NOT merge bare no-subject orphans', () => {
    const emails = [mk({ uid: 1, subject: '' }), mk({ uid: 2, subject: '' })];
    expect(buildThreads(emails).size).toBe(2);
  });

  it('still merges a headerless "Re:" orphan into the original by subject', () => {
    const emails = [
      mk({ uid: 1, subject: 'Quote request' }),
      mk({ uid: 2, subject: 'Re: Quote request' }), // no In-Reply-To/References
    ];
    const threads = buildThreads(emails);
    expect(threads.size).toBe(1);
    expect([...threads.values()][0].emails).toHaveLength(2);
  });

  it('still threads via References chains regardless of subject', () => {
    const root = mk({ uid: 1, messageId: '<root@x>', subject: 'Topic' });
    const reply = mk({ uid: 2, messageId: '<r1@x>', subject: 'Totally different', references: ['<root@x>'] });
    const threads = buildThreads([root, reply]);
    expect(threads.size).toBe(1);
  });

  it('never merges reply-like orphans across accounts', () => {
    const emails = [
      mk({ uid: 1, subject: 'Quote', _accountId: 'A' }),
      mk({ uid: 2, subject: 'Re: Quote', _accountId: 'B' }),
    ];
    expect(buildThreads(emails).size).toBe(2);
  });
});

describe('normalizeSubject', () => {
  it('strips nested reply prefixes', () => {
    expect(normalizeSubject('Re: Fwd: RE: Hello')).toBe('Hello');
  });
});
