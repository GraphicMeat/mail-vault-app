import { describe, expect, it } from 'vitest';
import { A, B, COUNT_FIXTURE, copy } from '../../../../tests/fixtures/insights.js';
import { buildInsightsModel, matchingInsightsMessages, queryInsights } from '../model.js';

const ACCOUNTS = [{ id: A, email: 'me@example.test' }, { id: B, email: 'second@example.test' }];
const OPTIONS = { accounts: ACCOUNTS, ownAddressesByAccount: { [A]: ['me@example.test'], [B]: ['second@example.test'] } };
const QUERY = { accountIds: [A], startDate: '2026-09-01', endDate: '2026-09-09',
  timeZone: 'Europe/Vilnius', direction: 'both', senderAddress: null,
  hideAutomated: false, timelineBucket: 'day', senderSort: 'recent' };
const build = (rows, options = OPTIONS) => buildInsightsModel(rows, options);
const query = (model, overrides = {}) => queryInsights(model, { ...QUERY, ...overrides });
const matches = (model, overrides = {}, selection = {}) => matchingInsightsMessages(model, { ...QUERY, ...overrides }, selection);
const ids = rows => rows.map(row => row.copies[0].messageId).sort();

describe('Insights canonical activity', () => {
  it('deduplicates storage copies without multiplying outgoing activity by recipients', () => {
    const model = build(COUNT_FIXTURE);
    const result = query(model);
    expect(result.totals).toEqual({ received: 3, sent: 1, both: 4 });
    expect(result.senders.map(s => [s.address, s.count]).sort()).toEqual([
      ['ana@example.test', 3], ['ben@example.test', 2],
    ]);
    expect(result.days).toHaveLength(9);
    expect(result.days.find(day => day.date === '2026-09-09')).toEqual({ date: '2026-09-09', sent: 1, received: 3, value: 4 });
    expect(result.days.find(day => day.date === '2026-09-08').value).toBe(0);
    expect(ids(matches(model))).toEqual(['<ana-1@test>', '<ana-2@test>', '<ben-1@test>', '<sent-1@test>']);
    expect(matches(model).find(row => row.copies[0].messageId === '<ana-1@test>').copies).toHaveLength(2);
  });

  it('applies account scope before direction and date evidence from copies', () => {
    const model = build([copy(), copy({ accountId: B, uid: 80, receivedAt: '2026-09-07T10:00:00Z' })]);
    expect(query(model, { accountIds: [A, B] }).totals.both).toBe(1);
    expect(query(model, { accountIds: [B] }).days.find(d => d.value).date).toBe('2026-09-07');
    expect(matches(model, { accountIds: [B] })[0].copies.map(c => c.accountId)).toEqual([B]);
    expect(query(build(COUNT_FIXTURE), { accountIds: [A, B] }).totals).toEqual({ received: 4, sent: 1, both: 5 });
  });

  it('returns zero counts and dated zero cells for empty or unknown account scope', () => {
    const model = build(COUNT_FIXTURE);
    for (const accountIds of [[], ['deleted-account']]) {
      const result = query(model, { accountIds });
      expect(result.totals).toEqual({ received: 0, sent: 0, both: 0 });
      expect(result.days).toHaveLength(9);
      expect(result.senders).toEqual([]);
      expect(matches(model, { accountIds })).toEqual([]);
    }
  });

  it.each([
    { from: { address: 'other@example.test', name: 'Ana' } },
    { messageDate: '2026-09-08T19:00:00Z' },
    { subject: 'A different original subject' },
  ])('does not merge copied Message-IDs with conflicting metadata: %j', conflict => {
    const model = build([copy(), copy({ mailbox: 'Archive', uid: 99, ...conflict })]);
    expect(query(model).totals.received).toBe(2);
    expect(new Set(matches(model).map(row => row.key)).size).toBe(2);
  });

  it('requires positive evidence for cross-folder equality when metadata is missing', () => {
    const model = build([
      copy({ messageId: null }), copy({ uid: 2, messageId: null }),
      copy({ mailbox: 'Archive', uid: 3, messageDate: null }),
      copy({ mailbox: 'Archive', uid: 4, from: null }),
      copy({ mailbox: 'Archive', uid: 5, subject: null }),
    ]);
    expect(query(model).totals.received).toBe(5);
    expect(query(model).uncertainIdentityCount).toBe(5);
  });

  it('uses known physical provenance for missing-ID copies while preserving UID generations', () => {
    const model = build([
      copy({ messageId: null }), copy({ source: 'vault', origin: 'local', messageId: null }),
      copy({ uidValidity: 5, messageId: null }),
      copy({ uid: 2, uidValidity: null, messageId: null }),
      copy({ uid: 2, uidValidity: null, messageId: null, source: 'vault' }),
    ]);
    expect(query(model).totals.received).toBe(4);
    expect(matches(model).map(row => row.copies.length).sort()).toEqual([1, 1, 1, 2]);
  });

  it('retains an older vault message after the server reuses its UID', () => {
    const old = copy({ source: 'vault', origin: 'local', serverDeleted: true, serverAbsent: true });
    const newer = copy({ messageId: '<reused@test>', uidValidity: 8 });
    const model = build([old, newer]);
    expect(query(model).totals.received).toBe(2);
    expect(ids(matches(model))).toEqual(['<ana-1@test>', '<reused@test>']);
    expect(matches(model).find(row => row.copies[0].messageId === '<ana-1@test>').copies).toEqual([old]);
  });

  it('does not allow an incomplete physical copy to bridge conflicting records', () => {
    const model = build([
      copy({ source: 'vault', subject: 'Original' }),
      copy({ source: 'vault', subject: null }),
      copy({ subject: 'Replacement' }),
    ]);
    expect(query(model).totals.received).toBe(2);
  });

  it('normalizes addresses without merging equal display names or guessing aliases', () => {
    const model = build([
      copy({ from: { address: ' ANA@EXAMPLE.TEST ', name: 'Same' } }),
      copy({ uid: 2, messageId: '<second@test>', from: { address: 'ben@example.test', name: 'Same' } }),
      copy({ uid: 3, messageId: '<plus@test>', from: { address: 'me+plus@example.test', name: 'Me' } }),
    ]);
    expect(query(model).senders.map(s => s.address).sort()).toEqual(['ana@example.test', 'ben@example.test', 'me+plus@example.test']);
  });

  it('recognizes explicit aliases in archived outgoing mail and removes all own recipients', () => {
    const model = build([copy({ from: { address: ' ALIAS@EXAMPLE.TEST ' },
      mailbox: 'Archive', specialUse: '\\Archive',
      to: [{ address: 'ana@example.test' }, { address: 'me@example.test' }, { address: 'second@example.test' }],
    })], { ...OPTIONS, ownAddressesByAccount: { ...OPTIONS.ownAddressesByAccount, [A]: [' ALIAS@EXAMPLE.TEST '] } });
    expect(query(model).totals).toEqual({ received: 1, sent: 1, both: 2 });
    expect(query(model).senders.map(s => [s.address, s.count])).toEqual([['ana@example.test', 1]]);
  });

  it.each([
    { mailbox: 'Custom', specialUse: '\\Sent' },
    { mailbox: 'Custom', specialUse: null, origin: 'local_sent' },
    { mailbox: 'My sent mail', specialUse: null },
  ])('recognizes explicit sent provenance even without a known From identity: %j', evidence => {
    const model = build([copy({ from: null, to: [{ address: 'ana@example.test' }], ...evidence })],
      { ...OPTIONS, accounts: [{ ...ACCOUNTS[0], sentFolderOverride: 'My sent mail' }] });
    expect(query(model).totals).toEqual({ received: 0, sent: 1, both: 1 });
    expect(query(model).senders[0].address).toBe('ana@example.test');
  });

  it.each([
    { specialUse: '\\Drafts' }, { specialUse: '\\Trash' }, { specialUse: '\\Junk' },
    { flags: ['\\Draft'] }, { origin: 'local_draft' },
    { mailbox: 'Outbox', specialUse: null }, { flags: ['queued'] }, { flags: ['failed'] },
  ])('excludes draft, trash, junk, and unsent outbox copies: %j', state => {
    const model = build([copy({ from: { address: 'me@example.test' }, ...state }),
      copy({ uid: 9, messageId: '<retained@test>' })]);
    expect(ids(matches(model))).toEqual(['<retained@test>']);
    expect(query(model).totals.both).toBe(1);
  });

  it('does not let a trash copy hide the included archive copy', () => {
    const model = build([copy({ specialUse: '\\Trash' }), copy({ mailbox: 'Archive', specialUse: '\\Archive' })]);
    expect(query(model).totals.received).toBe(1);
    expect(matches(model)[0].copies).toHaveLength(2);
  });

  it('counts self-mail once in each direction, without a self bubble', () => {
    const model = build([copy({ from: { address: 'me@example.test' }, sentAt: '2026-09-08T19:00:00Z' })]);
    expect(query(model).totals).toEqual({ received: 1, sent: 1, both: 2 });
    expect(query(model).senders).toEqual([]);
    expect(matches(model)).toHaveLength(2);
    expect(new Set(matches(model).map(row => row.key)).size).toBe(2);
    expect(query(model).days.filter(d => d.value)).toEqual([
      { date: '2026-09-08', sent: 1, received: 0, value: 1 },
      { date: '2026-09-09', sent: 0, received: 1, value: 1 },
    ]);
  });

  it('counts outgoing mail with unknown recipients without inventing a correspondent', () => {
    const model = build([copy({ specialUse: '\\Sent', to: [], cc: [], bcc: [], from: null })]);
    expect(query(model).totals.sent).toBe(1);
    expect(query(model).senders).toEqual([]);
  });

  it('uses receive and send evidence independently and labels only actual fallbacks', () => {
    const model = build([
      copy(),
      copy({ uid: 2, messageId: '<fallback-in@test>', receivedAt: null }),
      copy({ uid: 3, messageId: '<fallback-out@test>', specialUse: '\\Sent', from: { address: 'me@example.test' },
        to: [{ address: 'ana@example.test' }], messageDate: null, sentAt: null }),
      copy({ uid: 4, messageId: '<graph@test>', receivedAt: '2026-09-08T10:00:00Z',
        dateEvidence: { received: 'graph-received', sent: 'unknown' } }),
    ]);
    expect(query(model).fallbackDateCount).toBe(2);
    expect(query(model).days.filter(d => d.value)).toEqual([
      { date: '2026-09-08', sent: 0, received: 2, value: 2 },
      { date: '2026-09-09', sent: 1, received: 1, value: 2 },
    ]);
    expect(query(model, { startDate: '2026-09-09' }).fallbackDateCount).toBe(1);
  });

  it('prefers authoritative dates over cached RFC fallback evidence independent of input order', () => {
    const rows = [copy({ receivedAt: '2026-09-08T20:00:00Z', dateEvidence: { received: 'rfc-date', sent: 'unknown' } }),
      copy({ source: 'vault', receivedAt: '2026-09-08T21:30:00Z' })];
    expect(query(build(rows)).totals.received).toBe(1);
    expect(query(build(rows)).days.find(d => d.value).date).toBe('2026-09-09');
    expect(query(build(rows)).fallbackDateCount).toBe(0);
    expect(matches(build(rows)).map(row => row.key)).toEqual(matches(build([...rows].reverse())).map(row => row.key));
  });

  it('keeps invalid dates reachable separately and excludes dates outside the range without clamping', () => {
    const model = build([
      copy({ messageDate: null, receivedAt: null }),
      copy({ uid: 2, messageId: '<invalid@test>', messageDate: 'bad', receivedAt: '2026-02-30T10:00:00Z' }),
      copy({ uid: 3, messageId: '<future@test>', receivedAt: '2027-09-09T00:00:00Z' }),
    ]);
    const result = query(model);
    expect(result.totals.both).toBe(0);
    expect(result.unknownDateCount).toBe(2);
    expect(result.days.every(d => d.value === 0)).toBe(true);
    expect(result.lanes).toEqual([]);
    expect(matches(model)).toEqual([]);
    expect(ids(matches(model, {}, { startDate: null, endDate: null }))).toEqual(['<ana-1@test>', '<invalid@test>']);
    expect(query(model, { startDate: '2027-09-09', endDate: '2027-09-09' }).totals.received).toBe(1);
  });

  it.each([
    { listId: '<team.example.test>' }, { listUnsubscribe: '<mailto:leave@example.test>' },
    { precedence: ' BULK ' }, { precedence: 'list' },
    { from: { address: 'No-Reply@example.test' } },
    { from: { address: 'noreply@example.test' } },
    { from: { address: 'do-not-reply@example.test' } },
  ])('hides likely automated senders only with inspectable evidence: %j', evidence => {
    const model = build([copy(evidence)]);
    expect(query(model).totals.received).toBe(1);
    expect(query(model).senders[0].automationEvidence.length).toBeGreaterThan(0);
    expect(query(model, { hideAutomated: true }).totals.received).toBe(0);
    expect(matches(model, { hideAutomated: true })).toEqual([]);
  });

  it('keeps unknown classifications and lookalike no-reply names visible', () => {
    const model = build([copy({ from: { address: 'noreply-team@example.test', name: 'No reply' }, precedence: 'normal' })]);
    expect(query(model, { hideAutomated: true }).totals.received).toBe(1);
    expect(query(model).senders[0].automationEvidence).toEqual([]);
  });

  it('does not classify external recipients using list headers on an outgoing message', () => {
    const model = build([copy({ from: { address: 'me@example.test' }, to: [{ address: 'ana@example.test' }], listId: '<own-list@test>' })]);
    expect(query(model, { hideAutomated: true }).totals.sent).toBe(1);
    expect(query(model).senders[0].automationEvidence).toEqual([]);
  });

  it.each(['received', 'sent', 'both'])('keeps sender, day, lane bucket, and drill-down keys aligned for %s', direction => {
    const model = build(COUNT_FIXTURE);
    const scoped = { direction, senderAddress: 'ana@example.test', timelineBucket: 'week' };
    const result = query(model, scoped);
    const expected = direction === 'received' ? 2 : direction === 'sent' ? 1 : 3;
    const allKeys = matches(model, scoped).map(row => row.key).sort();
    expect(result.days.reduce((sum, day) => sum + day.value, 0)).toBe(expected);
    expect(result.senders.map(row => [row.address, row.count])).toEqual([['ana@example.test', expected]]);
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0].buckets.map(bucket => [bucket.startDate, bucket.endDate])).toEqual([['2026-09-07', '2026-09-09']]);
    expect(result.lanes[0].buckets.flatMap(bucket => bucket.keys).sort()).toEqual(allKeys);
    expect(matches(model, scoped, { startDate: '2026-09-09', endDate: '2026-09-09' }).map(row => row.key).sort()).toEqual(allKeys);
  });

  it('keeps both direction totals beside a single selected activity measure', () => {
    const result = query(build(COUNT_FIXTURE), { direction: 'received' });
    expect(result.totals).toEqual({ received: 3, sent: 1, both: 4 });
    expect(result.days.find(d => d.date === '2026-09-09')).toEqual({ date: '2026-09-09', received: 3, sent: 1, value: 3 });
    expect(result.senders.find(s => s.address === 'ana@example.test')).toMatchObject({ received: 2, sent: 1, count: 2 });
  });

  it('exposes exact instants and directions when the timeline zooms to messages', () => {
    const model = build(COUNT_FIXTURE);
    const result = query(model, { senderAddress: 'ana@example.test', timelineBucket: 'message' });
    expect(result.lanes).toHaveLength(1);
    const events = result.lanes[0].buckets.flatMap(bucket => bucket.events);
    expect(events.map(event => [event.at, event.direction]).sort()).toEqual([
      ['2026-09-08T21:30:00.000Z', 'received'],
      ['2026-09-08T21:30:00.000Z', 'received'],
      ['2026-09-08T21:40:00.000Z', 'sent'],
    ]);
    expect(events.map(event => event.key).sort()).toEqual(matches(model, { senderAddress: 'ana@example.test' }).map(row => row.key).sort());
  });

  it('preserves exact lane recency and name when several correspondents share a week', () => {
    const result = query(build(COUNT_FIXTURE), { direction: 'received', timelineBucket: 'week' });
    expect(result.lanes.map(lane => [lane.address, lane.name, lane.lastAt])).toEqual([
      ['ana@example.test', 'Ana', '2026-09-08T21:30:00.000Z'],
      ['ben@example.test', 'Ben', '2026-09-08T21:30:00.000Z'],
    ]);
  });

  it('keeps a drilldown selection inside the original scope', () => {
    const model = build(COUNT_FIXTURE);
    expect(matches(model, { senderAddress: 'ana@example.test' }, { senderAddress: 'ben@example.test' })).toEqual([]);
    expect(matches(model, {}, { startDate: '2026-09-10', endDate: '2026-09-12' })).toEqual([]);
    expect(ids(matches(model, {}, { senderAddress: ' BEN@EXAMPLE.TEST ' }))).toEqual(['<ben-1@test>', '<sent-1@test>']);
  });

  it('returns every sender and sorts by selected-direction recency or volume', () => {
    const rows = Array.from({ length: 35 }, (_, index) => copy({ uid: index + 1,
      messageId: `<sender-${index}@test>`, from: { address: `person-${String(index).padStart(2, '0')}@example.test` } }));
    rows.push(copy({ uid: 100, messageId: '<frequent@test>', from: { address: 'person-34@example.test' }, receivedAt: '2026-09-07T10:00:00Z' }));
    const model = build(rows);
    expect(query(model).senders).toHaveLength(35);
    expect(query(model).senders[0].address).toBe('person-00@example.test');
    expect(query(model, { senderSort: 'volume' }).senders[0].address).toBe('person-34@example.test');
    expect(query(model).totals.received).toBe(36);
  });

  it('uses the count sort requested by the timeline controls', () => {
    const model = build([
      copy({ receivedAt: '2026-09-07T10:00:00Z' }),
      copy({ uid: 2, messageId: '<ana-extra@test>', receivedAt: '2026-09-07T11:00:00Z' }),
      copy({ uid: 3, messageId: '<ben@test>', from: { address: 'ben@example.test', name: 'Ben' } }),
    ]);
    expect(query(model, { senderSort: 'count' }).senders.map(sender => [sender.address, sender.count])).toEqual([
      ['ana@example.test', 2], ['ben@example.test', 1],
    ]);
  });

  it('sorts by displayed sender name when name differs from address and recency', () => {
    const model = build([
      copy({ from: { address: 'ana@example.test', name: 'Zoe' } }),
      copy({ uid: 2, messageId: '<ben@test>', from: { address: 'ben@example.test', name: 'Amy' }, receivedAt: '2026-09-07T10:00:00Z' }),
    ]);
    expect(query(model, { senderSort: 'name' }).senders.map(sender => sender.name)).toEqual(['Amy', 'Zoe']);
  });

  it('rejects reversed or impossible custom date ranges', () => {
    const model = build(COUNT_FIXTURE);
    expect(() => query(model, { startDate: '2026-09-10' })).toThrow(RangeError);
    expect(() => query(model, { startDate: '2026-02-30' })).toThrow(RangeError);
    expect(() => matches(model, {}, { startDate: '2026-09-09', endDate: '2026-09-08' })).toThrow(RangeError);
  });
});
