// Native draft metadata projected onto existing list rows and UID sets. This
// cache is presentation only: it never grants byte ownership or writes vaults.
import { normalizeMessageId } from '../utils/emailParser.js';
import { vaultKey } from '../stores/slices/unifiedHelpers.js';
import { send } from './transport.js';
import { t } from '../i18n/index.js';

let records = new Map();
let generation = 0;
let available = false;
let error = null;
let inFlight = null;
let custody = new Map();
const copy = value => JSON.parse(JSON.stringify(value));
const tupleKey = ({ accountId, mailbox, uid }) => JSON.stringify([accountId, mailbox, Number(uid)]);
const inGroup = (identity, accountId, mailbox) => identity?.accountId === accountId && identity?.mailbox === mailbox;
export const draftLocations = record => [record?.current?.identity, record?.pending?.identity, record?.pending?.preparedIdentity, ...(record?.cleanupIdentities || [])].filter(Boolean);
export const getDraftProjectionGeneration = () => generation;
export const getDraftProjection = () => ({ managed: [...records.values()], generation, available, error });

// Only custody metadata is positive replacement evidence. A stale header-cache
// Message-ID alone must not override the accepted native entry.
export function observeDraftCustody(accountId, mailbox, entries, frame) {
  const group = JSON.stringify([accountId, mailbox]);
  const owned = new Set(nativeLocations(frame).filter(identity => inGroup(identity, accountId, mailbox)).map(identity => Number(identity.uid)));
  // Keep facts only for draft-owned tuples, never a second mailbox registry.
  if (!owned.size) { custody.delete(group); return; }
  custody.set(group, new Map(entries.filter(row => row?.uid != null && owned.has(Number(row.uid))).map(row => [Number(row.uid), { source: row.source, flags: row.flags, messageId: normalizeMessageId(row.message_id) }])));
}
function foreign(identity) {
  const row = custody.get(JSON.stringify([identity.accountId, identity.mailbox]))?.get(Number(identity.uid));
  return !!row && ((row.source && row.source !== 'local_draft')
    || (row.messageId && identity.messageId && row.messageId !== normalizeMessageId(identity.messageId)));
}

function remember(value) {
  if (!value?.draftId) return;
  const previous = records.get(value.draftId);
  // Terminal decisions are permanent; an old response cannot revive one. A
  // lower revision cannot move the accepted identity backwards either.
  if (previous?.discarded && !value.discarded) return;
  if (!value.discarded && Number(value.revision) < Number(previous?.revision || 0)) return;
  records.set(value.draftId, copy({ ...previous, ...value,
    ...(value.discarded ? { current: null, pending: null } : {}),
  }));
}

export function observeDraftOutcome(value, startedGeneration) {
  const known = records.get(value?.draftId);
  // First terminal acceptance wins over an in-flight save observation. Once
  // terminal is known, an older terminal read/discard cannot restore cleanup
  // that a newer observation already drained. Complete terminal cleanup is
  // monotonic progress, even if overlapping requests began together.
  if (startedGeneration != null && startedGeneration !== generation && known
    && ((known.discarded && value.discarded && value.cleanup !== 'complete')
      || (!value.discarded && Number(value.revision) <= Number(known.revision)))) return getDraftProjection();
  generation += 1; // invalidate requests already reading an older native view
  const previous = records.get(value?.draftId);
  remember(value);
  // A newly observed accepted native copy supersedes older custody-cache facts
  // at its destination. Cleanup conflicts elsewhere remain positive evidence.
  if (value?.current && !previous?.discarded && Number(value.revision) >= Number(previous?.revision || 0)) {
    const identity = value.current.identity;
    custody.get(JSON.stringify([identity.accountId, identity.mailbox]))?.delete(Number(identity.uid));
  }
  return getDraftProjection();
}

export function refreshDraftProjection() {
  if (inFlight?.generation === generation) return inFlight.promise;
  const started = generation;
  const previousManaged = [...records.values()];
  const request = { generation: started };
  inFlight = request;
  request.promise = (async () => {
    try {
      // Always unfiltered: an account move can leave cleanup in the old account.
      const reply = await send('drafts.list', {});
      if (!Array.isArray(reply?.managed) || !Array.isArray(reply?.drafts)) throw new Error(t('compose.draftStateUnavailable'));
      if (generation === started && inFlight === request) {
        for (const record of reply.managed) remember(record);
        available = true;
        error = null;
      }
    } catch (cause) {
      if (generation === started && inFlight === request) { available = false; error = cause; }
    } finally {
      if (inFlight === request) inFlight = null;
    }
    return { ...getDraftProjection(), previousManaged };
  })();
  return request.promise;
}

// The captured frame removes a previous accepted tuple from a batch that was
// already in flight when a save finished. It is not a permanent tuple alias:
// fresh lists may truthfully hold unrelated mail reusing a cleaned UID.
function nativeLocations(frame) {
  return [...(frame?.previousManaged || []), ...(frame?.managed || []), ...records.values()].flatMap(draftLocations);
}
export function draftOwnedLocations(frame) { return nativeLocations(frame).filter(identity => !foreign(identity)); }

function presentationRows(accountId, mailbox, parsedRows = []) {
  const rows = [];
  for (const record of records.values()) {
    const terminalPending = record.discarded && record.cleanup === 'pending';
    const identity = terminalPending ? record.cleanupIdentities?.find(i => inGroup(i, accountId, mailbox) && !foreign(i)) : record.current?.identity;
    if (!inGroup(identity, accountId, mailbox) || foreign(identity) || (record.discarded && !terminalPending)) continue;
    // A terminal marker is deliberately unavailable to compose. Retained bytes
    // are cleanup work, never a second editable draft.
    const entry = terminalPending ? { subject: '', flags: ['archived', 'draft'] } : record.current.entry;
    // Retain already parsed body/attachment fields only for this exact current
    // tuple. Native headers still replace stale cache metadata; cleanup bodies
    // never become the content of the current draft.
    const parsed = !terminalPending && parsedRows.find(row => tupleKey({ accountId: row._accountId || row.accountId || accountId, mailbox: row._mailbox || row.mailbox || mailbox, uid: row.uid }) === tupleKey(identity));
    rows.push({ ...parsed, ...entry, uid: identity.uid, draftId: record.draftId, revision: record.revision,
      cleanup: record.cleanup, _draftState: terminalPending ? 'cleanupPending' : 'current',
      _draftUnavailable: !!terminalPending, _origin: 'local_draft', source: 'local',
      isLocal: true, isArchived: true, _accountId: accountId, _mailbox: mailbox,
      localId: `${accountId}-${mailbox}-${identity.uid}` });
  }
  return rows;
}

export function projectDraftRows(rows, accountId, mailbox, frame, includeCurrent = true) {
  if (!Array.isArray(rows)) return rows;
  const owned = new Set(draftOwnedLocations(frame).map(tupleKey));
  const retained = rows.filter(row => {
    const tuple = { accountId: row._accountId || row.accountId || accountId, mailbox: row._mailbox || row.mailbox || mailbox, uid: row.uid };
    if (owned.has(tupleKey(tuple))) return false;
    // Cold failure is unknown. Defer potential local drafts until native
    // admission is available, while keeping unrelated server/Sent rows.
    return available || !((row._origin || row.source) === 'local_draft' || row.flags?.includes('draft'));
  });
  const conflicts = new Map(nativeLocations(frame).filter(foreign).map(identity => [tupleKey(identity), identity]));
  const presented = retained.map(row => {
    const tuple = { accountId: row._accountId || row.accountId || accountId, mailbox: row._mailbox || row.mailbox || mailbox, uid: row.uid };
    if (!conflicts.has(tupleKey(tuple))) return row;
    const current = custody.get(JSON.stringify([tuple.accountId, tuple.mailbox]))?.get(Number(tuple.uid));
    const { draftId, revision, _draftState, _draftUnavailable, ...unrelated } = row;
    return { ...unrelated, ...(current?.flags ? { flags: current.flags } : {}), _origin: current?.source || row._origin };
  });
  return [...presented, ...(includeCurrent ? presentationRows(accountId, mailbox, rows) : [])];
}

export function projectDraftUids(ids, accountId, mailbox, frame) {
  if (ids == null) return ids; // unknown stays unknown
  const result = new Set(ids);
  for (const identity of draftOwnedLocations(frame)) if (inGroup(identity, accountId, mailbox)) {
    result.delete(identity.uid); result.delete(String(identity.uid));
  }
  for (const row of presentationRows(accountId, mailbox)) result.add(row.uid);
  return result;
}

// Used by the adapter to update only affected groups and visible rows.
export function draftProjectionGroups(frame = getDraftProjection()) {
  return [...new Map(nativeLocations(frame).map(i => [JSON.stringify([i.accountId, i.mailbox]), [i.accountId, i.mailbox]])).values()];
}

export function projectDraftKeyedUids(ids, accountId, mailbox, frame, includeCurrent = true) {
  if (ids == null) return ids;
  const result = new Set(ids);
  for (const identity of draftOwnedLocations(frame)) if (inGroup(identity, accountId, mailbox)) result.delete(vaultKey(accountId, mailbox, identity.uid));
  if (includeCurrent) for (const row of presentationRows(accountId, mailbox)) result.add(vaultKey(accountId, mailbox, row.uid));
  return result;
}

export function resetDraftProjectionForTest() {
  records = new Map(); generation = 0; available = false; error = null; inFlight = null; custody = new Map();
}
