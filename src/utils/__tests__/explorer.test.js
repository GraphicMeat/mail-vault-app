import { describe, expect, it } from 'vitest';
import { buildExplorerTree, resolveExplorerPath } from '../explorer.js';
import { refreshSelectedThread } from '../../stores/slices/unifiedHelpers.js';

const localDate = (year, month, day, hour = 12) =>
  new Date(year, month - 1, day, hour).toISOString();

const message = (uid, overrides = {}) => ({
  uid,
  messageId: `<m${uid}@example.test>`,
  subject: `Message ${uid}`,
  date: localDate(2026, 1, 1),
  from: { address: 'sender@example.test', name: 'Sender' },
  to: [{ address: 'me@example.test', name: 'Me' }],
  flags: ['\\Seen'],
  isLocal: false,
  isArchived: false,
  _accountId: 'account-a',
  _mailbox: 'INBOX',
  ...overrides,
});

describe('buildExplorerTree date grouping', () => {
  it('sorts local-calendar date groups newest first and keeps missing dates explicit', () => {
    const newest = message(1, {
      date: localDate(2026, 2, 3, 23),
      flags: [],
      isLocal: true,
      isArchived: true,
    });
    const earlier = message(2, {
      date: localDate(2026, 1, 8),
      isLocal: true,
      isArchived: false,
    });
    const previousYear = message(3, { date: localDate(2025, 12, 31) });
    const unknown = message(4, { date: null, internalDate: 'not-a-date', flags: [] });

    const root = buildExplorerTree([unknown, previousYear, earlier, newest], {
      locale: 'en-US',
      context: { accountId: 'account-a', mailbox: 'INBOX' },
    });

    expect(root).toMatchObject({
      id: 'root',
      kind: 'root',
      label: 'All messages',
      unreadCount: 2,
      vaultCount: 1,
    });
    expect(root.children.map(({ kind, label, unreadCount, vaultCount }) => ({
      kind, label, unreadCount, vaultCount,
    }))).toEqual([
      { kind: 'year', label: '2026', unreadCount: 1, vaultCount: 1 },
      { kind: 'year', label: '2025', unreadCount: 0, vaultCount: 0 },
      { kind: 'unknown-date', label: 'Unknown date', unreadCount: 1, vaultCount: 0 },
    ]);
    expect(root.children[0].children.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: 'month', label: 'February' },
      { kind: 'month', label: 'January' },
    ]);
    expect(root.emails).toEqual([newest, earlier, previousYear, unknown]);
    expect(root.lastDate).toEqual(new Date(newest.date));
    expect(root.children[2].lastDate).toBeNull();
    expect(root.threads).toEqual(new Map());
  });

  it('adds local-calendar day groups only when day depth is requested', () => {
    const late = message(10, { date: localDate(2026, 1, 20) });
    const early = message(11, { date: localDate(2026, 1, 2) });

    const byMonth = buildExplorerTree([early, late], { locale: 'en-US' });
    expect(byMonth.children[0].children[0].children).toEqual([]);
    expect(byMonth.children[0].children[0].emails).toEqual([late, early]);

    const byDay = buildExplorerTree([early, late], {
      dateDepth: 'day',
      locale: 'en-US',
    });
    expect(byDay.children[0].children[0].children.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: 'day', label: 'January 20, 2026' },
      { kind: 'day', label: 'January 2, 2026' },
    ]);
    expect(byDay.children[0].children[0].children[0].emails).toEqual([late]);
    expect(byDay.children[0].children[0].children[0].children).toEqual([]);
  });
});

describe('buildExplorerTree sender grouping', () => {
  it('uses normalized addresses for identity while keeping duplicate display names separate', () => {
    const sharedOlder = message(20, {
      date: localDate(2026, 1, 2),
      from: { address: 'CASE@Example.test', name: 'Earlier Name' },
    });
    const sharedNewer = message(21, {
      date: localDate(2026, 2, 4),
      from: { address: 'case@example.test', name: 'Casey' },
    });
    const sameNameDifferentAddress = message(22, {
      date: localDate(2026, 2, 3),
      from: { address: 'other@example.test', name: 'Casey' },
    });

    const root = buildExplorerTree(
      [sameNameDifferentAddress, sharedOlder, sharedNewer],
      { grouping: 'sender', locale: 'en-US' },
    );

    expect(root.children.map(({ label, detail, emails }) => ({
      label,
      detail,
      uids: emails.map(email => email.uid),
    }))).toEqual([
      { label: 'Casey', detail: 'case@example.test', uids: [21, 20] },
      { label: 'Casey', detail: 'other@example.test', uids: [22] },
    ]);
    expect(root.children[0].children.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: 'month', label: 'February 2026' },
      { kind: 'month', label: 'January 2026' },
    ]);
  });
});

describe('buildExplorerTree conversation grouping', () => {
  it('does not merge a headerless Re: orphan by subject alone', () => {
    const original = message(29, {
      messageId: '<project-a@example.test>',
      subject: 'Project',
      date: localDate(2026, 3, 5, 10),
    });
    const unrelatedReply = message(30, {
      messageId: '<project-b@example.test>',
      subject: 'Re: Project',
      date: localDate(2026, 3, 5, 11),
    });

    const root = buildExplorerTree([original, unrelatedReply], {
      grouping: 'conversation',
      locale: 'en-US',
    });
    const conversations = root.children[0].children[0].children;

    expect(root.threads.size).toBe(2);
    expect(conversations.map(node => node.emails.map(email => email.uid))).toEqual([[30], [29]]);
  });

  it('keeps colliding RFC thread ids separate across accounts', () => {
    const accountA = message(30, {
      messageId: '<same@example.test>',
      subject: 'Account A topic',
      _accountId: 'account-a',
      date: localDate(2026, 3, 5),
    });
    const accountB = message(30, {
      messageId: '<same@example.test>',
      subject: 'Account B topic',
      _accountId: 'account-b',
      date: localDate(2026, 3, 5, 11),
    });

    const root = buildExplorerTree([accountA, accountB], {
      grouping: 'conversation',
      dateDepth: 'day',
      locale: 'en-US',
      context: { mailbox: 'INBOX' },
    });
    const conversations = root.children[0].children[0].children[0].children;

    expect(conversations.map(({ label, emails, thread }) => ({
      label,
      uids: emails.map(email => `${email._accountId}:${email.uid}`),
      fullThreadUids: thread.emails.map(email => `${email._accountId}:${email.uid}`),
    }))).toEqual([
      {
        label: 'Account A topic',
        uids: ['account-a:30'],
        fullThreadUids: ['account-a:30'],
      },
      {
        label: 'Account B topic',
        uids: ['account-b:30'],
        fullThreadUids: ['account-b:30'],
      },
    ]);
    expect(conversations[0].id).not.toBe(conversations[1].id);
    expect([...root.threads.entries()].map(([key, thread]) => [key, thread.threadId])).toEqual([
      ['account-a::<same@example.test>', 'account-a::<same@example.test>'],
      ['account-b::<same@example.test>', 'account-b::<same@example.test>'],
    ]);
  });

  it('repeats a cross-month conversation in each scoped month but attaches its full thread', () => {
    const january = message(40, {
      messageId: '<root@example.test>',
      subject: 'Project',
      date: localDate(2026, 1, 30),
      flags: [],
      isLocal: true,
      isArchived: true,
    });
    const february = message(41, {
      messageId: '<reply@example.test>',
      inReplyTo: '<root@example.test>',
      references: '<root@example.test>',
      subject: 'Re: Project',
      date: localDate(2026, 2, 2),
    });
    const sentCopy = message(42, {
      messageId: '<sent@example.test>',
      inReplyTo: '<reply@example.test>',
      references: '<root@example.test> <reply@example.test>',
      subject: 'Re: Project',
      date: localDate(2026, 3, 4),
      _mailbox: 'Sent',
    });

    const root = buildExplorerTree([january, february], {
      grouping: 'conversation',
      locale: 'en-US',
      conversationEmails: [sentCopy, february, january],
    });
    const febConversation = root.children[0].children[0].children[0];
    const janConversation = root.children[0].children[1].children[0];

    expect(root.children[0].children.map(node => node.label)).toEqual(['February', 'January']);
    expect(febConversation.emails).toEqual([february]);
    expect(janConversation.emails).toEqual([january]);
    expect(febConversation.children).toEqual([]);
    expect(janConversation.children).toEqual([]);
    expect(febConversation.thread.emails).toEqual([january, february, sentCopy]);
    expect(janConversation.thread).toBe(febConversation.thread);
    expect(febConversation.unreadCount).toBe(0);
    expect(febConversation.vaultCount).toBe(0);
    expect(janConversation.unreadCount).toBe(1);
    expect(janConversation.vaultCount).toBe(1);
  });

  it('builds strict threads for Date grouping when an open reader needs refresh', () => {
    const accountARoot = message(43, {
      messageId: '<shared-root@example.test>',
      subject: 'Account A project',
      _accountId: 'account-a',
      date: localDate(2026, 3, 4, 9),
    });
    const initial = buildExplorerTree([accountARoot], {
      grouping: 'date',
      includeThreads: true,
      conversationEmails: [accountARoot],
    });
    const open = [...initial.threads.values()][0];
    const accountAReply = message(44, {
      messageId: '<shared-reply@example.test>',
      inReplyTo: '<shared-root@example.test>',
      references: '<shared-root@example.test>',
      subject: 'Re: Account A project',
      _accountId: 'account-a',
      date: localDate(2026, 3, 4, 10),
    });
    const accountBCollision = message(43, {
      messageId: '<shared-root@example.test>',
      subject: 'Account B project',
      _accountId: 'account-b',
      date: localDate(2026, 3, 4, 11),
    });
    const refreshed = buildExplorerTree([accountARoot, accountAReply, accountBCollision], {
      grouping: 'date',
      includeThreads: true,
      conversationEmails: [accountARoot, accountAReply, accountBCollision],
    });

    const update = refreshSelectedThread({
      selectedThread: open,
      activeAccountId: 'account-a',
      activeMailbox: 'INBOX',
    }, refreshed.threads);

    expect(refreshed.threads.size).toBe(2);
    expect(update.selectedThread.threadId).toBe('account-a::<shared-root@example.test>');
    expect(update.selectedThread.emails.map(email => `${email._accountId}:${email.uid}`)).toEqual([
      'account-a:43',
      'account-a:44',
    ]);
  });
});

describe('buildExplorerTree identity and immutability', () => {
  it('does not collapse distinct rows that have no exact message identity', () => {
    const first = message(49);
    const second = message(49);
    delete first.uid;
    delete first.messageId;
    delete second.uid;
    delete second.messageId;

    const root = buildExplorerTree([first, second]);

    expect(root.emails).toEqual([first, second]);
    expect(root.children[0].children[0].emails).toEqual([first, second]);
  });

  it('deduplicates exact scoped identities, preserves the first object, and does not mutate input', () => {
    const firstSource = message(50, {
      from: Object.freeze({ address: 'first@example.test', name: 'First' }),
      flags: Object.freeze([]),
      to: Object.freeze([{ address: 'me@example.test' }]),
    });
    const duplicateSource = message(50, {
      subject: 'Duplicate row',
    });
    delete firstSource._accountId;
    delete firstSource._mailbox;
    delete duplicateSource._accountId;
    delete duplicateSource._mailbox;
    const first = Object.freeze(firstSource);
    const duplicate = Object.freeze(duplicateSource);
    const emails = Object.freeze([first, duplicate]);

    const root = buildExplorerTree(emails, {
      context: { accountId: 'account-a', mailbox: 'INBOX', viewMode: 'all' },
    });

    expect(root.emails).toEqual([first]);
    expect(root.children[0].children[0].children).toEqual([]);
    expect(root.children[0].children[0].emails[0]).toBe(first);
    expect(first).not.toHaveProperty('_accountId');
    expect(first).not.toHaveProperty('_mailbox');
  });

  it('uses context in stable descendant ids so equal UIDs in different scopes cannot collide', () => {
    const untagged = message(60, { _accountId: undefined, _mailbox: undefined });
    const inbox = buildExplorerTree([untagged], {
      context: { accountId: 'account-a', mailbox: 'INBOX' },
    });
    const sent = buildExplorerTree([untagged], {
      context: { accountId: 'account-a', mailbox: 'Sent' },
    });

    expect(inbox.children[0].id).not.toBe(sent.children[0].id);
    expect(inbox.children[0].children[0].id)
      .not.toBe(sent.children[0].children[0].id);
    expect(buildExplorerTree([untagged], {
      context: { accountId: 'account-a', mailbox: 'INBOX' },
    }).children[0].children[0].id)
      .toBe(inbox.children[0].children[0].id);
  });
});

describe('resolveExplorerPath', () => {
  it('returns the deepest surviving ancestor and trims a stale path', () => {
    const root = buildExplorerTree([
      message(70, { date: localDate(2026, 4, 12) }),
    ], { locale: 'en-US' });
    const year = root.children[0];
    const month = year.children[0];

    const resolved = resolveExplorerPath(root, [year.id, month.id, 'removed-group']);

    expect(resolved.node).toBe(month);
    expect(resolved.breadcrumbs).toEqual([root, year, month]);
    expect(resolved.path).toEqual([year.id, month.id]);
  });

  it('falls back to root when the first segment is stale', () => {
    const root = buildExplorerTree([message(71)]);
    expect(resolveExplorerPath(root, ['removed-year'])).toEqual({
      node: root,
      breadcrumbs: [root],
      path: [],
    });
  });
});
