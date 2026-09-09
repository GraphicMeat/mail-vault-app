import { t } from '../i18n/index.js';
import { buildThreads, getSenderName } from './emailParser.js';
import { emailKey } from '../stores/slices/unifiedHelpers.js';
import { compareNames } from './collation.js';

const UNKNOWN_DATE_KEY = 'unknown';
const anonymousIdentity = new WeakMap();
let nextAnonymousIdentity = 1;

function compareStable(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

function translated(key, english) {
  const value = t(key);
  return value === key ? english : value;
}

function contextAccount(context) {
  return context.accountId ?? context.activeAccountId ?? '';
}

function contextMailbox(context) {
  return context.mailbox ?? context.activeMailbox ?? '';
}

function accountOf(email, context) {
  return email?._accountId ?? email?._srcAccountId ?? contextAccount(context);
}

function mailboxOf(email, context) {
  return email?._mailbox
    ?? (email?._fromSentFolder ? 'Sent' : undefined)
    ?? contextMailbox(context);
}

function stableValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${key}:${stableValue(value[key])}`).join(',')}}`;
  }
  return String(value);
}

function contextTag(context) {
  const entries = Object.keys(context || {})
    .sort()
    .map(key => `${key}=${stableValue(context[key])}`);
  return entries.length ? entries.join('&') : 'default';
}

function makeId(kind, scope, ...parts) {
  return [kind, scope, ...parts]
    .map(part => encodeURIComponent(String(part)))
    .join(':');
}

function rawIdentity(email, context) {
  const account = accountOf(email, context);
  const mailbox = mailboxOf(email, context);

  if (email?.uid != null) {
    return emailKey({
      ...email,
      _accountId: account,
      _srcAccountId: undefined,
      _mailbox: mailbox,
      _fromSentFolder: false,
    });
  }

  const messageId = email?.messageId ?? email?.message_id;
  if (messageId) return `${account}|${mailbox}|message-id:${String(messageId).trim().toLowerCase()}`;

  const providerId = email?.id ?? email?.graphId ?? email?.graph_id;
  if (providerId) return `${account}|${mailbox}|provider-id:${providerId}`;

  if (!anonymousIdentity.has(email)) {
    anonymousIdentity.set(email, nextAnonymousIdentity++);
  }
  return `${account}|${mailbox}|anonymous:${anonymousIdentity.get(email)}`;
}

function hasExactIdentity(email) {
  return email?.uid != null
    || !!(email?.messageId ?? email?.message_id)
    || !!(email?.id ?? email?.graphId ?? email?.graph_id);
}

function dedupeEmails(emails, context) {
  const unique = [];
  const seen = new Set();
  for (const email of Array.isArray(emails) ? emails : []) {
    if (!email) continue;
    const identity = rawIdentity(email, context);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(email);
  }
  return unique;
}

function emailDate(email) {
  const raw = email?.date ?? email?.internalDate;
  if (raw == null || raw === '') return null;
  const date = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function compareEmails(a, b, context) {
  const aTime = emailDate(a)?.getTime() ?? -Infinity;
  const bTime = emailDate(b)?.getTime() ?? -Infinity;
  if (aTime !== bTime) return bTime - aTime;
  return compareStable(rawIdentity(a, context), rawIdentity(b, context));
}

function sortedEmails(emails, context) {
  return [...emails].sort((a, b) => compareEmails(a, b, context));
}

function isUnread(email) {
  return !email?.flags?.includes('\\Seen');
}

function summarize(emails, context) {
  const sorted = sortedEmails(emails, context);
  return {
    emails: sorted,
    unreadCount: sorted.filter(isUnread).length,
    vaultCount: sorted.filter(email => email?.isArchived).length,
    lastDate: emailDate(sorted.find(email => emailDate(email))) || null,
  };
}

function node(kind, id, label, emails, children, context, extra = {}) {
  return {
    id,
    kind,
    label,
    children,
    ...summarize(emails, context),
    ...extra,
  };
}

function senderRecord(email) {
  const from = Array.isArray(email?.from) ? email.from[0] : email?.from;
  const address = typeof from?.address === 'string' ? from.address.trim().toLowerCase() : '';
  const source = from === email?.from ? email : { ...email, from };
  return { address, name: getSenderName(source) };
}

function senderAddress(email) {
  return senderRecord(email).address;
}

function formatter(locale, options) {
  try {
    return new Intl.DateTimeFormat(locale || 'en', options);
  } catch {
    return new Intl.DateTimeFormat('en', options);
  }
}

function monthLabel(year, month, locale, includeYear) {
  return formatter(locale, includeYear
    ? { month: 'long', year: 'numeric' }
    : { month: 'long' })
    .format(new Date(year, month - 1, 1, 12));
}

function dayLabel(year, month, day, locale) {
  return formatter(locale, { year: 'numeric', month: 'long', day: 'numeric' })
    .format(new Date(year, month - 1, day, 12));
}

function calendarParts(email) {
  const date = emailDate(email);
  if (!date) return null;
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function dateChildren(emails, {
  scope,
  context,
  locale,
  dateDepth,
  terminal,
}) {
  const dated = [];
  const unknown = [];
  for (const email of emails) {
    (calendarParts(email) ? dated : unknown).push(email);
  }

  const years = groupBy(dated, email => calendarParts(email).year);
  const result = [...years.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, yearEmails]) => {
      const months = groupBy(yearEmails, email => calendarParts(email).month);
      const monthNodes = [...months.entries()]
        .sort(([a], [b]) => b - a)
        .map(([month, monthEmails]) => {
          let children;
          if (dateDepth === 'day') {
            const days = groupBy(monthEmails, email => calendarParts(email).day);
            children = [...days.entries()]
              .sort(([a], [b]) => b - a)
              .map(([day, dayEmails]) => node(
                'day',
                makeId('day', scope, year, month, day),
                dayLabel(year, month, day, locale),
                dayEmails,
                terminal(dayEmails, `${year}-${month}-${day}`),
                context,
              ));
          } else {
            children = terminal(monthEmails, `${year}-${month}`);
          }
          return node(
            'month',
            makeId('month', scope, year, month),
            monthLabel(year, month, locale, false),
            monthEmails,
            children,
            context,
          );
        });
      return node(
        'year',
        makeId('year', scope, year),
        String(year),
        yearEmails,
        monthNodes,
        context,
      );
    });

  if (unknown.length) {
    result.push(node(
      'unknown-date',
      makeId('unknown-date', scope, UNKNOWN_DATE_KEY),
      translated('explorer.unknownDate', 'Unknown date'),
      unknown,
      terminal(unknown, UNKNOWN_DATE_KEY),
      context,
    ));
  }
  return result;
}

function senderDateChildren(emails, { scope, context, locale, dateDepth }) {
  const dated = [];
  const unknown = [];
  for (const email of emails) {
    (calendarParts(email) ? dated : unknown).push(email);
  }

  const months = groupBy(dated, email => {
    const { year, month } = calendarParts(email);
    return `${year}-${String(month).padStart(2, '0')}`;
  });
  const result = [...months.entries()]
    .sort(([a], [b]) => compareStable(b, a))
    .map(([key, monthEmails]) => {
      const [yearText, monthText] = key.split('-');
      const year = Number(yearText);
      const month = Number(monthText);
      let children;
      if (dateDepth === 'day') {
        const days = groupBy(monthEmails, email => calendarParts(email).day);
        children = [...days.entries()]
          .sort(([a], [b]) => b - a)
          .map(([day, dayEmails]) => node(
            'day',
            makeId('day', scope, year, month, day),
            dayLabel(year, month, day, locale),
            dayEmails,
            [],
            context,
          ));
      } else {
        children = [];
      }
      return node(
        'month',
        makeId('month', scope, year, month),
        monthLabel(year, month, locale, true),
        monthEmails,
        children,
        context,
      );
    });

  if (unknown.length) {
    result.push(node(
      'unknown-date',
      makeId('unknown-date', scope, UNKNOWN_DATE_KEY),
      translated('explorer.unknownDate', 'Unknown date'),
      unknown,
      [],
      context,
    ));
  }
  return result;
}

function buildSenderChildren(emails, options) {
  const { scope, context, locale, dateDepth } = options;
  const senders = groupBy(emails, email => senderAddress(email));
  return [...senders.entries()]
    .map(([address, senderEmails]) => {
      const sorted = sortedEmails(senderEmails, context);
      const label = address
        ? senderRecord(sorted[0]).name
        : translated('explorer.unknownSender', 'Unknown sender');
      const senderScope = makeId('sender-scope', scope, address || 'unknown');
      return node(
        'sender',
        makeId('sender', scope, address || 'unknown'),
        label,
        senderEmails,
        senderDateChildren(senderEmails, {
          scope: senderScope,
          context,
          locale,
          dateDepth,
        }),
        context,
        address ? { detail: address } : {},
      );
    })
    .sort((a, b) => {
      const time = (b.lastDate?.getTime() ?? -Infinity) - (a.lastDate?.getTime() ?? -Infinity);
      return time || compareNames(a.detail, b.detail) || compareNames(a.label, b.label);
    });
}

function buildConversationIndex(scopeEmails, conversationEmails, context) {
  const all = dedupeEmails([...(conversationEmails || []), ...scopeEmails], context);
  const byAccount = groupBy(all, email => accountOf(email, context));
  const threadByIdentity = new Map();
  const keyByIdentity = new Map();
  const threads = new Map();

  for (const [account, accountEmails] of byAccount) {
    const identified = accountEmails.filter(hasExactIdentity);
    const threadGroups = [
      ...buildThreads(identified, { subjectFallback: false }).values(),
      ...accountEmails
        .filter(email => !hasExactIdentity(email))
        .flatMap(email => [...buildThreads([email], { subjectFallback: false }).values()]),
    ];
    for (const rawThread of threadGroups) {
      const firstIdentity = rawIdentity(rawThread.emails[0], context);
      const suffix = hasExactIdentity(rawThread.emails[0]) ? rawThread.threadId : firstIdentity;
      const threadKey = `${encodeURIComponent(account || 'accountless')}::${suffix}`;
      const thread = { ...rawThread, threadId: threadKey };
      threads.set(threadKey, thread);
      for (const email of thread.emails) {
        const identity = rawIdentity(email, context);
        threadByIdentity.set(identity, thread);
        keyByIdentity.set(identity, threadKey);
      }
    }
  }
  return { threadByIdentity, keyByIdentity, threads };
}

function conversationNodes(emails, scope, context, index) {
  const conversations = groupBy(emails, email =>
    index.keyByIdentity.get(rawIdentity(email, context)) || rawIdentity(email, context));
  return [...conversations.entries()]
    .map(([threadKey, groupEmails]) => {
      const thread = index.threadByIdentity.get(rawIdentity(groupEmails[0], context));
      return node(
        'conversation',
        makeId('conversation', scope, threadKey),
        thread?.subject || groupEmails[0]?.subject || translated('common.noSubject', '(No subject)'),
        groupEmails,
        [],
        context,
        thread ? { thread } : {},
      );
    })
    .sort((a, b) => {
      const time = (b.lastDate?.getTime() ?? -Infinity) - (a.lastDate?.getTime() ?? -Infinity);
      return time || compareStable(a.id, b.id);
    });
}

/**
 * Build a virtual Explorer hierarchy from the loaded message headers.
 * Every aggregate contains only its scoped messages; conversation nodes also
 * carry the full RFC thread for the reader.
 */
export function buildExplorerTree(emails, {
  grouping = 'date',
  dateDepth = 'month',
  locale = 'en',
  context = {},
  conversationEmails = emails,
  includeThreads = false,
} = {}) {
  const scoped = dedupeEmails(emails, context);
  const scope = `${grouping}|${contextTag(context)}`;
  const conversationIndex = grouping === 'conversation' || includeThreads
    ? buildConversationIndex(scoped, conversationEmails, context)
    : null;
  const threads = conversationIndex?.threads || new Map();
  let children;

  if (grouping === 'sender') {
    children = buildSenderChildren(scoped, { scope, context, locale, dateDepth });
  } else if (grouping === 'conversation') {
    children = dateChildren(scoped, {
      scope,
      context,
      locale,
      dateDepth,
      terminal: (groupEmails, period) => conversationNodes(
        groupEmails,
        `${scope}|${period}`,
        context,
        conversationIndex,
      ),
    });
  } else {
    children = dateChildren(scoped, {
      scope,
      context,
      locale,
      dateDepth,
      terminal: () => [],
    });
  }

  return node(
    'root',
    'root',
    translated('explorer.allMessages', 'All messages'),
    scoped,
    children,
    context,
    { threads },
  );
}

/** Resolve a saved child-id path, trimming stale segments at the first miss. */
export function resolveExplorerPath(root, ids) {
  const requested = Array.isArray(ids) ? ids : [];
  let current = root;
  const breadcrumbs = [root];
  const path = [];

  for (const id of requested) {
    if (id === root.id && path.length === 0) continue;
    const child = current.children.find(candidate => candidate.id === id);
    if (!child) break;
    current = child;
    breadcrumbs.push(child);
    path.push(child.id);
  }

  return { node: current, breadcrumbs, path };
}
