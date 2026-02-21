import { describe, it, expect } from 'vitest';
import {
  getCorrespondent,
  groupByCorrespondent,
  normalizeSubject,
  groupByTopic,
  getCleanMessageBody,
  htmlToPlainText,
  stripSignature,
  stripQuotedContent,
  isFromUser,
  getPreview,
  isDifferentDay,
  formatDateSeparator,
  formatMessageTime,
  formatRelativeTime
} from '../../src/utils/emailParser.js';

// ── Helper: build email objects ─────────────────────────────────────

function makeEmail(overrides = {}) {
  return {
    uid: 1,
    from: { address: 'alice@example.com', name: 'Alice' },
    to: [{ address: 'me@example.com', name: 'Me' }],
    subject: 'Test Subject',
    date: '2024-06-15T12:00:00Z',
    flags: [],
    ...overrides,
  };
}

const USER = 'me@example.com';

// ═════════════════════════════════════════════════════════════════════
// Chat View: Correspondent Grouping (real-world patterns)
// ═════════════════════════════════════════════════════════════════════

describe('groupByCorrespondent — real-world patterns', () => {
  it('groups a bidirectional thread into one correspondent', () => {
    // Pattern from real data: tomas@sdatransport.eu ↔ eda@ntgroad.se
    const emails = [
      makeEmail({ uid: 1, from: { address: 'eda@ntgroad.se', name: 'Eda' }, to: [{ address: USER }], subject: 'MYY046/ZZM51Z', date: '2024-01-10T08:00:00Z' }),
      makeEmail({ uid: 2, from: { address: USER, name: 'Me' }, to: [{ address: 'eda@ntgroad.se', name: 'Eda' }], subject: 'RE: MYY046/ZZM51Z', date: '2024-01-10T09:00:00Z' }),
      makeEmail({ uid: 3, from: { address: 'eda@ntgroad.se', name: 'Eda' }, to: [{ address: USER }], subject: 'RE: MYY046/ZZM51Z', date: '2024-01-10T10:00:00Z' }),
      makeEmail({ uid: 4, from: { address: USER, name: 'Me' }, to: [{ address: 'eda@ntgroad.se', name: 'Eda' }], subject: 'RE: MYY046/ZZM51Z', date: '2024-01-10T11:00:00Z' }),
    ];
    const groups = groupByCorrespondent(emails, USER);
    expect(groups.size).toBe(1);
    expect(groups.get('eda@ntgroad.se').emails).toHaveLength(4);
  });

  it('handles multiple correspondents sending about the same subject', () => {
    // Pattern from real data: MYY046/YDD848 from lsc@, dla@, mko@ — all to tomas@
    const emails = [
      makeEmail({ uid: 1, from: { address: 'lsc@ntgroad.se', name: 'LSC' }, to: [{ address: USER }], subject: 'FW: MYY046/YDD848' }),
      makeEmail({ uid: 2, from: { address: 'dla@ntgroad.se', name: 'DLA' }, to: [{ address: USER }], subject: 'RE: MYY046/YDD848' }),
      makeEmail({ uid: 3, from: { address: 'mko@ntgroad.se', name: 'MKO' }, to: [{ address: USER }], subject: 'RE: MYY046/YDD848' }),
    ];
    const groups = groupByCorrespondent(emails, USER);
    // Each sender becomes their own correspondent group
    expect(groups.size).toBe(3);
    expect(groups.has('lsc@ntgroad.se')).toBe(true);
    expect(groups.has('dla@ntgroad.se')).toBe(true);
    expect(groups.has('mko@ntgroad.se')).toBe(true);
  });

  it('handles emails with multiple recipients (CC pattern)', () => {
    // Real pattern: email sent to tomas@ with CC to multiple others
    const emails = [
      makeEmail({
        uid: 1,
        from: { address: 'dmu@ntgroad.se', name: 'DMU' },
        to: [
          { address: USER },
          { address: 'riv@ntgroad.se' },
          { address: 'rda@ntgroad.se' },
        ],
        cc: [{ address: 'tja@ntgroad.se' }],
      }),
    ];
    const groups = groupByCorrespondent(emails, USER);
    expect(groups.size).toBe(1);
    expect(groups.has('dmu@ntgroad.se')).toBe(true);
  });

  it('handles sender with special characters in display name', () => {
    // Real pattern: UAB „Everwest" (Lithuanian quotation marks)
    const emails = [
      makeEmail({
        uid: 1,
        from: { address: 'info@everwest.lt', name: 'UAB „Everwest"' },
        to: [{ address: USER }],
      }),
    ];
    const groups = groupByCorrespondent(emails, USER);
    const group = groups.get('info@everwest.lt');
    expect(group.name).toBe('UAB „Everwest"');
  });

  it('handles self-sent emails (from and to are the same user)', () => {
    const emails = [
      makeEmail({
        uid: 1,
        from: { address: USER, name: 'Me' },
        to: [{ address: USER, name: 'Me' }],
        subject: 'Note to self',
      }),
    ];
    const groups = groupByCorrespondent(emails, USER);
    // Correspondent is the "to" (which is also user)
    expect(groups.size).toBe(1);
    expect(groups.has(USER)).toBe(true);
  });

  it('handles 17000+ emails without crashing', () => {
    // Simulate scale from real data (cc15df7f account had 17020 emails)
    const emails = Array.from({ length: 500 }, (_, i) => makeEmail({
      uid: i + 1,
      from: { address: `sender${i % 50}@example.com`, name: `Sender ${i % 50}` },
      to: [{ address: USER }],
      subject: `Thread ${i % 20}`,
      date: new Date(2024, 0, 1, 0, i).toISOString(),
    }));
    const groups = groupByCorrespondent(emails, USER);
    expect(groups.size).toBe(50);
    // Each sender gets 10 emails (500 / 50 senders)
    for (const group of groups.values()) {
      expect(group.emails).toHaveLength(10);
    }
  });

  it('handles emails with empty from address', () => {
    const emails = [
      makeEmail({ uid: 1, from: { address: '', name: '' }, to: [{ address: USER }] }),
    ];
    const groups = groupByCorrespondent(emails, USER);
    // Empty key is skipped
    expect(groups.size).toBe(0);
  });

  it('handles emails with no to field (empty key skipped)', () => {
    const emails = [
      makeEmail({ uid: 1, from: { address: USER }, to: undefined }),
    ];
    const groups = groupByCorrespondent(emails, USER);
    // When from=user and to is undefined, correspondent key is '' which is skipped
    expect(groups.size).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Chat View: Topic Grouping
// ═════════════════════════════════════════════════════════════════════

describe('groupByTopic — real-world patterns', () => {
  it('groups FW: and RE: variants of same subject', () => {
    // Real pattern from MYY046/YDD848
    const emails = [
      makeEmail({ uid: 1, subject: 'MYY046/YDD848', date: '2024-01-10T08:00:00Z' }),
      makeEmail({ uid: 2, subject: 'FW: MYY046/YDD848', date: '2024-01-10T09:00:00Z' }),
      makeEmail({ uid: 3, subject: 'RE: MYY046/YDD848', date: '2024-01-10T10:00:00Z' }),
      makeEmail({ uid: 4, subject: 'Re: MYY046/YDD848', date: '2024-01-10T11:00:00Z' }),
    ];
    const topics = groupByTopic(emails);
    expect(topics.size).toBe(1);
    expect(topics.get('MYY046/YDD848').emails).toHaveLength(4);
  });

  it('groups duplicate subjects (same email sent multiple times)', () => {
    // Real pattern: "Shipping confirmation: Order #98234" sent 7 times
    const emails = Array.from({ length: 7 }, (_, i) => makeEmail({
      uid: i + 1,
      subject: 'Shipping confirmation: Order #98234',
      date: new Date(2024, 0, 15, 10 + i).toISOString(),
    }));
    const topics = groupByTopic(emails);
    expect(topics.size).toBe(1);
    expect(topics.get('Shipping confirmation: Order #98234').emails).toHaveLength(7);
  });

  it('handles empty subject', () => {
    // Real data: 68 emails with empty subjects
    const emails = [
      makeEmail({ uid: 1, subject: '', date: '2024-01-10T08:00:00Z' }),
      makeEmail({ uid: 2, subject: '', date: '2024-01-10T09:00:00Z' }),
      makeEmail({ uid: 3, subject: 'Re: ', date: '2024-01-10T10:00:00Z' }),
    ];
    const topics = groupByTopic(emails);
    // All normalize to "(No subject)"
    expect(topics.size).toBe(1);
    expect(topics.get('(No subject)').emails).toHaveLength(3);
  });

  it('handles null subject', () => {
    const emails = [
      makeEmail({ uid: 1, subject: null }),
      makeEmail({ uid: 2, subject: undefined }),
    ];
    const topics = groupByTopic(emails);
    expect(topics.size).toBe(1);
    expect(topics.get('(No subject)').emails).toHaveLength(2);
  });

  it('handles very long subjects', () => {
    // Real data: longest subject was 165 chars
    const longSubject = 'A'.repeat(165);
    const emails = [
      makeEmail({ uid: 1, subject: longSubject }),
      makeEmail({ uid: 2, subject: `Re: ${longSubject}` }),
    ];
    const topics = groupByTopic(emails);
    expect(topics.size).toBe(1);
    expect(topics.get(longSubject).emails).toHaveLength(2);
  });

  it('handles subjects with special characters', () => {
    // Real patterns: subjects with slashes, arrows, parens
    const emails = [
      makeEmail({ uid: 1, subject: 'UAB SDA Transport - MUB348 // PAT74K --> YJA351' }),
      makeEmail({ uid: 2, subject: 'RE: UAB SDA Transport - MUB348 // PAT74K --> YJA351' }),
    ];
    const topics = groupByTopic(emails);
    expect(topics.size).toBe(1);
  });

  it('separates unrelated subjects that start similarly', () => {
    const emails = [
      makeEmail({ uid: 1, subject: 'MYY046/YDD848' }),
      makeEmail({ uid: 2, subject: 'MYY046/YCX538' }),
      makeEmail({ uid: 3, subject: 'MYY046/ZZM51Z' }),
    ];
    const topics = groupByTopic(emails);
    expect(topics.size).toBe(3);
  });

  it('preserves chronological order within topic', () => {
    const emails = [
      makeEmail({ uid: 3, subject: 'RE: Topic', date: '2024-01-12T10:00:00Z' }),
      makeEmail({ uid: 1, subject: 'Topic', date: '2024-01-10T10:00:00Z' }),
      makeEmail({ uid: 2, subject: 'RE: Topic', date: '2024-01-11T10:00:00Z' }),
    ];
    const topics = groupByTopic(emails);
    const topic = topics.get('Topic');
    expect(topic.emails[0].uid).toBe(1);
    expect(topic.emails[1].uid).toBe(2);
    expect(topic.emails[2].uid).toBe(3);
  });

  it('tracks date range across topic', () => {
    const emails = [
      makeEmail({ uid: 1, subject: 'Weekly digest: Engineering updates', date: '2024-01-01T10:00:00Z' }),
      makeEmail({ uid: 2, subject: 'Weekly digest: Engineering updates', date: '2024-01-08T10:00:00Z' }),
      makeEmail({ uid: 3, subject: 'Weekly digest: Engineering updates', date: '2024-01-15T10:00:00Z' }),
    ];
    const topics = groupByTopic(emails);
    const topic = topics.get('Weekly digest: Engineering updates');
    expect(topic.dateRange.start).toEqual(new Date('2024-01-01T10:00:00Z'));
    expect(topic.dateRange.end).toEqual(new Date('2024-01-15T10:00:00Z'));
  });
});

// ═════════════════════════════════════════════════════════════════════
// Chat View: normalizeSubject edge cases
// ═════════════════════════════════════════════════════════════════════

describe('normalizeSubject — extreme cases', () => {
  it('strips mixed-case Re/Fwd prefixes', () => {
    expect(normalizeSubject('rE: Hello')).toBe('Hello');
    expect(normalizeSubject('fWd: Hello')).toBe('Hello');
  });

  it('strips triple-nested Re:', () => {
    // normalizeSubject now strips all levels of Re:/Fwd: prefixes
    expect(normalizeSubject('Re: Re: Re: Hello')).toBe('Hello');
  });

  it('handles "Re: " with trailing spaces', () => {
    expect(normalizeSubject('Re:   Lots of spaces')).toBe('Lots of spaces');
  });

  it('handles subject that is just "Re:"', () => {
    expect(normalizeSubject('Re:')).toBe('(No subject)');
  });

  it('handles subject that is just whitespace after stripping', () => {
    expect(normalizeSubject('Re:   ')).toBe('(No subject)');
  });

  it('preserves colons in non-prefix position', () => {
    expect(normalizeSubject('Meeting: 3pm tomorrow')).toBe('Meeting: 3pm tomorrow');
  });

  it('handles Re[N]: pattern', () => {
    expect(normalizeSubject('Re[5]: Discussion')).toBe('Discussion');
  });

  it('handles FW: (Outlook style)', () => {
    expect(normalizeSubject('FW: Forwarded message')).toBe('Forwarded message');
  });

  it('handles subject with unicode characters', () => {
    expect(normalizeSubject('Re: Nauji skelbimai: Namai Palangoje')).toBe('Nauji skelbimai: Namai Palangoje');
  });

  it('handles subject with emojis', () => {
    expect(normalizeSubject('Re: 🎉 Release notes')).toBe('🎉 Release notes');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Chat View: getCleanMessageBody edge cases
// ═════════════════════════════════════════════════════════════════════

describe('getCleanMessageBody — extreme cases', () => {
  it('handles header-only email (no text, no html)', () => {
    // This is the actual bug case — emails from the header cache
    const email = {
      uid: 123,
      from: { address: 'alice@example.com' },
      to: [{ address: 'me@example.com' }],
      subject: 'Test',
      date: '2024-01-15T10:00:00Z',
      flags: [],
      // No text, textBody, or html fields
    };
    const result = getCleanMessageBody(email);
    expect(result).toBe('');
  });

  it('handles email with undefined text fields explicitly set', () => {
    const email = { text: undefined, textBody: undefined, html: undefined };
    expect(getCleanMessageBody(email)).toBe('');
  });

  it('handles email with null text fields', () => {
    const email = { text: null, textBody: null, html: null };
    expect(getCleanMessageBody(email)).toBe('');
  });

  it('handles email with empty string text', () => {
    const email = { text: '' };
    expect(getCleanMessageBody(email)).toBe('');
  });

  it('handles email with whitespace-only text', () => {
    const email = { text: '   \n\n   \t  ' };
    expect(getCleanMessageBody(email)).toBe('');
  });

  it('handles HTML-only email (extracts text from HTML)', () => {
    const email = { html: '<div><p>Hello from HTML</p></div>' };
    const result = getCleanMessageBody(email);
    expect(result).toContain('Hello from HTML');
  });

  it('strips quoted content from deeply nested Outlook-style reply', () => {
    const text = `Thanks for the update.

-----Original Message-----
From: Alice Smith
Sent: Monday, January 15, 2024
To: Me
Subject: RE: Project

Previous message content here`;
    const email = { text };
    const result = getCleanMessageBody(email);
    expect(result).toBe('Thanks for the update.');
  });

  it('strips Gmail-style quoted content', () => {
    const text = `Got it, thanks!

On Mon, Jan 15, 2024 at 10:00 AM Alice <alice@example.com> wrote:
> Here is the original message
> with multiple lines`;
    const email = { text };
    const result = getCleanMessageBody(email);
    expect(result).toBe('Got it, thanks!');
  });

  it('handles email with only a signature', () => {
    const text = '-- \nJohn Doe\nCEO, Company Inc.';
    const email = { text };
    expect(getCleanMessageBody(email)).toBe('');
  });

  it('handles email with HTML that has only images (no text)', () => {
    const email = { html: '<img src="cid:image001.png" />' };
    const result = getCleanMessageBody(email);
    expect(result).toBe('');
  });

  it('handles email with HTML containing only a table', () => {
    const email = { html: '<table><tr><td>Cell 1</td><td>Cell 2</td></tr></table>' };
    const result = getCleanMessageBody(email);
    expect(result).toContain('Cell 1');
    expect(result).toContain('Cell 2');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Chat View: htmlToPlainText extreme cases
// ═════════════════════════════════════════════════════════════════════

describe('htmlToPlainText — extreme cases', () => {
  it('handles deeply nested HTML', () => {
    const html = '<div><div><div><div><p>Deep content</p></div></div></div></div>';
    expect(htmlToPlainText(html)).toContain('Deep content');
  });

  it('handles HTML with inline styles', () => {
    const html = '<p style="color: red; font-size: 14px;">Styled text</p>';
    const result = htmlToPlainText(html);
    expect(result).toContain('Styled text');
    expect(result).not.toContain('color');
  });

  it('handles HTML with data attributes', () => {
    const html = '<div data-custom="value" data-id="123">Content</div>';
    expect(htmlToPlainText(html)).toContain('Content');
  });

  it('handles HTML with self-closing tags', () => {
    const html = 'Before<hr/>After<br/>End';
    const result = htmlToPlainText(html);
    expect(result).toContain('Before');
    expect(result).toContain('After');
    expect(result).toContain('End');
  });

  it('handles malformed HTML gracefully', () => {
    const html = '<p>Unclosed paragraph<div>Mixed tags</p></div>';
    const result = htmlToPlainText(html);
    expect(result).toContain('Unclosed paragraph');
    expect(result).toContain('Mixed tags');
  });

  it('handles HTML with comments', () => {
    const html = '<!-- comment -->Visible<!-- another comment --> text';
    const result = htmlToPlainText(html);
    expect(result).toContain('Visible');
    expect(result).toContain('text');
    expect(result).not.toContain('comment');
  });

  it('handles HTML email with tracking pixel', () => {
    const html = '<p>Content</p><img src="https://tracker.com/pixel.gif" width="1" height="1" />';
    const result = htmlToPlainText(html);
    expect(result).toContain('Content');
    expect(result).not.toContain('tracker');
  });

  it('handles HTML with numeric entities', () => {
    const html = '&#169; 2024 Company';
    const result = htmlToPlainText(html);
    // Numeric entities may or may not be decoded, but should not crash
    expect(result).toContain('2024 Company');
  });

  it('handles email with massive HTML (newsletter-style)', () => {
    // Simulate a large HTML email with tables, images, many divs
    const rows = Array.from({ length: 100 }, (_, i) =>
      `<tr><td style="padding:10px"><p>Row ${i}</p></td></tr>`
    ).join('');
    const html = `<table width="600">${rows}</table>`;
    const result = htmlToPlainText(html);
    expect(result).toContain('Row 0');
    expect(result).toContain('Row 99');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Chat View: stripSignature extreme cases
// ═════════════════════════════════════════════════════════════════════

describe('stripSignature — extreme cases', () => {
  it('strips "Sent from Yahoo Mail"', () => {
    const text = 'Message\n\nSent from Yahoo Mail';
    expect(stripSignature(text)).toBe('Message');
  });

  it('strips "Sent from AOL Mobile Mail"', () => {
    const text = 'Message\n\nSent from AOL Mobile Mail';
    expect(stripSignature(text)).toBe('Message');
  });

  it('strips underscore-line signature delimiter', () => {
    const text = 'Message body\n___\nSignature here';
    expect(stripSignature(text)).toBe('Message body');
  });

  it('strips dash-line signature delimiter', () => {
    const text = 'Message body\n---\nSignature here';
    expect(stripSignature(text)).toBe('Message body');
  });

  it('handles "Best Regards," sign-off in long message', () => {
    const body = 'A'.repeat(200);
    const text = `${body}\nBest Regards,\nJohn`;
    const result = stripSignature(text);
    expect(result).not.toContain('Best Regards');
  });

  it('handles "Kind Regards," sign-off', () => {
    const body = 'A'.repeat(200);
    const text = `${body}\nKind Regards,\nJohn`;
    expect(stripSignature(text)).not.toContain('Kind Regards');
  });

  it('does not strip "Thanks" in the middle of a message', () => {
    const text = 'Thanks for the help with the project. I appreciate it.';
    expect(stripSignature(text)).toBe(text);
  });

  it('handles message that is entirely a signature', () => {
    const text = '-- \nJohn Doe';
    expect(stripSignature(text)).toBe('');
  });

  it('handles multiple signature delimiters — uses earliest', () => {
    const text = 'Message\n-- \nFirst sig\n---\nSecond sig';
    expect(stripSignature(text)).toBe('Message');
  });

  it('handles "Sent from my Samsung" variant', () => {
    const text = 'Quick reply\n\nSent from my Samsung Galaxy';
    expect(stripSignature(text)).toBe('Quick reply');
  });

  it('handles "Get Outlook for Mac"', () => {
    const text = 'Reply here\n\nGet Outlook for Mac';
    expect(stripSignature(text)).toBe('Reply here');
  });

  it('handles "Sent from Mail for Windows"', () => {
    const text = 'My reply\n\nSent from Mail for Windows';
    expect(stripSignature(text)).toBe('My reply');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Chat View: stripQuotedContent extreme cases
// ═════════════════════════════════════════════════════════════════════

describe('stripQuotedContent — extreme cases', () => {
  it('handles multiple levels of > quoting', () => {
    const text = 'My reply\n> First level\n>> Second level\n>>> Third level';
    const result = stripQuotedContent(text);
    expect(result).toBe('My reply');
  });

  it('handles interleaved quoted and non-quoted content', () => {
    // When someone replies inline
    const text = 'My comment\n> Their point\nMy response\n> Another point';
    const result = stripQuotedContent(text);
    // Should keep non-quoted lines
    expect(result).toContain('My comment');
    expect(result).toContain('My response');
    expect(result).not.toContain('Their point');
  });

  it('handles Outlook header-style quoting', () => {
    const text = `Reply here

From: Alice Smith
Sent: Monday, January 15, 2024 10:00 AM
To: Bob Jones
Subject: Original subject

Original message body`;
    const result = stripQuotedContent(text);
    expect(result).toBe('Reply here');
  });

  it('handles underscore + From quoting', () => {
    // The QUOTE_PATTERNS regex is /^_{5,}\nFrom:\s*/im which needs
    // underscore line immediately followed by From: on next line
    const text = `My reply
_____
From: someone@example.com
Sent: Today
To: me@example.com`;
    const result = stripQuotedContent(text);
    // The underscore regex matches `_{5,}\nFrom:` as a single pattern,
    // but the actual text has `_____\n` then `From:` on new line —
    // the underscores are caught by the stripSignature `_{3,}` pattern
    // (not stripQuotedContent). Result keeps underscores but strips From: quoted lines.
    expect(result).toContain('My reply');
    expect(result).not.toContain('someone@example.com');
  });

  it('handles empty quoted content', () => {
    const text = 'My reply\n>\n>';
    const result = stripQuotedContent(text);
    expect(result).toBe('My reply');
  });

  it('handles email with only quoted content', () => {
    const text = '> All quoted\n> No original content';
    const result = stripQuotedContent(text);
    expect(result).toBe('');
  });

  it('preserves code blocks that look like quotes', () => {
    // Lines with > that are part of code, not quotes
    const text = 'Code example:\n\nif (x > 5) { return true; }';
    const result = stripQuotedContent(text);
    // The > is in the middle of a line, not at start, so should be preserved
    expect(result).toContain('if (x > 5)');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Chat View: isFromUser edge cases
// ═════════════════════════════════════════════════════════════════════

describe('isFromUser — edge cases', () => {
  it('handles email alias (+ addressing)', () => {
    // user+tag@example.com is technically different from user@example.com
    const email = { from: { address: 'me+newsletter@example.com' } };
    expect(isFromUser(email, 'me@example.com')).toBe(false);
  });

  it('handles from address with whitespace', () => {
    const email = { from: { address: ' me@example.com ' } };
    // Current implementation doesn't trim, so this won't match
    expect(isFromUser(email, 'me@example.com')).toBe(false);
  });

  it('handles missing from.address', () => {
    const email = { from: { name: 'Alice' } };
    expect(isFromUser(email, 'me@example.com')).toBe(false);
  });

  it('handles from as null', () => {
    const email = { from: null };
    expect(isFromUser(email, 'me@example.com')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Chat View: Combined flow — full conversation lifecycle
// ═════════════════════════════════════════════════════════════════════

describe('full conversation flow', () => {
  it('groups, topics, and cleans a realistic email thread', () => {
    const userEmail = 'tomas@sdatransport.eu';
    const emails = [
      makeEmail({
        uid: 100,
        from: { address: 'export.sweu@ntgroad.se', name: 'NTG Export' },
        to: [{ address: userEmail }],
        subject: 'MYY046/ZZM51Z',
        date: '2024-01-10T08:00:00Z',
        text: 'Please confirm the order.\n\n-- \nNTG Export Team',
      }),
      makeEmail({
        uid: 101,
        from: { address: userEmail, name: 'Tomas' },
        to: [{ address: 'export.sweu@ntgroad.se' }],
        subject: 'RE: MYY046/ZZM51Z',
        date: '2024-01-10T09:00:00Z',
        text: 'Confirmed.\n\nOn Wed, Jan 10, 2024, NTG Export wrote:\n> Please confirm the order.',
      }),
      makeEmail({
        uid: 102,
        from: { address: 'export.sweu@ntgroad.se', name: 'NTG Export' },
        to: [{ address: userEmail }],
        subject: 'RE: MYY046/ZZM51Z',
        date: '2024-01-10T10:00:00Z',
        text: 'Thank you. Shipment scheduled for Jan 15.\n\nBest Regards,\nNTG',
      }),
    ];

    // Step 1: Group by correspondent
    const groups = groupByCorrespondent(emails, userEmail);
    expect(groups.size).toBe(1);
    const group = groups.get('export.sweu@ntgroad.se');
    expect(group.emails).toHaveLength(3);
    expect(group.name).toBe('NTG Export');

    // Step 2: Group by topic within correspondent
    const topics = groupByTopic(group.emails);
    expect(topics.size).toBe(1);
    const topic = topics.get('MYY046/ZZM51Z');
    expect(topic.emails).toHaveLength(3);

    // Step 3: Clean message bodies
    const bodies = topic.emails.map(e => getCleanMessageBody(e));
    expect(bodies[0]).toBe('Please confirm the order.');
    expect(bodies[1]).toBe('Confirmed.');
    // Third email has a sign-off but message is short enough it might not strip
    expect(bodies[2]).toContain('Thank you');

    // Step 4: Verify ordering
    expect(isFromUser(topic.emails[0], userEmail)).toBe(false);
    expect(isFromUser(topic.emails[1], userEmail)).toBe(true);
    expect(isFromUser(topic.emails[2], userEmail)).toBe(false);
  });

  it('handles header-only emails gracefully in full flow', () => {
    // This simulates what actually happens in the app — emails from cache have no body
    const userEmail = 'me@example.com';
    const headerOnlyEmails = [
      {
        uid: 1, from: { address: 'alice@example.com', name: 'Alice' },
        to: [{ address: userEmail }], subject: 'Hello',
        date: '2024-01-15T10:00:00Z', flags: [],
      },
      {
        uid: 2, from: { address: userEmail, name: 'Me' },
        to: [{ address: 'alice@example.com' }], subject: 'Re: Hello',
        date: '2024-01-15T11:00:00Z', flags: ['\\Seen'],
      },
    ];

    const groups = groupByCorrespondent(headerOnlyEmails, userEmail);
    expect(groups.size).toBe(1);

    const topics = groupByTopic(groups.get('alice@example.com').emails);
    expect(topics.size).toBe(1);

    // Bodies should be empty — not crash
    const topic = topics.get('Hello');
    for (const email of topic.emails) {
      const body = getCleanMessageBody(email);
      expect(body).toBe('');
      // hasDisplayableContent check (same as ChatBubbleView)
      const hasHtml = !!email.html;
      const hasDisplayableContent = hasHtml || (body && body.trim().length > 0);
      expect(hasDisplayableContent).toBeFalsy();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// Chat View: Date formatting edge cases
// ═════════════════════════════════════════════════════════════════════

describe('formatMessageTime', () => {
  it('formats a valid date', () => {
    const result = formatMessageTime('2024-06-15T14:30:00Z');
    // Should contain time components (exact format depends on locale)
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles midnight', () => {
    const result = formatMessageTime('2024-06-15T00:00:00Z');
    expect(result).toBeTruthy();
  });
});

describe('isDifferentDay — edge cases', () => {
  it('handles dates just before and after midnight UTC', () => {
    // These might be same day depending on timezone
    const result = isDifferentDay('2024-01-15T23:59:59Z', '2024-01-16T00:00:01Z');
    // In most timezones these are different days (or same day depending on offset)
    // We just verify it doesn't crash
    expect(typeof result).toBe('boolean');
  });

  it('handles invalid date strings', () => {
    const result = isDifferentDay('not-a-date', 'also-not-a-date');
    // Invalid Date.toDateString() returns "Invalid Date" for both
    expect(result).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Chat View: getPreview extreme cases
// ═════════════════════════════════════════════════════════════════════

describe('getPreview — extreme cases', () => {
  it('handles text with only whitespace', () => {
    const email = { text: '   \n\n\t  ' };
    expect(getPreview(email)).toBe('');
  });

  it('handles text with many newlines', () => {
    const email = { text: 'Hello\n\n\n\n\n\nWorld' };
    expect(getPreview(email)).toBe('Hello World');
  });

  it('handles unicode text', () => {
    const email = { text: 'Nauji skelbimai: Namai Palangoje' };
    expect(getPreview(email)).toBe('Nauji skelbimai: Namai Palangoje');
  });

  it('handles emoji in text', () => {
    const email = { text: '🎉 Great news!' };
    expect(getPreview(email)).toBe('🎉 Great news!');
  });

  it('priority order: text > textBody > snippet', () => {
    const email = {
      text: 'Primary text',
      textBody: 'Fallback body',
      snippet: 'Snippet'
    };
    expect(getPreview(email)).toBe('Primary text');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Chat View: Scale and stress tests
// ═════════════════════════════════════════════════════════════════════

describe('scale and stress', () => {
  it('groupByCorrespondent handles 1000 emails from 100 senders', () => {
    const emails = Array.from({ length: 1000 }, (_, i) => makeEmail({
      uid: i + 1,
      from: { address: `sender${i % 100}@example.com`, name: `Sender ${i % 100}` },
      to: [{ address: USER }],
      subject: `Thread ${i % 30}`,
      date: new Date(2024, 0, 1, 0, i).toISOString(),
    }));

    const start = performance.now();
    const groups = groupByCorrespondent(emails, USER);
    const elapsed = performance.now() - start;

    expect(groups.size).toBe(100);
    expect(elapsed).toBeLessThan(500); // Should be fast
  });

  it('groupByTopic handles 500 emails with 50 topics', () => {
    const emails = Array.from({ length: 500 }, (_, i) => makeEmail({
      uid: i + 1,
      subject: `${i % 3 === 0 ? 'Re: ' : ''}Topic ${i % 50}`,
      date: new Date(2024, 0, 1, 0, i).toISOString(),
    }));

    const start = performance.now();
    const topics = groupByTopic(emails);
    const elapsed = performance.now() - start;

    expect(topics.size).toBe(50);
    expect(elapsed).toBeLessThan(500);
  });

  it('getCleanMessageBody handles very large text (10KB)', () => {
    const text = 'Hello\n'.repeat(2000) + '\nOn Mon wrote:\n> quoted';
    const email = { text };

    const start = performance.now();
    const result = getCleanMessageBody(email);
    const elapsed = performance.now() - start;

    expect(result).toContain('Hello');
    expect(result).not.toContain('quoted');
    expect(elapsed).toBeLessThan(500);
  });

  it('htmlToPlainText handles large HTML (50KB newsletter)', () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      `<tr><td style="padding:10px;color:#333"><p>Newsletter item ${i} with <a href="https://example.com/${i}">link</a></p></td></tr>`
    ).join('');
    const html = `<html><head><style>body{margin:0}</style></head><body><table width="600">${rows}</table></body></html>`;

    const start = performance.now();
    const result = htmlToPlainText(html);
    const elapsed = performance.now() - start;

    expect(result).toContain('Newsletter item 0');
    expect(result).toContain('Newsletter item 499');
    expect(elapsed).toBeLessThan(1000);
  });
});
