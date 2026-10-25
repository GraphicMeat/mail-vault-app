import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ managed: [], calls: [], rows: [], list: null, tiers: {}, saved: [1, 2, 3, 4, 9] }));
vi.mock('../../transport.js', () => ({ send: async (cmd, args) => {
  native.calls.push([cmd, args]);
  if (cmd === 'drafts.list') { if (native.list) return native.list(); return { drafts: [], managed: native.managed }; }
  if (cmd === 'local_index_read') return JSON.stringify(native.rows);
  if (cmd === 'vault_uid_sets') return { saved: native.saved, archived: native.saved };
  if (cmd === 'maildir_repair_generation') return { ran: false };
  return native.tiers[cmd]?.(args) ?? [];
} }));
vi.mock('../accounts.js', () => ({ initBasic: async () => {}, initDB: async () => {}, accountDir: () => 'acct' }));
const state = vi.hoisted(() => ({ value: {} }));
vi.mock('../../../stores/mailStore', () => ({ useMailStore: { getState: () => state.value, setState: u => { state.value = { ...state.value, ...(typeof u === 'function' ? u(state.value) : u) }; } } }));
import * as db from '../emails';
import * as projection from '../../draftProjection';
import { setArchivedGroup, getArchivedGroup, deriveArchivedUnion, _resetArchivedGroupsForTest } from '../../../stores/slices/messageListSlice';
import { loadLocalFolder } from '../../workflows/loadEmails';
const scope = (uid, accountId = 'a', mailbox = 'Drafts') => ({ accountId, mailbox, uid, messageId: '<native>', sha256: 'opaque' });
const current = (revision = 2, uid = 2, accountId = 'a') => ({ draftId: 'd', revision, current: { identity: scope(uid, accountId), entry: { uid, subject: 'accepted', source: 'local_draft', flags: ['archived', 'draft'] } }, pending: { identity: scope(3), preparedIdentity: scope(4) }, cleanupIdentities: [scope(1)], discarded: false, cleanup: 'pending' });
beforeEach(() => {
  projection.resetDraftProjectionForTest(); _resetArchivedGroupsForTest();
  Object.assign(native, { managed: [current()], calls: [], rows: [1, 2, 3, 4, 9].map(uid => ({ uid, source: uid === 9 ? 'server' : 'local_draft', subject: 'stale' })), list: null, tiers: {}, saved: [1, 2, 3, 4, 9] });
  state.value = { activeAccountId: 'a', activeMailbox: 'Drafts', localEmails: [], emails: [], archivedEmailIds: new Set(), savedEmailIds: new Set(), updateSortedEmails: vi.fn() };
});
it('uses unfiltered metadata and authoritative entry for custody and raw fallback rows', async () => {
  const rows = await db.readLocalEmailIndex('a', 'Drafts');
  expect(rows.map(r => [r.uid, r.subject])).toEqual([[9, 'stale'], [2, 'accepted']]);
  expect(rows[1]).toMatchObject({ draftId: 'd', revision: 2, _origin: 'local_draft', _accountId: 'a', _mailbox: 'Drafts' });
  expect(native.calls.find(([c]) => c === 'drafts.list')).toEqual(['drafts.list', {}]);
  native.tiers.vault_light_rows = () => native.rows;
  expect((await db.getLocalEmails('a', 'Drafts')).map(r => r.uid)).toEqual([9, 2]);
});
it('projects every sidecar, search-index and registry emission before the batch paints', async () => {
  native.tiers.load_email_cache_by_uids = () => [{ uid: 1 }, { uid: 2, subject: 'old cache' }];
  native.tiers.vault_rows = () => [{ uid: 3 }]; native.tiers.vault_light_rows = () => [{ uid: 4 }, { uid: 9 }];
  const batches = [];
  const rows = await db.getArchivedEmails('a', 'Drafts', new Set([1, 2, 3, 4, 9]), rows => batches.push(rows));
  expect(batches).toHaveLength(3);
  for (const batch of batches) { expect(batch.some(r => [1, 3, 4].includes(r.uid))).toBe(false); expect(batch.find(r => r.uid === 2)?.subject).toBe('accepted'); }
  expect(rows.map(r => r.uid)).toEqual([9, 2]);
});
it('suppresses moved source-account copies and preserves exact unrelated UID scopes', async () => {
  native.managed = [current(3, 2, 'b')];
  expect((await db.readLocalEmailIndex('a', 'Drafts')).map(r => r.uid)).toEqual([2, 9]);
  expect((await db.readLocalEmailIndex('a', 'Other')).map(r => r.uid)).toEqual([1, 2, 3, 4, 9]);
  expect((await db.readLocalEmailIndex('b', 'Drafts')).find(r => r.uid === 2)?.subject).toBe('accepted');
});
it('keeps exact projection in archived groups through unknown and future physical lists', async () => {
  await db.readLocalEmailIndex('a', 'Drafts');
  setArchivedGroup('a', 'Drafts', new Set([1, 2, 3, 4, 9])); setArchivedGroup('a', 'Other', new Set([1]));
  expect([...getArchivedGroup('a', 'Drafts')]).toEqual([9, 2]);
  setArchivedGroup('a', 'Drafts', null); expect([...getArchivedGroup('a', 'Drafts')]).toEqual([9, 2]);
  projection.observeDraftOutcome({ ...current(3, 8), cleanupIdentities: [scope(1), scope(2)] });
  setArchivedGroup('a', 'Drafts', new Set([1, 2, 3, 4, 9]));
  expect([...deriveArchivedUnion(new Set(), [['a', 'Drafts'], ['a', 'Other']])].sort()).toEqual(['a:Drafts:8', 'a:Drafts:9', 'a:Other:1']);
});
it('retains known ownership on metadata failure and rejects late snapshots after publication', async () => {
  await db.readLocalEmailIndex('a', 'Drafts');
  let resolve; native.list = () => new Promise(r => { resolve = r; });
  const loading = db.readLocalEmailIndex('a', 'Drafts');
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  projection.observeDraftOutcome({ ...current(3, 8), cleanupIdentities: [scope(1), scope(2)] }); resolve({ drafts: [], managed: [current()] });
  expect((await loading).map(r => r.uid)).toEqual([9, 8]);
  native.list = () => { throw Error('unavailable'); };
  expect((await db.readLocalEmailIndex('a', 'Drafts')).map(r => r.uid)).toEqual([9, 8]);
  expect(projection.getDraftProjection().available).toBe(false);
});
it('cold metadata failure defers known draft candidates but preserves unrelated rows', async () => {
  native.list = () => { throw Error('unavailable'); };
  expect((await db.readLocalEmailIndex('a', 'Drafts')).map(r => r.uid)).toEqual([9]);
});
it('terminal cleanup remains a noneditable pending marker and cannot be revived by an older list', async () => {
  await db.readLocalEmailIndex('a', 'Drafts');
  projection.observeDraftOutcome({ draftId: 'd', discarded: true, cleanup: 'pending', cleanupIdentities: [scope(1), scope(2)] });
  const rows = await db.readLocalEmailIndex('a', 'Drafts');
  expect(rows.filter(r => r.draftId === 'd')).toEqual([expect.objectContaining({ _draftState: 'cleanupPending', _draftUnavailable: true })]);
});
it('uses actual local load generation so a slower older load cannot repaint after a newer one', async () => {
  native.tiers.load_email_cache_by_uids = () => native.rows;
  let resolve; native.list = () => new Promise(r => { resolve = r; });
  const old = loadLocalFolder('a', 'Drafts'); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  projection.observeDraftOutcome({ ...current(4, 8), cleanupIdentities: [scope(1), scope(2)] }); native.list = null;
  await loadLocalFolder('a', 'Drafts');
  const paints = state.value.updateSortedEmails.mock.calls.length;
  resolve({ drafts: [], managed: [current()] }); await old;
  expect(state.value.updateSortedEmails).toHaveBeenCalledTimes(paints);
  expect(state.value.localEmails.map(r => r.uid)).toEqual([9, 8]);
  expect([...state.value.archivedEmailIds].sort()).toEqual(['a:Drafts:8', 'a:Drafts:9']);
});
it('preserves positive custody conflicts at a cleanup tuple and permits cleaned UID reuse', async () => {
  native.rows = [{ uid: 1, source: 'local_sent', message_id: '<foreign>' }, { uid: 2, source: 'local_draft', message_id: '<native>' }, { uid: 3, source: 'local_draft', message_id: '<native>' }, { uid: 9, source: 'server' }];
  expect((await db.readLocalEmailIndex('a', 'Drafts')).map(r => r.uid)).toEqual([1, 9, 2]);
  expect([...(await db.getVaultUidSets('a', 'Drafts')).archived]).toContain(1);
  projection.observeDraftOutcome({ ...current(3, 8), pending: null, cleanup: 'complete', cleanupIdentities: [] });
  native.managed = [{ ...current(3, 8), pending: null, cleanup: 'complete', cleanupIdentities: [] }];
  native.rows = [{ uid: 2, source: 'server', message_id: '<reused>' }];
  expect((await db.readLocalEmailIndex('a', 'Drafts')).map(r => r.uid)).toEqual([2, 8]);
  expect([...(await db.getVaultUidSets('a', 'Drafts')).archived]).toContain(2);
});
it('does not carry a stale draft ID or draft flag onto a positively foreign cached row', async () => {
  native.rows = [{ uid: 1, source: 'local_sent', message_id: '<foreign>', flags: ['archived', 'seen'] }];
  native.tiers.load_email_cache_by_uids = () => [{ uid: 1, source: 'local', draftId: 'd', flags: ['draft'] }];
  const rows = await db.getArchivedEmails('a', 'Drafts', new Set([1]));
  expect(rows.find(row => row.uid === 1)).toMatchObject({ _origin: 'local_sent', flags: ['archived', 'seen'] });
  expect(rows.find(row => row.uid === 1).draftId).toBeUndefined();
});
