import { describe, it, expect } from 'vitest';
import {
  buildThreads,
  normalizeSubject,
  buildReplyHeaders,
  normalizeMessageId,
  parseReferenceList,
  threadRowMembers,
} from '../emailParser';

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

// ── Truncated References chains ─────────────────────────────────────────────
//
// The bug: replying three times inside MailVault turned one conversation into
// three rows. Its own replies carried `References: <parent>` only, so each one
// rooted at its parent instead of the conversation — and the recipient's client
// then extended that truncated chain, pairing its answer with our reply.

/** A conversation where every reply names ONLY its parent's chain + parent. */
function truncatedChain(n) {
  const emails = [mk({ uid: 1, messageId: '<m0@x>', subject: 'Numbers', date: '2026-07-01T10:00:00Z' })];
  for (let i = 1; i < n; i++) {
    emails.push(mk({
      uid: i + 1,
      messageId: `<m${i}@x>`,
      subject: 'Re: Numbers',
      inReplyTo: `<m${i - 1}@x>`,
      references: [`<m${i - 1}@x>`], // truncated: the parent only
      date: `2026-07-0${i + 1}T10:00:00Z`,
    }));
  }
  return emails;
}

describe('buildThreads — truncated reference chains', () => {
  it('keeps reply → reply → reply in ONE thread', () => {
    const threads = buildThreads(truncatedChain(4));
    expect(threads.size).toBe(1);
    expect([...threads.values()][0].emails).toHaveLength(4);
  });

  it('names the thread after the conversation root, not the last parent', () => {
    const threads = buildThreads(truncatedChain(4));
    expect([...threads.keys()]).toEqual(['<m0@x>']);
  });

  it('merges a chain that arrives out of order, with the same threadId', () => {
    const inOrder = truncatedChain(4);
    const shuffled = [inOrder[2], inOrder[0], inOrder[3], inOrder[1]];
    const threads = buildThreads(shuffled);
    expect(threads.size).toBe(1);
    expect([...threads.keys()]).toEqual(['<m0@x>']);
  });

  it('threads a reply whose parent is missing from the set', () => {
    // Only the tail of the conversation is loaded — the two still belong together.
    const threads = buildThreads(truncatedChain(4).slice(2));
    expect(threads.size).toBe(1);
  });

  it('still keeps genuinely separate conversations apart', () => {
    const emails = [...truncatedChain(3), mk({ uid: 90, messageId: '<other@x>', subject: 'Numbers' })];
    expect(buildThreads(emails).size).toBe(2);
  });

  it('does not hang on a reference cycle', () => {
    const emails = [
      mk({ uid: 1, messageId: '<a@x>', references: ['<b@x>'] }),
      mk({ uid: 2, messageId: '<b@x>', references: ['<a@x>'] }),
    ];
    expect(buildThreads(emails).size).toBe(1);
  });
});

// ── Shapes the vault and the local index actually produce ───────────────────

describe('buildThreads — id and header shapes', () => {
  it('threads a local-index entry that uses snake_case fields', () => {
    const emails = [
      mk({ uid: 1, messageId: '<root@x>', subject: 'Invoice' }),
      // What ComposeModal writes into local-index.json for a sent reply. The
      // subject carries no Re:, so the subject fallback cannot rescue it —
      // only in_reply_to / message_id can put it in the conversation.
      {
        uid: 2,
        message_id: '<sent@x>',
        in_reply_to: '<root@x>',
        subject: 'Invoice',
        date: '2026-07-02T10:00:00Z',
        from: { address: 'me@x.com' },
      },
      // Their answer names our sent copy, so its id has to be indexed too.
      mk({ uid: 3, messageId: '<reply@x>', subject: 'Re: Invoice', references: ['<root@x>', '<sent@x>'] }),
    ];
    const threads = buildThreads(emails);
    expect(threads.size).toBe(1);
    expect([...threads.values()][0].emails).toHaveLength(3);
  });

  it('accepts References as a raw header string', () => {
    const emails = [
      mk({ uid: 1, messageId: '<root@x>', subject: 'Invoice' }),
      mk({ uid: 2, messageId: '<r1@x>', subject: 'Re: Invoice', references: '<root@x>' }),
    ];
    expect(buildThreads(emails).size).toBe(1);
  });

  it('does not lump unrelated string-References messages under one bogus root', () => {
    // Indexing the string gave refs[0] === '<' for every one of them.
    const emails = [
      mk({ uid: 1, messageId: '<a1@x>', subject: 'One', references: '<other-a@x>' }),
      mk({ uid: 2, messageId: '<b1@x>', subject: 'Two', references: '<other-b@x>' }),
    ];
    expect(buildThreads(emails).size).toBe(2);
  });

  it('links ids that differ only by their angle brackets', () => {
    const emails = [
      mk({ uid: 1, messageId: 'root@x', subject: 'Invoice' }),           // unbracketed
      mk({ uid: 2, messageId: '<r1@x>', subject: 'Re: Invoice', inReplyTo: '<root@x>' }),
    ];
    expect(buildThreads(emails).size).toBe(1);
  });
});

// ── Reply headers ───────────────────────────────────────────────────────────

describe('buildReplyHeaders', () => {
  it('keeps the parent\'s chain and appends the parent (RFC 5322 §3.6.4)', () => {
    const parent = { messageId: '<m2@x>', references: ['<m0@x>', '<m1@x>'] };
    expect(buildReplyHeaders(parent)).toEqual({
      inReplyTo: '<m2@x>',
      references: '<m0@x> <m1@x> <m2@x>',
    });
  });

  it('falls back to the parent alone when it has no chain', () => {
    expect(buildReplyHeaders({ messageId: '<m0@x>' })).toEqual({
      inReplyTo: '<m0@x>',
      references: '<m0@x>',
    });
  });

  it('reads a local-index parent (snake_case, References as a string)', () => {
    const parent = { message_id: '<m1@x>', references: '<m0@x>' };
    expect(buildReplyHeaders(parent).references).toBe('<m0@x> <m1@x>');
  });

  it('brackets a bare parent id and never repeats it', () => {
    const parent = { messageId: 'm1@x', references: ['<m0@x>', 'm1@x'] };
    expect(buildReplyHeaders(parent)).toEqual({
      inReplyTo: '<m1@x>',
      references: '<m0@x> <m1@x>',
    });
  });

  it('yields empty headers for a missing parent', () => {
    expect(buildReplyHeaders(null)).toEqual({ inReplyTo: '', references: '' });
    expect(buildReplyHeaders({})).toEqual({ inReplyTo: '', references: '' });
  });

  it('round-trips into a thread: the reply lands on the original', () => {
    const original = mk({ uid: 1, messageId: '<m0@x>', subject: 'Numbers' });
    let latest = original;
    const conversation = [original];
    for (let i = 1; i <= 3; i++) {
      const headers = buildReplyHeaders(latest);
      latest = mk({
        uid: i + 1,
        messageId: `<m${i}@x>`,
        subject: 'Re: Numbers',
        inReplyTo: headers.inReplyTo,
        references: headers.references, // as the SMTP header value: one string
        date: `2026-07-0${i + 1}T10:00:00Z`,
      });
      conversation.push(latest);
    }
    // The last reply carries the whole history, which is what the recipient's
    // client extends — no fragment can form.
    expect(buildReplyHeaders(latest).references).toBe('<m0@x> <m1@x> <m2@x> <m3@x>');
    expect(buildThreads(conversation).size).toBe(1);
  });
});

describe('message-id helpers', () => {
  it('normalizes brackets and whitespace', () => {
    expect(normalizeMessageId(' <a@x> ')).toBe('<a@x>');
    expect(normalizeMessageId('a@x')).toBe('<a@x>');
    expect(normalizeMessageId('')).toBeNull();
    expect(normalizeMessageId(null)).toBeNull();
  });

  it('splits a folded References header and drops duplicates', () => {
    expect(parseReferenceList('<a@x>\n <b@x> <a@x>')).toEqual(['<a@x>', '<b@x>']);
    expect(parseReferenceList(['<a@x>', '<b@x>'])).toEqual(['<a@x>', '<b@x>']);
    expect(parseReferenceList(null)).toEqual([]);
  });
});


// A thread row in INBOX renders INBOX + Sent together so the conversation reads
// whole. Its checkbox, its menu and its archive button act by bare UID against
// the active mailbox, where a Sent message's UID names a different message —
// so they act on the part of the row that lives in this folder.
describe('threadRowMembers', () => {
  it('drops the Sent copies an INBOX list merged in', () => {
    const members = threadRowMembers([
      mk({ uid: 1 }),
      mk({ uid: 90, _fromSentFolder: true }),
      mk({ uid: 2 }),
    ]);
    expect(members.map(e => e.uid)).toEqual([1, 2]);
  });

  it('keeps a thread that is nothing but sent messages — they are all the row shows', () => {
    const sent = [mk({ uid: 90, _fromSentFolder: true }), mk({ uid: 91, _fromSentFolder: true })];
    expect(threadRowMembers(sent)).toEqual(sent);
  });

  it('is a no-op on a folder that merges nothing', () => {
    const emails = [mk({ uid: 1 }), mk({ uid: 2 })];
    expect(threadRowMembers(emails)).toEqual(emails);
  });
});
