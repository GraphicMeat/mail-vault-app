import { describe, it, expect } from 'vitest';
import { refreshSelectedThread } from '../slices/unifiedHelpers';
import { buildThreads } from '../../utils/emailParser';

// The reader's open thread is a SNAPSHOT of one buildThreads() entry. Removals
// go through pruneSelectedThread; until refreshSelectedThread there was no
// route in for an addition at all — which is why a reply you had just sent
// never joined the thread you sent it from.

const parent = {
  uid: 10,
  messageId: '<parent@example.test>',
  subject: 'Quote request',
  from: { address: 'them@example.test' },
  to: [{ address: 'me@example.test' }],
  date: '2026-09-07T09:00:00Z',
  flags: ['\\Seen'],
};

/** A reply shaped the way the compose window stages its own outgoing copy. */
const reply = (over = {}) => ({
  uid: 1757000000,
  messageId: '<mine@example.test>',
  subject: 'Re: Quote request',
  from: { address: 'me@example.test' },
  to: [{ address: 'them@example.test' }],
  date: '2026-09-07T09:05:00Z',
  inReplyTo: '<parent@example.test>',
  references: ['<parent@example.test>'],
  flags: ['\\Seen'],
  _accountId: 'acct-1',
  _mailbox: 'Sent',
  _fromSentFolder: true,
  _optimistic: true,
  ...over,
});

const threadOf = (emails) => [...buildThreads(emails).values()][0];
const state = (selectedThread, over = {}) => ({ selectedThread, activeAccountId: 'acct-1', activeMailbox: 'INBOX', getSentMailboxPath: () => 'Sent', ...over });

describe('refreshSelectedThread', () => {
  it('adds the reply that landed after the thread was opened', () => {
    const open = threadOf([parent]);
    const threads = buildThreads([parent, reply()]);

    const update = refreshSelectedThread(state(open), threads);

    expect(update).not.toBeNull();
    expect(update.selectedThread.emails.map(e => e.uid)).toEqual([10, 1757000000]);
    expect(update.selectedThread.messageCount).toBe(2);
  });

  it('returns null when the membership is unchanged — the reader must not churn', () => {
    const open = threadOf([parent, reply()]);
    // A fresh buildThreads run over the same messages: new objects, same members.
    const threads = buildThreads([parent, reply()]);

    expect(refreshSelectedThread(state(open), threads)).toBeNull();
  });

  it('swaps the staged copy for the server one instead of showing both', () => {
    const open = threadOf([parent, reply()]);
    // The server APPEND landed: same Message-ID, the folder's real uid.
    const server = reply({ uid: 4211, _optimistic: false });
    const threads = buildThreads([parent, server]);

    const update = refreshSelectedThread(state(open), threads);

    expect(update.selectedThread.emails.map(e => e.uid)).toEqual([10, 4211]);
  });

  it('drops a message the rebuilt map no longer holds', () => {
    const open = threadOf([parent, reply()]);
    const threads = buildThreads([parent]);

    const update = refreshSelectedThread(state(open), threads);

    expect(update.selectedThread.emails.map(e => e.uid)).toEqual([10]);
  });

  it('follows the conversation when an arriving message bridges two threads', () => {
    // The open thread is the orphan half; the bridge names both, so the
    // rebuilt map roots the merged conversation on the OTHER id.
    const other = { ...parent, uid: 7, messageId: '<other@example.test>', subject: 'Quote', date: '2026-09-07T08:00:00Z' };
    const open = threadOf([parent]);
    const bridge = reply({ uid: 12, messageId: '<bridge@example.test>', references: ['<other@example.test>', '<parent@example.test>'] });
    const threads = buildThreads([other, parent, bridge]);

    const update = refreshSelectedThread(state(open), threads);

    expect(update.selectedThread.emails.map(e => e.uid)).toEqual([7, 10, 12]);
  });

  it('leaves the snapshot alone when the list is not showing this thread', () => {
    const open = threadOf([parent]);
    const threads = buildThreads([{ ...parent, uid: 99, messageId: '<unrelated@example.test>', subject: 'Something else' }]);

    expect(refreshSelectedThread(state(open), threads)).toBeNull();
  });

  it('does nothing without an open thread, or before the list has threaded', () => {
    expect(refreshSelectedThread(state(null), buildThreads([parent]))).toBeNull();
    expect(refreshSelectedThread(state(threadOf([parent])), new Map())).toBeNull();
    expect(refreshSelectedThread(state(threadOf([parent])), null)).toBeNull();
  });

  it('keys members by folder — a Sent copy sharing an INBOX uid is not the same message', () => {
    const collide = reply({ uid: 10, messageId: '<mine@example.test>' });
    const open = threadOf([parent]);
    const threads = buildThreads([parent, collide]);

    const update = refreshSelectedThread(state(open), threads);

    expect(update.selectedThread.emails).toHaveLength(2);
  });
});
