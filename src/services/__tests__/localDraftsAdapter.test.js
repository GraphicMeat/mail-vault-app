import { beforeEach, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn());
vi.mock('../transport', () => ({ send }));
vi.mock('../transport.js', () => ({ send }));
const store = vi.hoisted(() => ({ state: {} }));
vi.mock('../../stores/mailStore', () => ({ useMailStore: {
  getState: () => store.state,
  setState: update => { store.state = { ...store.state, ...(typeof update === 'function' ? update(store.state) : update) }; },
} }));
vi.mock('../api', () => ({ buildDraftMime: async () => ({ rawBase64: 'b2xk' }), appendLocalIndex: async () => {}, removeFromLocalIndex: async () => {} }));
vi.mock('../db', () => ({ getLocalIndexEntry: vi.fn(), getCachedMailboxes: vi.fn() }));
import * as drafts from '../localDrafts';
const payload = { to: '', cc: '', bcc: '', subject: '', html: '', text: '', inReplyTo: '', references: '', attachments: [] };
const identity = (uid, accountId = 'a') => ({ accountId, mailbox: 'Drafts', uid, messageId: '<native>', sha256: 'native-only' });
const reply = (revision = 1, uid = 2) => ({ draftId: 'd', revision, disposition: 'saved', current: { identity: identity(uid), entry: { uid, subject: 'current', source: 'local_draft' } }, pending: null, cleanupIdentities: [], discarded: false, cleanup: 'complete', accountId: 'a', mailbox: 'Drafts', uid, entry: { uid, source: 'local_draft' } });
beforeEach(async () => {
  globalThis.window = { __TAURI__: { core: { invoke: vi.fn() } }, addEventListener() {}, removeEventListener() {} };
  send.mockReset();
  const projection = await import('../draftProjection'); projection.resetDraftProjectionForTest();
  drafts.setComposeOpener(null);
  store.state = { activeAccountId: 'a', activeMailbox: 'Drafts', localEmails: [], emails: [], savedEmailIds: new Set(), archivedEmailIds: new Set(), updateSortedEmails: vi.fn() };
});
it('serializes only the complete native request and maps source without attachment IO', async () => {
  send.mockResolvedValue(reply());
  const source = { accountId: 'a', mailbox: 'INBOX', uid: 9, attachmentIndex: 0 };
  await drafts.saveLocalDraft({ draftId: 'd', revision: 1, accountId: 'a', account: { password: 'never' }, mailbox: 'wrong', uid: 99, fromAddress: 'me@example.test', displayName: 'Me', payload: { ...payload, attachments: [{ filename: 'empty', contentType: 'text/plain', content: '', size: 123, isFromOriginal: true, _source: source }] }, snippet: '' });
  expect(send.mock.calls).toEqual([['drafts.save', { draftId: 'd', revision: 1, accountId: 'a', fromAddress: 'me@example.test', displayName: 'Me', snapshot: { ...payload, attachments: [{ filename: 'empty', contentType: 'text/plain', content: '', source }] }, snippet: '' }]]);
});
it('refuses component calls without stable identity or complete content before writes', async () => {
  await expect(drafts.saveLocalDraft({ accountId: 'a', payload })).rejects.toThrow();
  await expect(drafts.saveLocalDraft({ draftId: 'd', revision: 1, accountId: 'a', payload: { html: 'partial' } })).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
it('returns superseded honestly and cannot replace a newer accepted projection', async () => {
  send.mockResolvedValueOnce(reply(3, 30)).mockResolvedValueOnce({ ...reply(2, 20), disposition: 'superseded' });
  const req = { draftId: 'd', revision: 3, accountId: 'a', fromAddress: '', displayName: '', payload, snippet: '' };
  await drafts.saveLocalDraft(req);
  expect((await drafts.saveLocalDraft({ ...req, revision: 2 })).disposition).toBe('superseded');
  expect(store.state.localEmails.map(r => r.uid)).toEqual([30]);
});
it('reopens a cleaned historical row by stable ID without old tuple authority', async () => {
  const open = vi.fn(); drafts.setComposeOpener(open);
  send.mockResolvedValue({ drafts: [{ ...reply(4, 40), eml: { html: '<p>latest</p>', attachments: [] } }], managed: [reply(4, 40)] });
  expect(await drafts.openLocalDraft('a', 'Drafts', 10, 'd')).toBe(true);
  expect(send).toHaveBeenCalledExactlyOnceWith('drafts.list', { draftId: 'd', includeContent: true });
  expect(open.mock.calls[0][0]).toMatchObject({ _draftId: 'd', _draftRevision: 4, _draftAcceptedRevision: 4, _draftUid: 40, body: '<p>latest</p>' });
});
it.each([{ terminal: true }, { pending: true }, { missingBody: true }])('consumes managed unavailable outcome %j without opening or viewer fallback', async flags => {
  const open = vi.fn(); drafts.setComposeOpener(open);
  send.mockResolvedValue({ drafts: [], managed: [reply()], ...flags });
  expect(await drafts.openLocalDraft('a', 'Drafts', 10, 'd')).toBe(true);
  expect(open).not.toHaveBeenCalled();
});
it('adopts a legacy identity before canonical discard and retains cleanup pending', async () => {
  send.mockResolvedValueOnce({ drafts: [{ ...reply(), eml: { html: '', attachments: [] } }], managed: [reply()] }).mockResolvedValueOnce({ draftId: 'd', discarded: true, cleanup: 'pending', cleanupIdentities: [identity(2)] });
  const result = await drafts.deleteLocalDraft({ accountId: 'a', mailbox: 'Drafts', uid: 2 });
  expect(send.mock.calls).toEqual([['drafts.list', { identity: { accountId: 'a', mailbox: 'Drafts', uid: 2 }, includeContent: true }], ['drafts.discard', { draftId: 'd' }]]);
  expect(result.cleanup).toBe('pending');
});
it('reconciles an unknown save by stable ID before retrying the same revision', async () => {
  send.mockRejectedValueOnce(new Error('lost acknowledgment')).mockResolvedValueOnce({ drafts: [reply()], managed: [reply()] }).mockResolvedValueOnce({ ...reply(), disposition: 'unchanged' });
  const request = { draftId: 'd', revision: 1, accountId: 'a', fromAddress: '', displayName: '', payload, snippet: '' };
  await expect(drafts.saveLocalDraft(request)).rejects.toThrow('lost acknowledgment');
  expect(store.state.localEmails.map(r => r.uid)).toEqual([2]);
  await drafts.saveLocalDraft(request);
  expect(send.mock.calls.map(([name]) => name)).toEqual(['drafts.save', 'drafts.list', 'drafts.save']);
  expect(send.mock.calls[1][1]).toEqual({ draftId: 'd' });
  expect(send.mock.calls[0][1]).toEqual(send.mock.calls[2][1]);
});
it('does not regress completed cleanup when an older same-revision save reply arrives', async () => {
  let resolve;
  send.mockImplementation(method => method === 'drafts.save' ? new Promise(r => { resolve = r; }) : Promise.resolve({ drafts: [reply(2, 20)], managed: [reply(2, 20)] }));
  const saving = drafts.saveLocalDraft({ draftId: 'd', revision: 2, accountId: 'a', fromAddress: '', displayName: '', payload, snippet: '' });
  await drafts.reconcileLocalDraft('d');
  resolve({ ...reply(2, 20), cleanup: 'pending', cleanupIdentities: [identity(10)] });
  await saving;
  expect((await import('../draftProjection')).getDraftProjection().managed[0].cleanup).toBe('complete');
});
it('retries metadata after a synchronous transport failure instead of caching unavailable forever', async () => {
  const projection = await import('../draftProjection');
  send.mockImplementationOnce(() => { throw new Error('disconnected'); }).mockResolvedValueOnce({ drafts: [], managed: [] });
  expect((await projection.refreshDraftProjection()).available).toBe(false);
  expect((await projection.refreshDraftProjection()).available).toBe(true);
  expect(send).toHaveBeenCalledTimes(2);
});
