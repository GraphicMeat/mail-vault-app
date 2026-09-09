import { identitySet } from '../emailParser.js';
import { calendarCell, calendarDays, localDateKey } from './calendar.js';

/**
 * @typedef {{address: string, name?: string}} Address
 * @typedef {Object} HeaderCopy
 * @property {string} accountId
 * @property {string} mailbox
 * @property {number} uid
 * @property {number|null} uidValidity Unknown generation remains null.
 * @property {'server-cache'|'vault'} source
 * @property {string|null} origin Preserves local_sent/local_draft provenance.
 * @property {string|null} messageId
 * @property {Address|null} from
 * @property {Address[]} to
 * @property {Address[]} cc
 * @property {Address[]} bcc
 * @property {string|null} subject
 * @property {string|null} messageDate
 * @property {string|null} receivedAt
 * @property {string|null} sentAt
 * @property {{received: string, sent: string}} dateEvidence
 * @property {string[]} flags
 * @property {string|null} specialUse
 * @property {string|null} listId
 * @property {string|null} listUnsubscribe
 * @property {string|null} precedence
 * @property {boolean} serverDeleted
 * @property {boolean} serverAbsent
 *
 * @typedef {Object} InsightsQuery
 * @property {string[]} accountIds
 * @property {string} startDate Inclusive local YYYY-MM-DD.
 * @property {string} endDate Inclusive local YYYY-MM-DD.
 * @property {string} timeZone
 * @property {'received'|'sent'|'both'} direction
 * @property {string|null} senderAddress
 * @property {boolean} hideAutomated
 * @property {'day'|'week'|'message'} timelineBucket
 * @property {'recent'|'count'|'name'|'volume'} senderSort volume remains an alias for count.
 *
 * @typedef {{address:string,name:string,count:number,sent:number,received:number,
 * lastAt:string|null,automationEvidence:string[]}} InsightsSender
 * @typedef {{date:string,sent:number,received:number,value:number}} InsightsDay
 * @typedef {{startDate:string,endDate:string,sent:number,received:number,keys:string[],
 * events?:{key:string,at:string,direction:'received'|'sent'}[]}} InsightsBucket
 * @typedef {{totals:{sent:number,received:number,both:number},senders:InsightsSender[],
 * days:InsightsDay[],lanes:{address:string,name?:string,lastAt?:string|null,buckets:InsightsBucket[]}[],
 * unknownDateCount:number,fallbackDateCount:number,uncertainIdentityCount:number}} InsightsResult
 */

const clean = value => typeof value === 'string' ? value.trim() : '';
const addressOf = value => clean(value).toLowerCase();
const token = value => addressOf(value).replace(/^\\+/, '');
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const directionSelected = (event, query) => query.direction === 'both' || event.direction === query.direction;
const instant = value => localDateKey(value, 'UTC') ? new Date(value).toISOString() : null;
const positiveInteger = value => Number.isInteger(value) && value > 0;

function address(value) {
  return { address: addressOf(value?.address), name: clean(value?.name) };
}

function recipients(copy) {
  const byAddress = new Map();
  for (const person of [...(copy.to || []), ...(copy.cc || []), ...(copy.bcc || [])].map(address)) {
    if (person.address && (!byAddress.has(person.address) || person.name)) byAddress.set(person.address, person);
  }
  return [...byAddress.values()].sort((a, b) => compare(a.address, b.address));
}

function dateFor(row, direction) {
  if (direction === 'received') {
    if (row.receivedAt) {
      return { at: row.receivedAt, fallback: !['imap-internaldate', 'graph-received', 'graph-receivedDateTime'].includes(row.copy.dateEvidence?.received) };
    }
    return { at: row.messageDate, fallback: !!row.messageDate };
  }
  if (row.sentAt) {
    const evidence = row.copy.dateEvidence?.sent;
    return { at: row.sentAt, fallback: !['rfc-date', 'graph-sent', 'graph-sentDateTime'].includes(evidence) };
  }
  if (row.messageDate) return { at: row.messageDate, fallback: false };
  return { at: row.receivedAt, fallback: !!row.receivedAt };
}

function normalize(copy, account, own) {
  const from = address(copy.from);
  const people = recipients(copy);
  const specialUse = token(copy.specialUse);
  const folder = addressOf(copy.mailbox).split('/').pop();
  const flags = new Set((copy.flags || []).map(token));
  const unsent = ['draft', 'queued', 'failed', 'pending'].some(flag => flags.has(flag));
  const excluded = ['drafts', 'trash', 'junk'].includes(specialUse)
    || ['drafts', 'trash', 'junk', 'spam', 'deleted items'].includes(folder)
    || copy.origin === 'local_draft' || unsent
    || ((specialUse === 'outbox' || folder === 'outbox') && copy.origin !== 'local_sent');
  const sent = copy.origin === 'local_sent' || specialUse === 'sent'
    || (account?.sentFolderOverride && account.sentFolderOverride === copy.mailbox)
    || own.has(from.address);
  const received = !sent || people.some(person => own.has(person.address));
  const row = { copy, from, recipients: people, excluded, sent: !!sent, received,
    messageId: clean(copy.messageId), subject: clean(copy.subject),
    messageDate: instant(copy.messageDate), receivedAt: instant(copy.receivedAt), sentAt: instant(copy.sentAt) };
  row.equality = [row.messageId, row.from.address, row.messageDate, row.subject];
  row.fingerprint = row.equality.every(Boolean) ? JSON.stringify(row.equality) : null;
  row.physical = copy.accountId && copy.mailbox && positiveInteger(copy.uid) && positiveInteger(copy.uidValidity)
    ? JSON.stringify([copy.accountId, copy.mailbox, copy.uid, copy.uidValidity]) : null;
  row.stable = JSON.stringify([copy.accountId, copy.mailbox, copy.uid, copy.uidValidity,
    ...row.equality, copy.source, copy.origin, row.receivedAt, row.sentAt]);
  return row;
}

function compatible(left, right) {
  return left.equality.every((value, index) => !value || !right.equality[index] || value === right.equality[index]);
}

/** Normalize once; retain physical copies without changing their custody fields. */
export function buildInsightsModel(copies, { accounts = [], ownAddressesByAccount = {} } = {}) {
  const byAccount = new Map(accounts.map(account => [account.id, account]));
  const identities = new Map(accounts.map(account => [account.id,
    identitySet([account.email, ...identitySet(ownAddressesByAccount[account.id])]) ]));
  const allOwn = new Set([...identities.values()].flatMap(values => [...values]));
  const rows = (copies || []).map(copy => normalize(copy, byAccount.get(copy.accountId), identities.get(copy.accountId) || new Set()))
    .sort((a, b) => Number(!!b.fingerprint) - Number(!!a.fingerprint) || compare(a.stable, b.stable));
  const records = [];
  const byFingerprint = new Map();
  const byPhysical = new Map();
  for (const row of rows) {
    const candidates = new Set([
      ...(byFingerprint.get(row.fingerprint) || []), ...(byPhysical.get(row.physical) || []),
    ]);
    const record = [...candidates].find(candidate => candidate.rows.every(other => compatible(row, other)));
    const target = record || { rows: [], key: row.fingerprint ? `message:${row.fingerprint}` : `physical:${row.stable}` };
    if (!record) records.push(target);
    target.rows.push(row);
    for (const [index, key] of [[byFingerprint, row.fingerprint], [byPhysical, row.physical]]) {
      if (!key) continue;
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(target);
    }
  }
  // Two unknown-generation copies may have identical headers and locators but
  // still lack positive equality evidence; keep their keys distinct as well.
  const occurrences = new Map();
  for (const record of records) {
    const occurrence = occurrences.get(record.key) || 0;
    occurrences.set(record.key, occurrence + 1);
    if (occurrence) record.key += `:copy-${occurrence}`;
  }
  return { records, accountIds: new Set(byAccount.keys()), allOwn };
}

function mailboxEvidence(address) {
  return /^(no-reply|noreply|do-not-reply)@/i.test(address) ? ['no-reply mailbox'] : [];
}

function receivedEvidence(row) {
  const evidence = mailboxEvidence(row.from.address);
  if (clean(row.copy.listId)) evidence.push(`List-Id: ${clean(row.copy.listId)}`);
  if (clean(row.copy.listUnsubscribe)) evidence.push(`List-Unsubscribe: ${clean(row.copy.listUnsubscribe)}`);
  if (['bulk', 'list'].includes(addressOf(row.copy.precedence))) evidence.push(`Precedence: ${addressOf(row.copy.precedence)}`);
  return evidence;
}

function scopedEvents(model, accountIds) {
  const scope = new Set((accountIds || []).filter(id => model.accountIds.has(id)));
  const events = [];
  const evidence = new Map();
  const messageIds = new Map();
  const addEvidence = (person, entries) => {
    if (!evidence.has(person)) evidence.set(person, new Set());
    for (const entry of entries) evidence.get(person).add(entry);
  };
  for (const record of model.records) {
    const scoped = record.rows.filter(row => scope.has(row.copy.accountId));
    const included = scoped.filter(row => !row.excluded);
    if (!included.length) continue;
    const uncertain = !included.some(row => row.fingerprint);
    for (const id of new Set(included.map(row => row.messageId).filter(Boolean))) {
      if (!messageIds.has(id)) messageIds.set(id, new Set());
      messageIds.get(id).add(record.key);
    }
    for (const direction of ['received', 'sent']) {
      const rows = included.filter(row => row[direction]);
      if (!rows.length) continue;
      const correspondents = new Map();
      for (const row of rows) {
        const people = direction === 'received' ? [row.from] : row.recipients;
        for (const person of people) {
          if (!person.address || model.allOwn.has(person.address)) continue;
          const previous = correspondents.get(person.address);
          if (!previous || (!previous.name && person.name)) correspondents.set(person.address, person);
          addEvidence(person.address, direction === 'received' ? receivedEvidence(row) : mailboxEvidence(person.address));
        }
      }
      const dates = rows.map(row => dateFor(row, direction)).filter(date => date.at)
        .sort((a, b) => Number(a.fallback) - Number(b.fallback) || compare(a.at, b.at));
      const chosen = dates[0] || { at: null, fallback: false };
      events.push({ key: `${record.key}:${direction}`, recordKey: record.key,
        direction, at: chosen.at, fallback: chosen.fallback, uncertain,
        messageIds: rows.map(row => row.messageId), correspondents,
        copies: scoped.map(row => row.copy), subject: rows.find(row => row.subject)?.copy.subject || '',
        from: rows.find(row => row.from.address)?.copy.from || null });
    }
  }
  for (const event of events) {
    if (event.messageIds.some(id => messageIds.get(id)?.size > 1)) event.uncertain = true;
  }
  return { events, evidence };
}

function prepare(model, query) {
  const dates = calendarDays(query.startDate, query.endDate);
  // Validate the timezone even when an empty scope contains no dated events.
  localDateKey(null, query.timeZone);
  if (!['received', 'sent', 'both'].includes(query.direction)) throw new RangeError('Invalid Insights direction');
  const { events, evidence } = scopedEvents(model, query.accountIds);
  const sender = addressOf(query.senderAddress);
  const filtered = [];
  for (const event of events) {
    const correspondents = new Map([...event.correspondents].filter(([person]) => !query.hideAutomated || !evidence.get(person)?.size));
    if (query.hideAutomated && event.correspondents.size && !correspondents.size) continue;
    if (sender && !correspondents.has(sender)) continue;
    filtered.push({ ...event, correspondents, date: localDateKey(event.at, query.timeZone) });
  }
  return { dates, evidence, sender, events: filtered };
}

/**
 * @param {ReturnType<typeof buildInsightsModel>} model
 * @param {InsightsQuery} query
 * @returns {InsightsResult}
 * Totals retain both directions; chart value/count and warning counts use the
 * selected direction. Unknown dates are separate from the selected date range.
 */
export function queryInsights(model, query) {
  const prepared = prepare(model, query);
  const dated = prepared.events.filter(event => event.date && event.date >= query.startDate && event.date <= query.endDate);
  const selected = dated.filter(event => directionSelected(event, query));
  const unknown = prepared.events.filter(event => !event.date && directionSelected(event, query));
  const received = new Set(dated.filter(event => event.direction === 'received').map(event => event.key));
  const sent = new Set(dated.filter(event => event.direction === 'sent').map(event => event.key));
  const totals = { sent: sent.size, received: received.size, both: sent.size + received.size };
  const byDay = new Map(prepared.dates.map(date => [date, { date, sent: 0, received: 0, value: 0 }]));
  const bySender = new Map();
  for (const event of dated) {
    byDay.get(event.date)[event.direction] += 1;
    for (const [person, details] of event.correspondents) {
      if (prepared.sender && person !== prepared.sender) continue;
      if (!bySender.has(person)) bySender.set(person, {
        address: person, name: details.name || person, count: 0, sent: 0, received: 0, lastAt: null,
        automationEvidence: [...(prepared.evidence.get(person) || [])].sort(),
      });
      const sender = bySender.get(person);
      if (details.name && sender.name === person) sender.name = details.name;
      sender[event.direction] += 1;
      if (directionSelected(event, query)) {
        sender.count += 1;
        if (!sender.lastAt || event.at > sender.lastAt) sender.lastAt = event.at;
      }
    }
  }
  const days = [...byDay.values()];
  for (const day of days) day.value = query.direction === 'both' ? day.received + day.sent : day[query.direction];
  const senders = [...bySender.values()].filter(sender => sender.count).sort((a, b) =>
    (query.senderSort === 'name' ? compare(a.name.toLocaleLowerCase(), b.name.toLocaleLowerCase())
      : ['count', 'volume'].includes(query.senderSort) ? b.count - a.count : 0)
      || compare(b.lastAt || '', a.lastAt || '') || compare(a.address, b.address));

  const bounds = new Map();
  const dateBuckets = new Map();
  for (const date of prepared.dates) {
    const id = query.timelineBucket === 'week' ? calendarCell(date, query.startDate).week : date;
    if (!bounds.has(id)) bounds.set(id, { startDate: date, endDate: date });
    bounds.get(id).endDate = date;
    dateBuckets.set(date, id);
  }
  const laneBuckets = new Map(senders.map(sender => [sender.address, new Map()]));
  for (const event of selected) {
    for (const person of event.correspondents.keys()) {
      const lane = laneBuckets.get(person);
      if (!lane) continue;
      const id = dateBuckets.get(event.date);
      if (!lane.has(id)) lane.set(id, { ...bounds.get(id), sent: 0, received: 0, keys: [],
        ...(query.timelineBucket !== 'week' ? { events: [] } : {}) });
      const bucket = lane.get(id);
      bucket[event.direction] += 1;
      bucket.keys.push(event.key);
      bucket.events?.push({ key: event.key, at: event.at, direction: event.direction });
    }
  }
  const lanes = senders.map(sender => ({ address: sender.address, name: sender.name, lastAt: sender.lastAt,
    buckets: [...laneBuckets.get(sender.address).values()].sort((a, b) => compare(a.startDate, b.startDate))
      .map(bucket => ({ ...bucket, keys: bucket.keys.sort(),
        ...(bucket.events ? { events: bucket.events.sort((a, b) => compare(a.at, b.at) || compare(a.key, b.key)) } : {}) })),
  }));
  return { totals, senders, days, lanes, unknownDateCount: unknown.length,
    fallbackDateCount: selected.filter(event => event.fallback).length,
    uncertainIdentityCount: new Set([...selected, ...unknown].filter(event => event.uncertain).map(event => event.recordKey)).size };
}

/**
 * Return one message match per direction event. Selecting {startDate:null,
 * endDate:null} explicitly opens Unknown date; omitted dates use query bounds.
 * Every match preserves selected-account physical copies for the existing reader.
 * @returns {{key:string,copies:HeaderCopy[],subject:string,from:Address|null,eventAt:string|null}[]}
 */
export function matchingInsightsMessages(model, query, selection = {}) {
  const prepared = prepare(model, query);
  const unknownOnly = selection.startDate === null && selection.endDate === null;
  const start = selection.startDate === undefined ? query.startDate : selection.startDate;
  const end = selection.endDate === undefined ? query.endDate : selection.endDate;
  if (!unknownOnly) calendarDays(start, end);
  const sender = addressOf(selection.senderAddress);
  if (sender && prepared.sender && sender !== prepared.sender) return [];
  return prepared.events.filter(event => directionSelected(event, query)
    && (!sender || event.correspondents.has(sender))
    && (unknownOnly ? !event.date : event.date && event.date >= query.startDate
      && event.date <= query.endDate && event.date >= start && event.date <= end))
    .sort((a, b) => compare(b.at || '', a.at || '') || compare(a.key, b.key))
    .map(event => ({ key: event.key, copies: event.copies, subject: event.subject, from: event.from, eventAt: event.at }));
}
