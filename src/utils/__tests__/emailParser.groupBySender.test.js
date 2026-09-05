import { describe, it, expect } from 'vitest';
import { groupBySender } from '../emailParser';

const mk = (over = {}) => ({
  uid: 1,
  messageId: '<x@example.com>',
  subject: 'Contact form — Robertgat',
  date: '2026-07-01T10:00:00Z',
  from: { address: 'forms@example.com', name: 'Contact form' },
  to: [{ address: 'me@example.com' }],
  flags: ['\\Seen'],
  ...over,
});

describe('groupBySender topic identity', () => {
  // Five identical-subject contact-form messages from one sender are five
  // separate threads (buildThreads only merges reply-like orphans by subject).
  // Keying their topics by subject collapses them onto one key.
  it('gives same-sender same-subject threads distinct topic ids', () => {
    const emails = [
      mk({ uid: 1, messageId: '<a@example.com>', date: '2026-07-01T10:00:00Z' }),
      mk({ uid: 2, messageId: '<b@example.com>', date: '2026-07-02T10:00:00Z' }),
    ];
    const groups = groupBySender(emails, 'me@example.com');
    expect(groups.length).toBe(1);
    const topics = groups[0].topics;
    expect(topics.length).toBe(2);
    expect(topics[0].topicId).toBeTruthy();
    expect(topics[1].topicId).toBeTruthy();
    expect(topics[0].topicId).not.toBe(topics[1].topicId);
  });

  it('gives every topic an id on the no-userEmail fallback path too', () => {
    const emails = [
      mk({ uid: 1, messageId: '<a@example.com>', subject: 'One' }),
      mk({ uid: 2, messageId: '<b@example.com>', subject: 'Two' }),
    ];
    const groups = groupBySender(emails);
    const topics = groups[0].topics;
    expect(topics.length).toBe(2);
    expect(new Set(topics.map(t => t.topicId)).size).toBe(2);
  });
});
