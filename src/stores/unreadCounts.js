// Raw count observations cross one ordered native lane. Settings remains the
// only durable writer of the resulting per-account projection.
import { useSettingsStore } from './settingsStore';
import { useSnoozeStore } from './snoozeStore';
import { useFollowUpStore } from './followUpStore';
import { useTagStore } from './tagStore';
import { useAutoTagStore } from './autoTagStore';
import { useViewHideStore } from './viewHideStore';
import { accountExpectedContext } from '../services/db/accounts';
import { submitUnread } from '../services/unreadCountsClient';

let listStore = null;
export function setListStore(store) { listStore = store; }
const list = () => listStore?.getState() || {};

const pick = (source, fields) => Object.fromEntries(fields
  .filter(field => source && Object.hasOwn(source, field))
  .map(field => [field, source[field]]));
const minimalRow = row => pick(row, ['uid','flags','messageId','_accountId','_srcAccountId','_mailbox','isArchived']);
const minimalCache = cache => cache == null ? null : {
  ...pick(cache, ['totalEmails']),
  ...(Object.hasOwn(cache, 'emails') ? { emails: Array.isArray(cache.emails)
    ? cache.emails.map(minimalRow) : cache.emails } : {}),
};
const reminders = rows => (rows || []).map(row => pick(row,
  ['id','accountId','state','sentMailbox','sentUid','seen','announced']));
const snoozes = rows => (rows || []).map(row => pick(row,
  ['id','accountId','fromMailbox','snoozedMailbox','messageId','state']));
const rules = rows => (rows || []).map(row => pick(row,['tagId','enabled','inboxAction']));
const setArray = value => value == null ? null : Array.from(value);

export function rawUnreadProjection() {
  const mail = list();
  const settings = useSettingsStore.getState();
  return {
    archivedKeys: setArray(mail.archivedEmailIds),
    deleteTombstones: setArray(mail.deleteTombstones),
    snoozes: snoozes(useSnoozeStore.getState().rows),
    autoTagRules: rules(useAutoTagStore.getState().rules),
    tagsByRow: Object.fromEntries(Object.entries(useTagStore.getState().byRow || {})
      .map(([key, ids]) => [key, [...ids]])),
    viewHiddenKeys: setArray(useViewHideStore.getState().keys),
    hideViewMail: !!settings.hideViewMail,
    followUps: reminders(useFollowUpStore.getState().rows),
  };
}
function presentation() {
  const settings = useSettingsStore.getState();
  return {
    accounts: (list().accounts || []).map(a => pick(a,['id','name','email'])),
    hiddenAccounts: { ...(settings.hiddenAccounts || {}) },
    displayNames: { ...(settings.displayNames || {}) },
    accountOrder: [...(settings.accountOrder || [])],
  };
}
function originalBound(accountIds) {
  if (!listStore || !accountIds.length) return {};
  const expected = new Map();
  for (const id of accountIds) {
    const account = (list().accounts || []).find(a => a.id === id);
    if (!account) return { invalid: () => true };
    expected.set(id, JSON.stringify(accountExpectedContext(account,'all')));
  }
  let stale = false;
  const check = () => {
    for (const [id, context] of expected) {
      const current = (list().accounts || []).find(a => a.id === id);
      if (!current || JSON.stringify(accountExpectedContext(current,'all')) !== context) stale = true;
    }
  };
  const unsubscribe = listStore.subscribe(check);
  return { invalid: () => { check(); return stale; }, cleanup: unsubscribe };
}
function send(request, accounts = [], coalesceKey = null, freshRequest = null) {
  return submitUnread(request, { presentation, ...originalBound(accounts), coalesceKey,
    accounts, freshRequest });
}

export function recountInbox(accountId, cache) {
  return send({ op:'recountRows', accountId, cache:minimalCache(cache), projection:rawUnreadProjection() },
    [accountId], `rows:${accountId}`)
    .then(answer => !!answer?.wrote);
}
export function recountNativeInbox(accountId, { preferredRows, arrivalCount, change } = {}) {
  const request = { op:'recountCache', accountId, projection:rawUnreadProjection(),
    ...(preferredRows !== undefined ? { preferredRows:minimalCache(preferredRows) } : {}),
    ...(arrivalCount !== undefined ? { arrivalCount } : {}),
    ...(change !== undefined ? { change } : {}) };
  return send(request,[accountId], arrivalCount || change ? null : `cache:${accountId}`,
    () => ({ op:'recountCache', accountId, projection:rawUnreadProjection() }))
    .then(answer => !!answer?.wrote);
}
export function shiftInbox(entries, sign, mode = 'changedReadState') {
  const raw = (entries || []).map(entry => ({ accountId:entry.accountId,
    mailbox:entry.mailbox, row:minimalRow(entry.row) }));
  return send({ op:'shift', entries:raw, sign, mode, projection:rawUnreadProjection() },
    [...new Set(raw.map(row => row.accountId).filter(Boolean))]).then(answer => !!answer?.wrote);
}
export function shiftFollowUps(before, after) {
  const rawBefore=reminders(before), rawAfter=reminders(after);
  return send({ op:'followUps', before:rawBefore, after:rawAfter },
    [...new Set([...rawBefore,...rawAfter].map(row => row.accountId).filter(Boolean))])
    .then(answer => !!answer?.wrote);
}
export function addArrivals(accountId, count) {
  return send({ op:'merge', kind:'arrivals', accountId, count },[accountId])
    .then(answer => !!answer?.wrote);
}
export function mergeRecounts(observations) {
  const raw = (observations || []).map(item => ({ accountId:item.accountId,
    cache:minimalCache(item.cache), projection:item.projection || rawUnreadProjection() }));
  return send({ op:'merge', kind:'recounts', observations:raw },
    [...new Set(raw.map(row => row.accountId))]);
}
export function forgetAccount(accountId) {
  return send({ op:'merge', kind:'forget', accountId });
}
export function unreadPresentation() { return send({ op:'rows' }); }
export async function unreadRows() { return (await unreadPresentation())?.rows || []; }
export async function selectTotalUnread() { return (await unreadPresentation())?.total ?? null; }
