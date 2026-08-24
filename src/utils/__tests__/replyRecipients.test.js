import { describe, it, expect } from 'vitest';
import { computeReplyRecipients } from '../emailParser';

const msg = ({ from, replyTo, to = [], cc = [] } = {}) => ({
  from: from ? { address: from } : undefined,
  replyTo: replyTo ? [{ address: replyTo }] : undefined,
  to: to.map(address => ({ address })),
  cc: cc.map(address => ({ address })),
});

const OWN = ['me@fastmail.com', 'alias@mydomain.com'];

describe('computeReplyRecipients — reply', () => {
  it('replies to the sender', () => {
    const r = computeReplyRecipients(msg({ from: 'them@x.com', to: ['me@fastmail.com'] }), 'reply', OWN);
    expect(r).toEqual({ to: 'them@x.com', cc: '' });
  });

  it('prefers the Reply-To header over From', () => {
    const r = computeReplyRecipients(
      msg({ from: 'them@x.com', replyTo: 'list@x.com', to: ['me@fastmail.com'] }),
      'reply',
      OWN
    );
    expect(r.to).toBe('list@x.com');
  });

  it('replying to my own message targets its recipients, not me', () => {
    const r = computeReplyRecipients(
      msg({ from: 'me@fastmail.com', to: ['them@x.com'] }),
      'reply',
      OWN
    );
    expect(r).toEqual({ to: 'them@x.com', cc: '' });
  });

  it('replying to my own message sent from an alias also targets its recipients', () => {
    const r = computeReplyRecipients(
      msg({ from: 'alias@mydomain.com', to: ['them@x.com', 'other@y.com'] }),
      'reply',
      OWN
    );
    expect(r.to).toBe('them@x.com, other@y.com');
  });

  it('drops my own addresses from the recipient list of my own message', () => {
    const r = computeReplyRecipients(
      msg({ from: 'me@fastmail.com', to: ['alias@mydomain.com', 'them@x.com'] }),
      'reply',
      OWN
    );
    expect(r.to).toBe('them@x.com');
  });

  it('a true note-to-self still replies to me', () => {
    const r = computeReplyRecipients(
      msg({ from: 'me@fastmail.com', to: ['me@fastmail.com'] }),
      'reply',
      OWN
    );
    expect(r.to).toBe('me@fastmail.com');
  });

  it('matches own addresses case-insensitively', () => {
    const r = computeReplyRecipients(
      msg({ from: 'Me@Fastmail.com', to: ['them@x.com'] }),
      'reply',
      OWN
    );
    expect(r.to).toBe('them@x.com');
  });
});

describe('computeReplyRecipients — replyAll', () => {
  it('targets sender plus recipients, minus every own identity', () => {
    const r = computeReplyRecipients(
      msg({ from: 'them@x.com', to: ['me@fastmail.com', 'other@y.com'], cc: ['cc@z.com', 'alias@mydomain.com'] }),
      'replyAll',
      OWN
    );
    expect(r).toEqual({ to: 'them@x.com, other@y.com', cc: 'cc@z.com' });
  });

  it('does not duplicate a sender who is also in To', () => {
    const r = computeReplyRecipients(
      msg({ from: 'them@x.com', to: ['them@x.com', 'other@y.com'] }),
      'replyAll',
      OWN
    );
    expect(r.to).toBe('them@x.com, other@y.com');
  });

  it('reply-all on my own message excludes me and keeps everyone else', () => {
    const r = computeReplyRecipients(
      msg({ from: 'me@fastmail.com', to: ['them@x.com'], cc: ['cc@z.com'] }),
      'replyAll',
      OWN
    );
    expect(r).toEqual({ to: 'them@x.com', cc: 'cc@z.com' });
  });

  it('reply-all on a note-to-self falls back to me', () => {
    const r = computeReplyRecipients(
      msg({ from: 'me@fastmail.com', to: ['me@fastmail.com'] }),
      'replyAll',
      OWN
    );
    expect(r.to).toBe('me@fastmail.com');
    expect(r.cc).toBe('');
  });
});
