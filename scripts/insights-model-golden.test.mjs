// Characterises the JS Insights model (src/utils/insights/model.js) on the
// fixtures its vitest suite uses, and writes what it answers to
// src-core/tests/fixtures/insights-model-cases.json. The Rust port in
// src-core/src/insights_model.rs is tested against that file, so the two
// answer the same for every case here. Run once, before the JS is deleted
// (through vitest, which resolves the app's imports):
//   INSIGHTS_GOLDEN_OUT=src-core/tests/fixtures/insights-model-cases.json npx vitest run scripts/insights-model-golden.test.mjs
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { A, B, COUNT_FIXTURE, copy } from '../tests/fixtures/insights.js';
import { buildInsightsModel, matchingInsightsMessages, queryInsights } from '../src/utils/insights/model.js';

const ACCOUNTS = [{ id: A, email: 'me@example.test' }, { id: B, email: 'second@example.test' }];
const OPTIONS = { accounts: ACCOUNTS, ownAddressesByAccount: { [A]: ['me@example.test'], [B]: ['second@example.test'] } };
const QUERY = { accountIds: [A], startDate: '2026-09-01', endDate: '2026-09-09',
  timeZone: 'Europe/Vilnius', direction: 'both', senderAddress: null,
  hideAutomated: false, timelineBucket: 'day', senderSort: 'recent' };

const cases = [];
const queries = [
  {}, { direction: 'received' }, { direction: 'sent' },
  { timelineBucket: 'week' }, { timelineBucket: 'message' },
  { hideAutomated: true }, { senderSort: 'count' }, { senderSort: 'name' }, { senderSort: 'volume' },
  { accountIds: [A, B] },
];
const selections = [{}, { startDate: null, endDate: null }];

/** `calls` default to the common query and selection matrix. */
function add(name, copies, options = OPTIONS, calls = null) {
  const list = calls || [
    ...queries.map(query => ({ kind: 'query', query })),
    ...queries.slice(0, 3).flatMap(query => selections.map(selection => ({ kind: 'messages', query, selection }))),
  ];
  cases.push({ name, copies, options, calls: list.map(call => ({ ...call, query: { ...QUERY, ...call.query } })) });
}
const q = query => ({ kind: 'query', query });
const m = (query, selection = {}) => ({ kind: 'messages', query, selection });

add('count fixture', COUNT_FIXTURE, OPTIONS, [
  ...queries.map(q),
  ...['received', 'sent', 'both'].flatMap(direction => {
    const scoped = { direction, senderAddress: 'ana@example.test', timelineBucket: 'week' };
    return [q(scoped), m(scoped), m(scoped, { startDate: '2026-09-09', endDate: '2026-09-09' })];
  }),
  q({ senderAddress: 'ana@example.test', timelineBucket: 'message' }),
  m({ senderAddress: 'ana@example.test' }),
  q({ direction: 'received', timelineBucket: 'week' }),
  m({ senderAddress: 'ana@example.test' }, { senderAddress: 'ben@example.test' }),
  m({}, { startDate: '2026-09-10', endDate: '2026-09-12' }),
  m({}, { senderAddress: ' BEN@EXAMPLE.TEST ' }),
  q({ accountIds: [] }), q({ accountIds: ['deleted-account'] }),
  m({ accountIds: [] }), m({ accountIds: ['deleted-account'] }),
  m({ accountIds: [A, B] }),
  q({ startDate: '2026-09-10' }), q({ startDate: '2026-02-30' }),
  m({}, { startDate: '2026-09-09', endDate: '2026-09-08' }),
  m({}, { startDate: null }),
  q({ timeZone: 'Not/AZone' }), q({ timeZone: 'Not/AZone', accountIds: [] }),
  q({ direction: 'sideways' }),
  q({ timeZone: 'America/New_York' }), q({ timeZone: 'UTC' }), q({ timeZone: 'Asia/Tokyo' }),
  q({ startDate: '2026-08-31', endDate: '2026-09-14', timelineBucket: 'week' }),
]);
add('account scope', [copy(), copy({ accountId: B, uid: 80, receivedAt: '2026-09-07T10:00:00Z' })], OPTIONS, [
  q({ accountIds: [A, B] }), q({ accountIds: [B] }), m({ accountIds: [B] }), m({ accountIds: [A, B] }),
]);
for (const conflict of [
  { from: { address: 'other@example.test', name: 'Ana' } },
  { messageDate: '2026-09-08T19:00:00Z' },
  { subject: 'A different original subject' },
]) add(`conflicting metadata ${JSON.stringify(conflict)}`, [copy(), copy({ mailbox: 'Archive', uid: 99, ...conflict })]);
add('missing metadata needs positive evidence', [
  copy({ messageId: null }), copy({ uid: 2, messageId: null }),
  copy({ mailbox: 'Archive', uid: 3, messageDate: null }),
  copy({ mailbox: 'Archive', uid: 4, from: null }),
  copy({ mailbox: 'Archive', uid: 5, subject: null }),
]);
add('physical provenance and uid generations', [
  copy({ messageId: null }), copy({ source: 'vault', origin: 'local', messageId: null }),
  copy({ uidValidity: 5, messageId: null }),
  copy({ uid: 2, uidValidity: null, messageId: null }),
  copy({ uid: 2, uidValidity: null, messageId: null, source: 'vault' }),
]);
add('identical unknown-generation copies keep distinct keys', [
  copy({ uidValidity: null, messageId: null }), copy({ uidValidity: null, messageId: null }),
]);
add('reused uid', [copy({ source: 'vault', origin: 'local', serverDeleted: true, serverAbsent: true }),
  copy({ messageId: '<reused@test>', uidValidity: 8 })]);
add('incomplete copy does not bridge', [
  copy({ source: 'vault', subject: 'Original' }), copy({ source: 'vault', subject: null }), copy({ subject: 'Replacement' }),
]);
add('address normalization', [
  copy({ from: { address: ' ANA@EXAMPLE.TEST ', name: 'Same' } }),
  copy({ uid: 2, messageId: '<second@test>', from: { address: 'ben@example.test', name: 'Same' } }),
  copy({ uid: 3, messageId: '<plus@test>', from: { address: 'me+plus@example.test', name: 'Me' } }),
]);
add('explicit alias in archived outgoing mail', [copy({ from: { address: ' ALIAS@EXAMPLE.TEST ' },
  mailbox: 'Archive', specialUse: '\\Archive',
  to: [{ address: 'ana@example.test' }, { address: 'me@example.test' }, { address: 'second@example.test' }],
})], { ...OPTIONS, ownAddressesByAccount: { ...OPTIONS.ownAddressesByAccount, [A]: [' ALIAS@EXAMPLE.TEST '] } });
add('dotted gmail login', [copy({ from: { address: 'jdoe@gmail.com' },
  mailbox: 'Archive', specialUse: '\\Archive', to: [{ address: 'ana@example.test' }],
})], { accounts: [{ id: A, email: 'j.doe@gmail.com' }], ownAddressesByAccount: {} });
for (const evidence of [
  { mailbox: 'Custom', specialUse: '\\Sent' },
  { mailbox: 'Custom', specialUse: null, origin: 'local_sent' },
  { mailbox: 'My sent mail', specialUse: null },
]) add(`sent provenance ${JSON.stringify(evidence)}`, [copy({ from: null, to: [{ address: 'ana@example.test' }], ...evidence })],
  { ...OPTIONS, accounts: [{ ...ACCOUNTS[0], sentFolderOverride: 'My sent mail' }] });
for (const state of [
  { specialUse: '\\Drafts' }, { specialUse: '\\Trash' }, { specialUse: '\\Junk' },
  { flags: ['\\Draft'] }, { origin: 'local_draft' },
  { mailbox: 'Outbox', specialUse: null }, { flags: ['queued'] }, { flags: ['failed'] },
  { mailbox: 'Spam', specialUse: null }, { mailbox: 'Work/Deleted Items', specialUse: null },
  { mailbox: 'Outbox', specialUse: null, origin: 'local_sent' }, { flags: ['\\\\Pending'] },
]) add(`excluded ${JSON.stringify(state)}`, [copy({ from: { address: 'me@example.test' }, ...state }),
  copy({ uid: 9, messageId: '<retained@test>' })]);
add('trash copy does not hide archive copy', [copy({ specialUse: '\\Trash' }), copy({ mailbox: 'Archive', specialUse: '\\Archive' })]);
add('self mail', [copy({ from: { address: 'me@example.test' }, sentAt: '2026-09-08T19:00:00Z' })]);
add('unknown recipients', [copy({ specialUse: '\\Sent', to: [], cc: [], bcc: [], from: null })]);
add('date evidence and fallbacks', [
  copy(),
  copy({ uid: 2, messageId: '<fallback-in@test>', receivedAt: null }),
  copy({ uid: 3, messageId: '<fallback-out@test>', specialUse: '\\Sent', from: { address: 'me@example.test' },
    to: [{ address: 'ana@example.test' }], messageDate: null, sentAt: null }),
  copy({ uid: 4, messageId: '<graph@test>', receivedAt: '2026-09-08T10:00:00Z',
    dateEvidence: { received: 'graph-received', sent: 'unknown' } }),
  copy({ uid: 5, messageId: '<sent-fallback@test>', specialUse: '\\Sent', from: { address: 'me@example.test' },
    to: [{ address: 'ben@example.test', name: 'Ben' }], sentAt: '2026-09-07T10:00:00.123456Z',
    dateEvidence: { received: 'unknown', sent: 'header-fallback' } }),
], OPTIONS, [...queries.map(q), q({ startDate: '2026-09-09' }), m({}), m({ direction: 'sent' })]);
const authoritative = [copy({ receivedAt: '2026-09-08T20:00:00Z', dateEvidence: { received: 'rfc-date', sent: 'unknown' } }),
  copy({ source: 'vault', receivedAt: '2026-09-08T21:30:00Z' })];
add('authoritative dates', authoritative);
add('authoritative dates reversed', [...authoritative].reverse());
add('invalid and out-of-range dates', [
  copy({ messageDate: null, receivedAt: null }),
  copy({ uid: 2, messageId: '<invalid@test>', messageDate: 'bad', receivedAt: '2026-02-30T10:00:00Z' }),
  copy({ uid: 3, messageId: '<future@test>', receivedAt: '2027-09-09T00:00:00Z' }),
  copy({ uid: 4, messageId: '<offset@test>', receivedAt: '2026-09-05T23:30:00-04:00' }),
  copy({ uid: 5, messageId: '<bad-offset@test>', receivedAt: '2026-09-05T10:00:00+24:00' }),
  copy({ uid: 6, messageId: '<bad-hour@test>', receivedAt: '2026-09-05T24:00:00Z' }),
  copy({ uid: 7, messageId: '<lower-z@test>', receivedAt: '2026-09-05t10:00:00z' }),
], OPTIONS, [...queries.map(q), m({}), m({}, { startDate: null, endDate: null }),
  q({ startDate: '2027-09-09', endDate: '2027-09-09' })]);
for (const evidence of [
  { listId: '<team.example.test>' }, { listUnsubscribe: '<mailto:leave@example.test>' },
  { precedence: ' BULK ' }, { precedence: 'list' },
  { from: { address: 'No-Reply@example.test' } },
  { from: { address: 'noreply@example.test' } },
  { from: { address: 'do-not-reply@example.test' } },
]) add(`automated ${JSON.stringify(evidence)}`, [copy(evidence), copy({ uid: 2, messageId: '<human@test>', from: { address: 'ben@example.test', name: 'Ben' } })]);
add('lookalike no-reply', [copy({ from: { address: 'noreply-team@example.test', name: 'No reply' }, precedence: 'normal' })]);
add('list header on outgoing', [copy({ from: { address: 'me@example.test' }, to: [{ address: 'ana@example.test' }], listId: '<own-list@test>' })]);
const many = Array.from({ length: 35 }, (_, index) => copy({ uid: index + 1,
  messageId: `<sender-${index}@test>`, from: { address: `person-${String(index).padStart(2, '0')}@example.test` } }));
many.push(copy({ uid: 100, messageId: '<frequent@test>', from: { address: 'person-34@example.test' }, receivedAt: '2026-09-07T10:00:00Z' }));
add('every sender', many, OPTIONS, queries.map(q));
add('count sort', [
  copy({ receivedAt: '2026-09-07T10:00:00Z' }),
  copy({ uid: 2, messageId: '<ana-extra@test>', receivedAt: '2026-09-07T11:00:00Z' }),
  copy({ uid: 3, messageId: '<ben@test>', from: { address: 'ben@example.test', name: 'Ben' } }),
]);
add('name sort', [
  copy({ from: { address: 'ana@example.test', name: 'Zoe' } }),
  copy({ uid: 2, messageId: '<ben@test>', from: { address: 'ben@example.test', name: 'Amy' }, receivedAt: '2026-09-07T10:00:00Z' }),
  copy({ uid: 3, messageId: '<cy@test>', from: { address: 'cy@example.test', name: 'Émile' }, receivedAt: '2026-09-06T10:00:00Z' }),
  copy({ uid: 4, messageId: '<dee@test>', from: { address: 'dee@example.test', name: 'émile' }, receivedAt: '2026-09-05T10:00:00Z' }),
  copy({ uid: 5, messageId: '<eve@test>', from: { address: 'eve@example.test', name: 'ÄNNE' }, receivedAt: '2026-09-04T10:00:00Z' }),
  copy({ uid: 6, messageId: '<fay@test>', from: { address: 'fay@example.test' }, receivedAt: '2026-09-04T10:00:00Z' }),
]);
add('names and recipients', [
  copy({ from: { address: 'ana@example.test', name: '' } }),
  copy({ uid: 2, messageId: '<ana-named@test>', from: { address: 'ana@example.test', name: ' Ana Named ' } }),
  copy({ uid: 3, mailbox: 'Sent', specialUse: '\\Sent', messageId: '<to-many@test>',
    from: { address: 'me@example.test' },
    to: [{ address: 'ZED@example.test' }, { address: 'ana@example.test', name: 'First' }],
    cc: [{ address: 'ana@example.test', name: 'Second' }, { address: 'me@example.test' }],
    bcc: [{ address: 'ana@example.test' }, { address: 'second@example.test', name: 'Me Too' }, { address: '' }],
    receivedAt: null, sentAt: '2026-09-08T08:00:00Z', dateEvidence: { received: 'unknown', sent: 'rfc-date' } }),
], OPTIONS, [...queries.map(q), m({}), m({}, { senderAddress: 'zed@example.test' })]);
add('shared message-id across records is uncertain', [
  copy(), copy({ mailbox: 'Archive', uid: 7, subject: 'Same id, other subject' }),
]);
add('dst and day boundaries', [
  copy({ uid: 1, messageId: '<dst-spring-1@test>', receivedAt: '2026-03-29T00:59:00Z' }),
  copy({ uid: 2, messageId: '<dst-spring-2@test>', receivedAt: '2026-03-29T01:01:00Z' }),
  copy({ uid: 3, messageId: '<dst-autumn-1@test>', receivedAt: '2026-10-25T00:30:00Z' }),
  copy({ uid: 4, messageId: '<dst-autumn-2@test>', receivedAt: '2026-10-25T01:30:00Z' }),
  copy({ uid: 5, messageId: '<dst-midnight@test>', receivedAt: '2026-10-24T21:30:00Z' }),
  copy({ uid: 6, messageId: '<boundary@test>', receivedAt: '2026-09-08T22:30:00Z', messageDate: '2026-09-08T19:00:00Z' }),
  copy({ uid: 7, messageId: '<leap@test>', receivedAt: '2028-02-29T12:00:00+02:00' }),
], OPTIONS, ['Europe/Vilnius', 'America/New_York', 'UTC', 'Australia/Lord_Howe', 'Asia/Kolkata'].flatMap(timeZone => [
  q({ timeZone, startDate: '2026-03-27', endDate: '2026-10-31', timelineBucket: 'week' }),
  q({ timeZone, startDate: '2026-03-27', endDate: '2026-10-31', timelineBucket: 'day' }),
  m({ timeZone, startDate: '2026-03-27', endDate: '2026-10-31' }, { startDate: '2026-10-25', endDate: '2026-10-25' }),
  q({ timeZone, startDate: '2028-02-28', endDate: '2028-03-01' }),
]));

function run(model, call) {
  try {
    return { result: call.kind === 'query' ? queryInsights(model, call.query) : matchingInsightsMessages(model, call.query, call.selection) };
  } catch (error) {
    return { error: error instanceof RangeError ? 'RangeError' : String(error) };
  }
}

const out = cases.map(entry => {
  const model = buildInsightsModel(entry.copies, entry.options);
  return { ...entry, calls: entry.calls.map(call => ({ ...call, ...run(model, call) })) };
});
it.skipIf(!process.env.INSIGHTS_GOLDEN_OUT)('writes the JS model answers for the Rust port', () => {
  writeFileSync(process.env.INSIGHTS_GOLDEN_OUT, `${JSON.stringify({ generatedBy: 'scripts/insights-model-golden.test.mjs', cases: out }, null, 1)}\n`);
});
