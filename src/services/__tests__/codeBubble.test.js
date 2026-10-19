import { describe, it, expect, beforeEach, vi } from 'vitest';

// The default body read, behind the store and the API: an IMAP message comes
// through the daemon's light fetch, an Outlook message signed in with
// Microsoft through Graph with a fresh token.
const { accounts, mockLight, mockGraphGet, mockCode } = vi.hoisted(() => ({ accounts: [], mockLight: vi.fn(), mockGraphGet: vi.fn(), mockCode: vi.fn() }));
// What the daemon's `message.code` answers for these mails (its rules are
// src-core/src/verification_code.rs): a six-digit code if one is there, else
// whether the subject talks about a code.
const daemonCode = async (subject, text) => {
  const code = `${subject}\n${text}`.match(/\b\d{6}\b/)?.[0] ?? null;
  return { code, needsBody: !code && /sign in|code/i.test(subject) };
};
vi.mock('../../stores/mailStore', () => ({ useMailStore: { getState: () => ({ accounts }) } }));
vi.mock('../api', () => ({
  fetchEmailLight: (...a) => mockLight(...a),
  graphGetMessage: (...a) => mockGraphGet(...a),
  messageCode: (...a) => mockCode(...a),
}));
vi.mock('../authUtils', () => ({ ensureFreshToken: async (account) => ({ ...account, oauth2AccessToken: 'fresh' }) }));
vi.mock('../cacheManager', () => ({ getGraphMessageId: (accountId, mailbox, uid) => (uid === 42 ? 'graph-42' : null) }));

import { offerCodeFromArrival, fetchArrivalBody } from '../codeBubble';
import { useCodeBubbleStore } from '../../stores/codeBubbleStore';

// An arrival's header is all the change feed hands over. A code in the subject
// is offered at once; a subject that only names a code costs one light body
// fetch; anything else is left alone.
const header = (subject, extra = {}) => ({ uid: 42, subject, from: { name: 'Acme', address: 'no-reply@acme.io' }, ...extra });
const bubbles = () => useCodeBubbleStore.getState().bubbles;

describe('offerCodeFromArrival', () => {
  let fetchBody;
  beforeEach(() => {
    useCodeBubbleStore.getState().clear();
    fetchBody = vi.fn().mockResolvedValue({ text: 'Your one-time passcode is 775421.' });
    mockCode.mockReset().mockImplementation(daemonCode);
  });

  it('asks the daemon about the subject and snippet, then about the body', async () => {
    await offerCodeFromArrival('a1', 'INBOX', header('Sign in to Acme', { snippet: 'Hello' }), { fetchBody });
    expect(mockCode.mock.calls).toEqual([
      ['Sign in to Acme', 'Hello'],
      ['Sign in to Acme', 'Your one-time passcode is 775421.'],
    ]);
  });

  it('offers nothing when the daemon cannot be asked', async () => {
    mockCode.mockRejectedValue(new Error('daemon unavailable'));
    await expect(offerCodeFromArrival('a1', 'INBOX', header('Your code is 364758'), { fetchBody })).resolves.toBeUndefined();
    expect(fetchBody).not.toHaveBeenCalled();
    expect(bubbles()).toEqual([]);
  });

  it('offers the code from the subject without reading the body', async () => {
    await offerCodeFromArrival('a1', 'INBOX', header('Your verification code is 364758'), { fetchBody });
    expect(fetchBody).not.toHaveBeenCalled();
    expect(bubbles()).toEqual([expect.objectContaining({
      accountId: 'a1', mailbox: 'INBOX', uid: 42, code: '364758', sender: 'Acme', subject: 'Your verification code is 364758',
    })]);
  });

  it('reads the body when the subject only announces a code', async () => {
    await offerCodeFromArrival('a1', 'INBOX', header('Sign in to Acme'), { fetchBody });
    expect(fetchBody).toHaveBeenCalledWith('a1', 42, 'INBOX');
    expect(bubbles()[0]?.code).toBe('775421');
  });

  it('reads an HTML-only body', async () => {
    fetchBody.mockResolvedValue({ html: '<p>Your one-time passcode is <b>775421</b>.</p>' });
    await offerCodeFromArrival('a1', 'INBOX', header('Sign in to Acme'), { fetchBody });
    expect(bubbles()[0]?.code).toBe('775421');
  });

  it('names the sender by address when there is no name', async () => {
    await offerCodeFromArrival('a1', 'INBOX', header('Your code is 364758', { from: { address: 'no-reply@acme.io' } }), { fetchBody });
    expect(bubbles()[0]?.sender).toBe('no-reply@acme.io');
  });

  it('leaves ordinary mail alone, body unread', async () => {
    await offerCodeFromArrival('a1', 'INBOX', header('Weekly newsletter'), { fetchBody });
    expect(fetchBody).not.toHaveBeenCalled();
    expect(bubbles()).toEqual([]);
  });

  it('offers nothing for a folder other than the inbox', async () => {
    await offerCodeFromArrival('a1', 'Sent', header('Your verification code is 364758'), { fetchBody });
    expect(bubbles()).toEqual([]);
  });

  it('offers nothing without a header', async () => {
    await offerCodeFromArrival('a1', 'INBOX', null, { fetchBody });
    expect(bubbles()).toEqual([]);
  });

  it('offers nothing when the body holds no code', async () => {
    fetchBody.mockResolvedValue({ text: 'Welcome aboard.' });
    await offerCodeFromArrival('a1', 'INBOX', header('Sign in to Acme'), { fetchBody });
    expect(bubbles()).toEqual([]);
  });

  it('reads the body through the default fetch when none is handed in', async () => {
    accounts.length = 0;
    accounts.push({ id: 'a1', email: 'a@one.co' });
    mockLight.mockReset().mockResolvedValue({ text: 'Your one-time passcode is 775421.' });
    await offerCodeFromArrival('a1', 'INBOX', header('Sign in to Acme'));
    expect(bubbles()[0]?.code).toBe('775421');
  });

  it('swallows a failed body fetch', async () => {
    fetchBody.mockRejectedValue(new Error('offline'));
    await expect(offerCodeFromArrival('a1', 'INBOX', header('Sign in to Acme'), { fetchBody })).resolves.toBeUndefined();
    expect(bubbles()).toEqual([]);
  });
});

describe('fetchArrivalBody', () => {
  beforeEach(() => {
    accounts.length = 0;
    mockLight.mockReset();
    mockGraphGet.mockReset();
  });

  it('reads an IMAP message through the light fetch, in the background', async () => {
    const account = { id: 'a1', email: 'a@one.co' };
    accounts.push(account);
    mockLight.mockResolvedValue({ text: 'Your code is 775421' });
    await expect(fetchArrivalBody('a1', 42, 'INBOX')).resolves.toEqual({ text: 'Your code is 775421' });
    expect(mockLight).toHaveBeenCalledWith(account, 42, 'INBOX', 'a1', { background: true });
    expect(mockGraphGet).not.toHaveBeenCalled();
  });

  it('reads an Outlook message signed in with Microsoft through Graph, with a fresh token', async () => {
    accounts.push({ id: 'g1', email: 'g@ms.com', authType: 'oauth2', oauth2Transport: 'graph', oauth2AccessToken: 'stale' });
    mockGraphGet.mockResolvedValue({ subject: 'Sign in', body: { contentType: 'html', content: '<p>Your code is <b>775421</b></p>' } });
    const body = await fetchArrivalBody('g1', 42, 'INBOX');
    expect(mockGraphGet).toHaveBeenCalledWith('fresh', 'graph-42');
    expect(mockLight).not.toHaveBeenCalled();
    expect(body.html).toContain('775421');
  });

  it('returns nothing for a Graph message it holds no id for', async () => {
    accounts.push({ id: 'g1', email: 'g@ms.com', oauth2Transport: 'graph', oauth2AccessToken: 'stale' });
    await expect(fetchArrivalBody('g1', 7, 'INBOX')).resolves.toBeNull();
    expect(mockGraphGet).not.toHaveBeenCalled();
  });

  it('returns nothing for an account that is gone', async () => {
    await expect(fetchArrivalBody('zz', 42, 'INBOX')).resolves.toBeNull();
    expect(mockLight).not.toHaveBeenCalled();
  });
});
