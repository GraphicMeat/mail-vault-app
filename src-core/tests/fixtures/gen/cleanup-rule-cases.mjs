// Writes src-core/tests/fixtures/cleanup-rule-cases.json. Dates are computed
// from a fixed `now` so both runners read the same strings.
import { writeFileSync } from 'node:fs';

const NOW = 1790000000000;
const DAY = 864e5;
const ago = (d) => new Date(NOW - d * DAY).toISOString();

const PREMIUM = { hasSubscription: true, status: 'active', premiumAccess: true };
const ACCOUNTS = [
  { id: 'acc-1', email: 'luke@test.com' },
  { id: 'acc-2', email: 'leia@test.com' },
];
const DOVECOT = [
  { path: 'INBOX', name: 'INBOX' },
  { path: 'INBOX.Sent', name: 'Sent', specialUse: '\\Sent' },
  { path: 'INBOX.Trash', name: 'Trash', specialUse: '\\Trash' },
  { path: 'INBOX.Drafts', name: 'Drafts', specialUse: '\\Drafts' },
  { path: 'INBOX.Junk', name: 'Junk' },
];
const GMAIL = [
  { path: 'INBOX', name: 'INBOX' },
  { path: '[Imap]/Trash', name: 'Trash' },
  { path: '[Gmail]/Trash', name: 'Trash', specialUse: '\\Trash' },
  { path: '[Gmail]/Drafts', name: 'Drafts', specialUse: '\\Drafts' },
];
const NO_ROLES = [
  { path: 'INBOX', name: 'INBOX' },
  { path: 'Trash', name: 'Trash' },
  { path: 'Junk', name: 'Junk' },
];

const rule = (over = {}) => ({
  id: 'r1', account: 'all', folder: 'INBOX', age: 30, unit: 'days', action: 'delete', enabled: true, ...over,
});

/** luke's INBOX: uid 1 sixty days old, uid 2 three days old. */
const BASE_HEADERS = {
  'acc-1': { INBOX: [{ uid: 1, date: ago(60), messageId: '<old@test.com>' }, { uid: 2, date: ago(3) }] },
};

const base = (over) => ({
  billingProfile: PREMIUM,
  shareGrant: null,
  hiddenAccounts: {},
  accounts: ACCOUNTS,
  mailboxes: { 'acc-1': { lastKnownGoodMailboxes: DOVECOT }, 'acc-2': { lastKnownGoodMailboxes: DOVECOT } },
  headers: BASE_HEADERS,
  ...over,
});

const ran = (deleted, archived = 0) => ({ ran: true, archived, deleted, skipped: 0 });
const NO_RUN = { ran: false };

const cases = [
  { name: 'deletes exactly the messages past the threshold', ...base({ rules: [rule()] }),
    expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  { name: 'a wider threshold deletes nothing', ...base({ rules: [rule({ age: 90 })] }),
    expect: { result: ran(0), deletes: [] } },
  { name: 'one month is thirty days', ...base({ rules: [rule({ age: 1, unit: 'months' })] }),
    expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  { name: 'three months is ninety days', ...base({ rules: [rule({ age: 3, unit: 'months' })] }),
    expect: { result: ran(0), deletes: [] } },
  { name: 'an age given as a numeric string is read as that number', ...base({ rules: [rule({ age: '30' })] }),
    expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  { name: 'archive-then-delete archives the stale uids of the folder first', ...base({ rules: [rule({ action: 'archive-then-delete' })] }),
    expect: { result: ran(1, 1), deletes: [['acc-1', 'INBOX', 1, false]], archives: [['acc-1', 'INBOX', [1]]] } },
  { name: 'Sent reaches the Sent-role folder', ...base({
    rules: [rule({ folder: 'Sent' })],
    headers: { 'acc-1': { 'INBOX.Sent': [{ uid: 5, date: ago(60) }] } },
  }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX.Sent', 5, false]] } },
  { name: 'all walks every selectable folder except Drafts, in list order', ...base({
    rules: [rule({ folder: 'all' })],
    headers: { 'acc-1': {
      INBOX: [{ uid: 1, date: ago(60) }],
      'INBOX.Sent': [{ uid: 5, date: ago(60) }],
      'INBOX.Trash': [{ uid: 7, date: ago(60) }],
      'INBOX.Drafts': [{ uid: 9, date: ago(60) }],
      'INBOX.Junk': [{ uid: 11, date: ago(60) }],
    } },
  }), expect: { result: ran(4), deletes: [
    ['acc-1', 'INBOX', 1, false], ['acc-1', 'INBOX.Sent', 5, false],
    ['acc-1', 'INBOX.Trash', 7, true], ['acc-1', 'INBOX.Junk', 11, false],
  ] } },
  { name: 'only the Trash-role folder is emptied permanently', ...base({
    rules: [rule({ folder: 'Trash' })],
    headers: { 'acc-1': { 'INBOX.Trash': [{ uid: 7, date: ago(60) }] } },
  }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX.Trash', 7, true]] } },
  { name: 'Gmail: Trash resolves to the declared Trash, not a label called Trash', ...base({
    rules: [rule({ folder: 'Trash', account: 'luke@test.com' })],
    mailboxes: { 'acc-1': { mailboxes: GMAIL } },
    headers: { 'acc-1': { '[Gmail]/Trash': [{ uid: 3, date: ago(60) }], '[Imap]/Trash': [{ uid: 4, date: ago(60) }] } },
  }), expect: { result: ran(1), deletes: [['acc-1', '[Gmail]/Trash', 3, true]] } },
  { name: 'Gmail: a label called Trash is moved, not emptied, when a Trash is declared', ...base({
    rules: [rule({ folder: 'all', account: 'luke@test.com' })],
    mailboxes: { 'acc-1': { mailboxes: GMAIL } },
    headers: { 'acc-1': { '[Imap]/Trash': [{ uid: 4, date: ago(60) }] } },
  }), expect: { result: ran(1), deletes: [['acc-1', '[Imap]/Trash', 4, false]] } },
  { name: 'no declared Trash: the folder named Trash is the one emptied', ...base({
    rules: [rule({ folder: 'Trash', account: 'luke@test.com' })],
    mailboxes: { 'acc-1': { mailboxes: NO_ROLES } },
    headers: { 'acc-1': { Trash: [{ uid: 6, date: ago(60) }] } },
  }), expect: { result: ran(1), deletes: [['acc-1', 'Trash', 6, true]] } },
  { name: 'no declared Junk: the folder named Junk is found by its name', ...base({
    rules: [rule({ folder: 'Junk', account: 'luke@test.com' })],
    mailboxes: { 'acc-1': { mailboxes: NO_ROLES } },
    headers: { 'acc-1': { Junk: [{ uid: 8, date: ago(60) }] } },
  }), expect: { result: ran(1), deletes: [['acc-1', 'Junk', 8, false]] } },
  { name: 'a rule folder that is a literal path matches that path', ...base({
    rules: [rule({ folder: 'INBOX.Junk' })],
    headers: { 'acc-1': { 'INBOX.Junk': [{ uid: 11, date: ago(60) }] } },
  }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX.Junk', 11, false]] } },
  { name: 'a folder the account does not have cleans nothing', ...base({ rules: [rule({ folder: 'Archive' })] }),
    expect: { result: ran(0), deletes: [] } },
  { name: 'an account whose folder list was never cached is skipped', ...base({
    rules: [rule()], mailboxes: {},
  }), expect: { result: ran(0), deletes: [] } },
  { name: 'the plain mailbox list is used when there is no last known good one', ...base({
    rules: [rule()], mailboxes: { 'acc-1': { mailboxes: DOVECOT } },
  }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  { name: 'an old array-shaped mailbox cache is a mailbox list', ...base({
    rules: [rule()], mailboxes: { 'acc-1': DOVECOT },
  }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  { name: 'the last known good list wins over the current one', ...base({
    rules: [rule({ folder: 'Sent' })],
    mailboxes: { 'acc-1': { mailboxes: NO_ROLES, lastKnownGoodMailboxes: DOVECOT } },
    headers: { 'acc-1': { 'INBOX.Sent': [{ uid: 5, date: ago(60) }] } },
  }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX.Sent', 5, false]] } },
  { name: 'an empty last known good list is an empty list', ...base({
    rules: [rule()], mailboxes: { 'acc-1': { mailboxes: DOVECOT, lastKnownGoodMailboxes: [] } },
  }), expect: { result: ran(0), deletes: [] } },
  { name: 'a noselect folder and a Drafts folder without a role are left out of all', ...base({
    rules: [rule({ folder: 'all' })],
    mailboxes: { 'acc-1': { mailboxes: [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'INBOX.Drafts', name: 'Drafts' },
      { path: 'Lists', name: 'Lists', noselect: true },
      { path: 'Lists/Old', name: 'Old' },
    ] } },
    headers: { 'acc-1': {
      INBOX: [{ uid: 1, date: ago(60) }],
      'INBOX.Drafts': [{ uid: 2, date: ago(60) }],
      Lists: [{ uid: 3, date: ago(60) }],
      'Lists/Old': [{ uid: 4, date: ago(60) }],
    } },
  }), expect: { result: ran(2), deletes: [['acc-1', 'INBOX', 1, false], ['acc-1', 'Lists/Old', 4, false]] } },
  { name: 'all reaches every visible account', ...base({
    rules: [rule()],
    headers: { 'acc-1': { INBOX: [{ uid: 1, date: ago(60) }] }, 'acc-2': { INBOX: [{ uid: 4, date: ago(60) }] } },
  }), expect: { result: ran(2), deletes: [['acc-1', 'INBOX', 1, false], ['acc-2', 'INBOX', 4, false]] } },
  { name: 'a named account reaches only that account', ...base({
    rules: [rule({ account: 'luke@test.com' })],
    headers: { 'acc-1': { INBOX: [{ uid: 1, date: ago(60) }] }, 'acc-2': { INBOX: [{ uid: 4, date: ago(60) }] } },
  }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  { name: 'a rule for the other account leaves this one alone', ...base({ rules: [rule({ account: 'leia@test.com' })] }),
    expect: { result: ran(0), deletes: [] } },
  { name: 'a hidden account is not cleaned', ...base({ rules: [rule()], hiddenAccounts: { 'acc-1': true } }),
    expect: { result: ran(0), deletes: [] } },
  { name: 'rules run in order and each one deletes what it matched', ...base({
    rules: [rule({ id: 'r1', folder: 'INBOX' }), rule({ id: 'r2', folder: 'all' })],
    headers: { 'acc-1': { INBOX: [{ uid: 1, date: ago(60) }], 'INBOX.Junk': [{ uid: 11, date: ago(60) }] } },
  }), expect: { result: ran(3), deletes: [
    ['acc-1', 'INBOX', 1, false], ['acc-1', 'INBOX', 1, false], ['acc-1', 'INBOX.Junk', 11, false],
  ] } },
  { name: 'a disabled rule next to an enabled one does nothing', ...base({
    rules: [rule({ id: 'off', enabled: false, folder: 'all' }), rule({ id: 'on' })],
  }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  { name: 'header dates: RFC 2822 with a comment, unreadable, missing, and exactly at the cutoff', ...base({
    rules: [rule()],
    headers: { 'acc-1': { INBOX: [
      { uid: 1, date: 'Wed, 01 Jan 2020 12:00:00 +0000 (UTC)' },
      { uid: 2, date: '1 Jan 2020 12:00:00 GMT' },
      { uid: 3, date: 'not a date' },
      { uid: 4 },
      { uid: 5, date: '' },
      { uid: 6, date: new Date(NOW - 30 * DAY).toISOString() },
      { uid: 7, date: new Date(NOW - 30 * DAY - 1000).toISOString() },
      { uid: 8, date: 'Tue, 21 Jul 2026 09:00:00 -0700' },
    ] } },
  }), expect: { result: ran(4), deletes: [
    ['acc-1', 'INBOX', 1, false], ['acc-1', 'INBOX', 2, false], ['acc-1', 'INBOX', 7, false], ['acc-1', 'INBOX', 8, false],
  ] } },
  // Refusals: the rule is enabled and would match, but cannot be read safely.
  ...[
    ['no age at all', { age: undefined }],
    ['an age that is not a number', { age: 'thirty' }],
    ['an age of zero', { age: 0 }],
    ['a negative age', { age: -30 }],
    ['an unknown unit', { unit: 'fortnights' }],
    ['an age below the seven-day floor', { age: 1 }],
    ['six days', { age: 6 }],
    ['the old action spelling', { action: 'archive-delete' }],
    ['an action nobody recognises', { action: 'shred' }],
    ['a protected folder', { folder: 'Drafts' }],
  ].map(([label, over]) => ({
    name: `refuses ${label}`, ...base({ rules: [rule(over)] }),
    expect: { result: ran(0), deletes: [] },
  })),
  { name: 'seven days is the floor and runs', ...base({ rules: [rule({ age: 7 })] }),
    expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  // Premium: what hasPremiumAccess answers decides whether anything runs.
  { name: 'no premium: nothing runs', ...base({ rules: [rule()], billingProfile: null }), expect: { result: NO_RUN, deletes: [] } },
  { name: 'no subscription: nothing runs', ...base({ rules: [rule()], billingProfile: { hasSubscription: false, status: 'active' } }), expect: { result: NO_RUN, deletes: [] } },
  { name: 'clientAccessGranted false wins over premiumAccess', ...base({ rules: [rule()], billingProfile: { hasSubscription: true, status: 'active', premiumAccess: true, clientAccessGranted: false } }), expect: { result: NO_RUN, deletes: [] } },
  { name: 'clientAccessGranted true runs', ...base({ rules: [rule()], billingProfile: { hasSubscription: true, status: 'canceled', clientAccessGranted: true } }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  { name: 'premiumAccess false wins over an active status', ...base({ rules: [rule()], billingProfile: { hasSubscription: true, status: 'active', premiumAccess: false } }), expect: { result: NO_RUN, deletes: [] } },
  { name: 'trialing runs', ...base({ rules: [rule()], billingProfile: { hasSubscription: true, status: 'trialing' } }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  { name: 'past_due runs', ...base({ rules: [rule()], billingProfile: { hasSubscription: true, status: 'past_due' } }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  { name: 'canceled with time left runs', ...base({ rules: [rule()], billingProfile: { hasSubscription: true, status: 'canceled', currentPeriodEnd: new Date(NOW + DAY).toISOString() } }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  { name: 'canceled and over does not run', ...base({ rules: [rule()], billingProfile: { hasSubscription: true, status: 'canceled', currentPeriodEnd: new Date(NOW - DAY).toISOString() } }), expect: { result: NO_RUN, deletes: [] } },
  { name: 'an unknown status does not run', ...base({ rules: [rule()], billingProfile: { hasSubscription: true, status: 'incomplete' } }), expect: { result: NO_RUN, deletes: [] } },
  { name: 'a live share grant runs without a subscription', ...base({ rules: [rule()], billingProfile: null, shareGrant: { expiresAt: NOW + DAY } }), expect: { result: ran(1), deletes: [['acc-1', 'INBOX', 1, false]] } },
  { name: 'an expired share grant does not run', ...base({ rules: [rule()], billingProfile: null, shareGrant: { expiresAt: NOW - 1 } }), expect: { result: NO_RUN, deletes: [] } },
  { name: 'no enabled rules: nothing runs', ...base({ rules: [rule({ enabled: false })] }), expect: { result: NO_RUN, deletes: [] } },
  { name: 'no rules at all: nothing runs', ...base({ rules: [] }), expect: { result: NO_RUN, deletes: [] } },
];

const about = 'Answers of src/services/cleanupEngine.js (runCleanupRules) with every vault copy verified and no external mirror. tests/unit/cleanupRuleParity.test.js ran them against that JS; src-core/src/cleanup_rules.rs must select the same deletes.';
writeFileSync(process.argv[2], `{\n  "about": ${JSON.stringify(about)},\n  "now": ${NOW},\n  "cases": [\n${cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]\n}\n`);
console.log(cases.length, 'cases');
