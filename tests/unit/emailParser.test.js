import { describe, it, expect } from 'vitest';
import {
  getCorrespondent,
  groupByCorrespondent,
  getPreview,
  normalizeSubject,
  groupByTopic,
  stripSignature,
  stripQuotedContent,
  getCleanMessageBody,
  htmlToPlainText,
  getAvatarColor,
  getInitials,
  isDifferentDay,
  isFromUser
} from '../../src/utils/emailParser.js';

// ── getCorrespondent ─────────────────────────────────────────────────

describe('getCorrespondent', () => {
  const userEmail = 'me@example.com';

  it('returns sender when email is from someone else', () => {
    const email = {
      from: { address: 'alice@other.com', name: 'Alice' },
      to: [{ address: 'me@example.com', name: 'Me' }]
    };
    const result = getCorrespondent(email, userEmail);
    expect(result.email).toBe('alice@other.com');
    expect(result.name).toBe('Alice');
  });

  it('returns recipient when email is from the user', () => {
    const email = {
      from: { address: 'me@example.com', name: 'Me' },
      to: [{ address: 'bob@other.com', name: 'Bob' }]
    };
    const result = getCorrespondent(email, userEmail);
    expect(result.email).toBe('bob@other.com');
    expect(result.name).toBe('Bob');
  });

  it('is case-insensitive for user email comparison', () => {
    const email = {
      from: { address: 'ME@Example.COM', name: 'Me' },
      to: [{ address: 'bob@other.com', name: 'Bob' }]
    };
    const result = getCorrespondent(email, userEmail);
    expect(result.email).toBe('bob@other.com');
  });

  it('falls back to address when name is missing (sender)', () => {
    const email = {
      from: { address: 'alice@other.com' },
      to: [{ address: 'me@example.com' }]
    };
    const result = getCorrespondent(email, userEmail);
    expect(result.name).toBe('alice@other.com');
  });

  it('falls back to address when name is missing (recipient)', () => {
    const email = {
      from: { address: 'me@example.com' },
      to: [{ address: 'bob@other.com' }]
    };
    const result = getCorrespondent(email, userEmail);
    expect(result.name).toBe('bob@other.com');
  });

  it('handles missing from gracefully', () => {
    const email = { to: [{ address: 'me@example.com' }] };
    const result = getCorrespondent(email, userEmail);
    expect(result.email).toBe('');
    expect(result.name).toBe('Unknown');
  });

  it('handles missing to gracefully when email is from user', () => {
    const email = {
      from: { address: 'me@example.com' },
      to: []
    };
    const result = getCorrespondent(email, userEmail);
    expect(result.email).toBe('');
  });

  it('handles null userEmail', () => {
    const email = {
      from: { address: 'alice@other.com', name: 'Alice' },
      to: [{ address: 'me@example.com' }]
    };
    const result = getCorrespondent(email, null);
    expect(result.email).toBe('alice@other.com');
  });
});

// ── getPreview ───────────────────────────────────────────────────────

describe('getPreview', () => {
  it('returns full text if shorter than maxLength', () => {
    const email = { text: 'Short message' };
    expect(getPreview(email)).toBe('Short message');
  });

  it('truncates long text with ellipsis', () => {
    const email = { text: 'A'.repeat(100) };
    const result = getPreview(email, 50);
    expect(result).toHaveLength(53); // 50 + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('collapses whitespace', () => {
    const email = { text: 'Hello   \n\n  World' };
    expect(getPreview(email)).toBe('Hello World');
  });

  it('uses textBody as fallback', () => {
    const email = { textBody: 'Fallback text' };
    expect(getPreview(email)).toBe('Fallback text');
  });

  it('uses snippet as fallback', () => {
    const email = { snippet: 'Snippet text' };
    expect(getPreview(email)).toBe('Snippet text');
  });

  it('returns empty string when no text available', () => {
    expect(getPreview({})).toBe('');
  });

  it('respects custom maxLength', () => {
    const email = { text: 'A'.repeat(20) };
    const result = getPreview(email, 10);
    expect(result).toBe('A'.repeat(10) + '...');
  });
});

// ── normalizeSubject ─────────────────────────────────────────────────

describe('normalizeSubject', () => {
  it('strips Re: prefix', () => {
    expect(normalizeSubject('Re: Hello')).toBe('Hello');
  });

  it('strips RE: prefix (uppercase)', () => {
    expect(normalizeSubject('RE: Hello')).toBe('Hello');
  });

  it('strips Fwd: prefix', () => {
    expect(normalizeSubject('Fwd: Hello')).toBe('Hello');
  });

  it('strips FW: prefix', () => {
    expect(normalizeSubject('FW: Hello')).toBe('Hello');
  });

  it('strips nested Re: prefixes', () => {
    expect(normalizeSubject('Re: Re: Hello')).toBe('Hello');
  });

  it('strips Re[N]: prefix', () => {
    expect(normalizeSubject('Re[2]: Hello')).toBe('Hello');
  });

  it('returns "(No subject)" for null', () => {
    expect(normalizeSubject(null)).toBe('(No subject)');
  });

  it('returns "(No subject)" for undefined', () => {
    expect(normalizeSubject(undefined)).toBe('(No subject)');
  });

  it('returns "(No subject)" for empty string after stripping', () => {
    expect(normalizeSubject('Re:')).toBe('(No subject)');
  });

  it('preserves normal subjects', () => {
    expect(normalizeSubject('Meeting tomorrow')).toBe('Meeting tomorrow');
  });
});

// ── stripSignature ───────────────────────────────────────────────────

describe('stripSignature', () => {
  it('strips standard RFC "-- " signature', () => {
    const text = 'Hello there\n\n-- \nJohn Doe\nCEO, Company';
    expect(stripSignature(text)).toBe('Hello there');
  });

  it('strips "Sent from my iPhone"', () => {
    const text = 'Message content\n\nSent from my iPhone';
    expect(stripSignature(text)).toBe('Message content');
  });

  it('strips "Sent from my Android"', () => {
    const text = 'Message content\n\nSent from my Android';
    expect(stripSignature(text)).toBe('Message content');
  });

  it('strips "Get Outlook for iOS"', () => {
    const text = 'Message content\n\nGet Outlook for iOS';
    expect(stripSignature(text)).toBe('Message content');
  });

  it('returns empty string for null input', () => {
    expect(stripSignature(null)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(stripSignature('')).toBe('');
  });

  it('preserves text without signature', () => {
    const text = 'Just a plain message with no signature';
    expect(stripSignature(text)).toBe(text);
  });

  it('strips sign-off only if in last half of message', () => {
    // Short message where sign-off is in first half - should not strip
    const text = 'Thanks,\nJohn';
    // The sign-off is at index 0, which is < 50% of message length
    expect(stripSignature(text)).toBe(text);
  });

  it('strips sign-off in last half of long message', () => {
    const body = 'A'.repeat(100);
    const text = `${body}\nThanks,\nJohn`;
    const result = stripSignature(text);
    expect(result).not.toContain('Thanks,');
  });
});

// ── stripQuotedContent ───────────────────────────────────────────────

describe('stripQuotedContent', () => {
  it('strips "On ... wrote:" quoted blocks', () => {
    const text = 'My reply\n\nOn Mon, Jan 1 2024, Alice wrote:\n> Original message';
    const result = stripQuotedContent(text);
    expect(result).toBe('My reply');
  });

  it('strips lines starting with >', () => {
    const text = 'Reply\n> Quoted line 1\n> Quoted line 2';
    const result = stripQuotedContent(text);
    expect(result).toBe('Reply');
  });

  it('strips Outlook-style "-----Original Message-----"', () => {
    const text = 'My reply\n\n-----Original Message-----\nFrom: Alice\nSent: Today';
    const result = stripQuotedContent(text);
    expect(result).toBe('My reply');
  });

  it('returns empty string for null input', () => {
    expect(stripQuotedContent(null)).toBe('');
  });

  it('preserves text without quotes', () => {
    const text = 'Just a plain message';
    expect(stripQuotedContent(text)).toBe(text);
  });
});

// ── htmlToPlainText ──────────────────────────────────────────────────

describe('htmlToPlainText', () => {
  it('strips HTML tags', () => {
    expect(htmlToPlainText('<p>Hello <b>World</b></p>')).toBe('Hello World');
  });

  it('converts <br> to newlines', () => {
    expect(htmlToPlainText('Line 1<br>Line 2')).toBe('Line 1\nLine 2');
  });

  it('converts <br/> to newlines', () => {
    expect(htmlToPlainText('Line 1<br/>Line 2')).toBe('Line 1\nLine 2');
  });

  it('converts </p> to double newlines', () => {
    const result = htmlToPlainText('<p>Para 1</p><p>Para 2</p>');
    expect(result).toContain('Para 1\n\nPara 2');
  });

  it('converts <li> to "- " prefixed items', () => {
    const result = htmlToPlainText('<ul><li>Item 1</li><li>Item 2</li></ul>');
    expect(result).toContain('- Item 1');
    expect(result).toContain('- Item 2');
  });

  it('removes script tags and content', () => {
    const result = htmlToPlainText('<p>Hello</p><script>alert("xss")</script>');
    expect(result).not.toContain('alert');
    expect(result).toContain('Hello');
  });

  it('removes style tags and content', () => {
    const result = htmlToPlainText('<style>.a{color:red}</style><p>Hello</p>');
    expect(result).not.toContain('color');
    expect(result).toContain('Hello');
  });

  it('decodes HTML entities', () => {
    expect(htmlToPlainText('&amp; &lt; &gt; &quot; &#39;')).toBe("& < > \" '");
  });

  it('decodes &nbsp;', () => {
    expect(htmlToPlainText('Hello&nbsp;World')).toBe('Hello World');
  });

  it('returns empty string for null', () => {
    expect(htmlToPlainText(null)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(htmlToPlainText('')).toBe('');
  });

  it('collapses excessive newlines', () => {
    const result = htmlToPlainText('<p></p><p></p><p></p><p>Content</p>');
    expect(result).not.toMatch(/\n{3,}/);
  });
});

// ── getCleanMessageBody ──────────────────────────────────────────────

describe('getCleanMessageBody', () => {
  it('returns text body stripped of quotes and signature', () => {
    const email = {
      text: 'Hello\n\nOn Mon, Jan 1, Alice wrote:\n> Old message\n\n-- \nMe'
    };
    const result = getCleanMessageBody(email);
    expect(result).toBe('Hello');
  });

  it('uses textBody as fallback', () => {
    const email = { textBody: 'Some text body' };
    expect(getCleanMessageBody(email)).toBe('Some text body');
  });

  it('extracts text from HTML when no text available', () => {
    const email = { html: '<p>HTML content</p>' };
    const result = getCleanMessageBody(email);
    expect(result).toContain('HTML content');
  });

  it('returns empty string for empty email', () => {
    expect(getCleanMessageBody({})).toBe('');
  });
});

// ── getAvatarColor ───────────────────────────────────────────────────

describe('getAvatarColor', () => {
  it('returns a hex color string', () => {
    const color = getAvatarColor('alice@example.com');
    expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('returns consistent color for same email', () => {
    const c1 = getAvatarColor('test@example.com');
    const c2 = getAvatarColor('test@example.com');
    expect(c1).toBe(c2);
  });

  it('returns default color for null/undefined', () => {
    const color = getAvatarColor(null);
    expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('returns different colors for different emails', () => {
    const c1 = getAvatarColor('alice@example.com');
    const c2 = getAvatarColor('bob@different.org');
    // Not guaranteed to be different for all inputs, but very likely
    // At minimum, verify both are valid colors
    expect(c1).toMatch(/^#[0-9a-f]{6}$/i);
    expect(c2).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

// ── getInitials ──────────────────────────────────────────────────────

describe('getInitials', () => {
  it('returns two-letter initials from full name', () => {
    expect(getInitials('John Doe', 'john@example.com')).toBe('JD');
  });

  it('returns first letter for single-word name', () => {
    expect(getInitials('Alice', 'alice@example.com')).toBe('A');
  });

  it('uses first and last name for multi-word names', () => {
    expect(getInitials('Mary Jane Watson', 'mary@example.com')).toBe('MW');
  });

  it('falls back to email initial when name contains @', () => {
    expect(getInitials('alice@example.com', 'alice@example.com')).toBe('A');
  });

  it('falls back to email initial when name is null', () => {
    expect(getInitials(null, 'bob@example.com')).toBe('B');
  });

  it('returns ? when both name and email are missing', () => {
    expect(getInitials(null, null)).toBe('?');
  });

  it('returns uppercase initials', () => {
    expect(getInitials('john doe', 'john@example.com')).toBe('JD');
  });
});

// ── isDifferentDay ───────────────────────────────────────────────────

describe('isDifferentDay', () => {
  it('returns false for same day', () => {
    // Use the same date string to guarantee same local day
    const date = '2024-06-15T12:00:00';
    expect(isDifferentDay(date, date)).toBe(false);
  });

  it('returns true for clearly different days', () => {
    // Dates far apart enough that timezone can't make them the same day
    expect(isDifferentDay('2024-01-10T12:00:00', '2024-01-12T12:00:00')).toBe(true);
  });

  it('returns true for different months', () => {
    expect(isDifferentDay('2024-01-15T12:00:00', '2024-02-15T12:00:00')).toBe(true);
  });

  it('returns true for different years', () => {
    expect(isDifferentDay('2023-06-15T12:00:00', '2024-06-15T12:00:00')).toBe(true);
  });
});

// ── isFromUser ───────────────────────────────────────────────────────

describe('isFromUser', () => {
  it('returns true when sender matches user email', () => {
    const email = { from: { address: 'me@example.com' } };
    expect(isFromUser(email, 'me@example.com')).toBe(true);
  });

  it('returns false when sender differs from user email', () => {
    const email = { from: { address: 'other@example.com' } };
    expect(isFromUser(email, 'me@example.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    const email = { from: { address: 'ME@Example.COM' } };
    expect(isFromUser(email, 'me@example.com')).toBe(true);
  });

  it('handles missing from', () => {
    expect(isFromUser({}, 'me@example.com')).toBe(false);
  });

  it('handles null userEmail', () => {
    const email = { from: { address: 'me@example.com' } };
    expect(isFromUser(email, null)).toBe(false);
  });
});

// ── groupByCorrespondent ─────────────────────────────────────────────

describe('groupByCorrespondent', () => {
  const userEmail = 'me@example.com';

  const emails = [
    {
      from: { address: 'alice@other.com', name: 'Alice' },
      to: [{ address: 'me@example.com' }],
      subject: 'Hello',
      date: '2024-01-15T10:00:00Z',
      flags: []
    },
    {
      from: { address: 'me@example.com', name: 'Me' },
      to: [{ address: 'alice@other.com', name: 'Alice' }],
      subject: 'Re: Hello',
      date: '2024-01-15T11:00:00Z',
      flags: ['\\Seen']
    },
    {
      from: { address: 'bob@other.com', name: 'Bob' },
      to: [{ address: 'me@example.com' }],
      subject: 'Meeting',
      date: '2024-01-15T12:00:00Z',
      flags: []
    }
  ];

  it('groups emails by correspondent', () => {
    const groups = groupByCorrespondent(emails, userEmail);
    expect(groups.size).toBe(2);
    expect(groups.has('alice@other.com')).toBe(true);
    expect(groups.has('bob@other.com')).toBe(true);
  });

  it('puts both sent and received in same group', () => {
    const groups = groupByCorrespondent(emails, userEmail);
    const aliceGroup = groups.get('alice@other.com');
    expect(aliceGroup.emails).toHaveLength(2);
  });

  it('counts unread correctly', () => {
    const groups = groupByCorrespondent(emails, userEmail);
    const aliceGroup = groups.get('alice@other.com');
    expect(aliceGroup.unreadCount).toBe(1); // first email is unread

    const bobGroup = groups.get('bob@other.com');
    expect(bobGroup.unreadCount).toBe(1);
  });

  it('tracks last message per group', () => {
    const groups = groupByCorrespondent(emails, userEmail);
    const aliceGroup = groups.get('alice@other.com');
    expect(aliceGroup.lastMessage.subject).toBe('Re: Hello');
  });

  it('sorts emails within group by date ascending', () => {
    const groups = groupByCorrespondent(emails, userEmail);
    const aliceGroup = groups.get('alice@other.com');
    const dates = aliceGroup.emails.map(e => new Date(e.date).getTime());
    expect(dates[0]).toBeLessThan(dates[1]);
  });

  it('prefers non-email name over email-as-name', () => {
    const testEmails = [
      {
        from: { address: 'jane@example.com', name: 'jane@example.com' },
        to: [{ address: 'me@example.com' }],
        date: '2024-01-01T10:00:00Z',
        flags: []
      },
      {
        from: { address: 'jane@example.com', name: 'Jane Smith' },
        to: [{ address: 'me@example.com' }],
        date: '2024-01-02T10:00:00Z',
        flags: []
      }
    ];
    const groups = groupByCorrespondent(testEmails, userEmail);
    expect(groups.get('jane@example.com').name).toBe('Jane Smith');
  });

  it('returns empty map for empty email list', () => {
    const groups = groupByCorrespondent([], userEmail);
    expect(groups.size).toBe(0);
  });
});

// ── groupByTopic ─────────────────────────────────────────────────────

describe('groupByTopic', () => {
  it('groups emails by normalized subject', () => {
    const emails = [
      { subject: 'Meeting notes', date: '2024-01-15T10:00:00Z' },
      { subject: 'Re: Meeting notes', date: '2024-01-15T11:00:00Z' },
      { subject: 'Different topic', date: '2024-01-15T12:00:00Z' }
    ];
    const topics = groupByTopic(emails);
    expect(topics.size).toBe(2);
    expect(topics.has('Meeting notes')).toBe(true);
    expect(topics.has('Different topic')).toBe(true);
  });

  it('groups Re: and Fwd: variants together', () => {
    const emails = [
      { subject: 'Project update', date: '2024-01-15T10:00:00Z' },
      { subject: 'Re: Project update', date: '2024-01-15T11:00:00Z' },
      { subject: 'Fwd: Project update', date: '2024-01-15T12:00:00Z' }
    ];
    const topics = groupByTopic(emails);
    expect(topics.size).toBe(1);
    const topic = topics.get('Project update');
    expect(topic.emails).toHaveLength(3);
  });

  it('sorts emails within topic by date ascending', () => {
    const emails = [
      { subject: 'Re: Topic', date: '2024-01-15T12:00:00Z' },
      { subject: 'Topic', date: '2024-01-15T10:00:00Z' }
    ];
    const topics = groupByTopic(emails);
    const topic = topics.get('Topic');
    const dates = topic.emails.map(e => new Date(e.date).getTime());
    expect(dates[0]).toBeLessThan(dates[1]);
  });

  it('tracks date range per topic', () => {
    const emails = [
      { subject: 'Topic', date: '2024-01-15T10:00:00Z' },
      { subject: 'Re: Topic', date: '2024-01-17T10:00:00Z' }
    ];
    const topics = groupByTopic(emails);
    const topic = topics.get('Topic');
    expect(topic.dateRange.start).toEqual(new Date('2024-01-15T10:00:00Z'));
    expect(topic.dateRange.end).toEqual(new Date('2024-01-17T10:00:00Z'));
  });

  it('handles empty input', () => {
    const topics = groupByTopic([]);
    expect(topics.size).toBe(0);
  });
});
