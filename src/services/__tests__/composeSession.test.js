import { describe, expect, it, vi } from 'vitest';

const values = new Map();
vi.mock('../../stores/safeStorage', () => ({
  safeStorage: {
    getItem: vi.fn(async key => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn(key => values.delete(key)),
  },
}));

import { clearComposeSession, loadComposeSession, mergeComposeSession, saveComposeSession } from '../composeSession';

describe('compose UI session', () => {
  it('restores persisted windows minimized', async () => {
    await saveComposeSession([
      { id: 1, minimized: false, initialData: { subject: 'Draft', _draftUid: 12 } },
    ]);

    await expect(loadComposeSession()).resolves.toEqual([
      expect.objectContaining({ id: 1, minimized: true, initialData: expect.objectContaining({ subject: 'Draft' }) }),
    ]);
  });

  it('removes session state once no draft windows remain', async () => {
    await saveComposeSession([{ id: 1, minimized: false, initialData: { subject: 'Draft' } }]);
    await clearComposeSession();
    await expect(loadComposeSession()).resolves.toEqual([]);
  });

  it('keeps a window opened before hydration when stored ids collide', () => {
    const merged = mergeComposeSession(
      [{ id: 1, initialData: { subject: 'New', _draftUid: 9 } }],
      [{ id: 1, initialData: { subject: 'Restored', _draftUid: 10 } }],
    );

    expect(merged).toHaveLength(2);
    expect(new Set(merged.map(window => window.id)).size).toBe(2);
    expect(merged.map(window => window.initialData.subject)).toEqual(['New', 'Restored']);
  });

  it('serializes the latest snapshot even after fields return to their baseline', async () => {
    await saveComposeSession([{
      id: 1,
      initialData: { subject: 'old' },
      snapshot: { subject: '', cc: 'copy@example.test', body: '<p>baseline</p>', attachments: [] },
    }]);

    await expect(loadComposeSession()).resolves.toEqual([
      expect.objectContaining({ initialData: expect.objectContaining({ cc: 'copy@example.test', body: '<p>baseline</p>' }) }),
    ]);
  });

  it('restores a detached session as an embedded minimized draft', async () => {
    await saveComposeSession([{ id: 3, detached: true, initialData: { subject: 'Native draft' } }]);
    await expect(loadComposeSession()).resolves.toEqual([
      expect.objectContaining({ id: 3, detached: false, minimized: true }),
    ]);
  });
});

describe('stable draft session recovery', () => {
  it('deduplicates a stable draft and preserves shorter newer unsaved content and accepted location', () => {
    const merged = mergeComposeSession(
      [{ id: 1, initialData: { _draftId: 'same', _draftRevision: 2, _draftAcceptedRevision: 2, body: 'old long disk text', _draftUid: 22 } }],
      [{ id: 2, initialData: { _draftId: 'same', _draftRevision: 3, _draftAcceptedRevision: 1, body: 'x', _draftUid: 11, _draftContent: { payload: { html: 'x' } } } }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].snapshot || merged[0].initialData).toMatchObject({ body: 'x', _draftRevision: 3, _draftAcceptedRevision: 2, _draftUid: 22 });
    expect(merged[0].id).toBe(1);
  });
  it('keeps divergent equal revision snapshots as separate recoverable content without two owners', () => {
    const merged = mergeComposeSession(
      [{ id: 1, initialData: { _draftId: 'same', _draftRevision: 3, _draftAcceptedRevision: 2, body: 'left' } }],
      [{ id: 1, initialData: { _draftId: 'same', _draftRevision: 3, _draftAcceptedRevision: 2, body: 'right' } }],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map(w => (w.snapshot || w.initialData).body)).toEqual(['left', 'right']);
    expect(merged.filter(w => (w.snapshot || w.initialData)._draftId === 'same')).toHaveLength(1);
    expect(new Set(merged.map(w => w.id)).size).toBe(2);
  });
  it('fills canonical identity into an unversioned session without replacing its complete text', () => {
    const merged = mergeComposeSession(
      [{ id: 1, initialData: { _accountId: 'a', _draftMailbox: 'Drafts', _draftUid: 10, body: 'unsaved' } }],
      [{ id: 2, initialData: { _draftId: 'adopted', _draftRevision: 1, _draftAcceptedRevision: 1, _accountId: 'a', _draftMailbox: 'Drafts', _draftUid: 10, body: 'disk' } }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].snapshot || merged[0].initialData).toMatchObject({ body: 'unsaved', _draftId: 'adopted', _draftAcceptedRevision: 1 });
  });
});

it('normalizes hydration replay once and persists recovery identity and exact request-only content', async () => {
  const owner = { id: 7, detached: true, nativeLabel: 'live-token', initialData: { _draftId: 'same', _draftRevision: 3, _draftAcceptedRevision: 2, body: 'left' } };
  const contender = { id: 7, initialData: { body: 'obsolete' }, snapshot: {
    _draftId: 'same', _draftRevision: 3, _draftAcceptedRevision: 2, _draftUid: 42, _draftMailbox: 'Drafts', _draftAccountId: 'old',
    _draftContent: { accountId: 'sender', fromAddress: 'alias@example.test', displayName: 'Alias', previousIdentity: { accountId: 'old', mailbox: 'Drafts', uid: 42 },
      payload: { to: 'to@example.test', cc: '', bcc: 'secret@example.test', subject: 'right', html: '<p>right</p>', text: 'exact plain text', inReplyTo: '<p>', references: '<r> <p>',
        attachments: [{ filename: 'empty', contentType: 'text/plain', content: '', encoding: 'base64', cid: 'cid', source: { accountId: 'source', mailbox: 'Inbox', uid: 9, attachmentIndex: 2 } }] }, snippet: 'exact snippet' },
  } };
  const restored = [contender];
  const once = mergeComposeSession([owner], restored);
  const replay = mergeComposeSession([owner], restored);
  expect(replay).toEqual(once);
  expect(mergeComposeSession(once, restored)).toEqual(once);
  expect(once[0]).toBe(owner);
  const recovered = once[1]; const data = recovered.snapshot || recovered.initialData;
  expect(recovered).toMatchObject({ minimized: true, detached: false });
  expect(data).toMatchObject({ _draftId: expect.any(String), _draftRevision: 0, _draftAcceptedRevision: 0,
    _accountId: 'sender', _fromAddress: 'alias@example.test', bcc: 'secret@example.test', body: '<p>right</p>', inReplyTo: '<p>', references: '<r> <p>',
    attachments: [{ content: '', source: { accountId: 'source', mailbox: 'Inbox', uid: 9, attachmentIndex: 2 } }] });
  expect(data._draftId).not.toBe('same'); expect(data._draftUid).toBeUndefined(); expect(data._draftMailbox).toBeUndefined(); expect(data._draftContent).toBeUndefined();
  await saveComposeSession(once); const loaded = await loadComposeSession();
  const again = mergeComposeSession(loaded, restored);
  expect(again).toHaveLength(2);
  expect(again.map(w => (w.snapshot || w.initialData)._draftId)).toEqual(once.map(w => (w.snapshot || w.initialData)._draftId));
  expect(JSON.stringify(again)).toContain('exact plain text');
});

it.each([
  ['full same-length quote', { _quotedHtml: '<p>BBBB</p>' }],
  ['same-name/size bytes', { attachments: [{ filename: 'f', size: 3, content: 'QkJC' }] }],
  ['Bcc', { bcc: 'other@example.test' }],
  ['selected account', { _accountId: 'other' }],
  ['actual From', { _fromAddress: 'alias@example.test' }],
  ['source attachment index', { attachments: [{ filename: 'f', size: 3, source: { accountId: 'source', mailbox: 'Inbox', uid: 9, attachmentIndex: 2 } }] }],
])('preserves divergent %s in a separate recovery without rekeying the live owner', (_label, change) => {
  const data = { _draftId: 'same', _draftRevision: 3, _draftAcceptedRevision: 2, body: 'body', bcc: 'secret@example.test',
    _quotedHtml: '<p>AAAA</p>', _accountId: 'account', _fromAddress: 'from@example.test', attachments: [{ filename: 'f', size: 3, content: 'QUFB' }] };
  const owner = { id: 1, detached: true, nativeLabel: 'live', initialData: data };
  const incoming = { ...data, ...change };
  const merged = mergeComposeSession([owner], [{ id: 1, initialData: incoming }]);
  expect(merged).toHaveLength(2); expect(merged[0]).toBe(owner);
  expect(merged[1].initialData).toMatchObject(change);
  expect(merged[1].initialData._draftId).not.toBe('same');
  expect(merged[1]).toMatchObject({ minimized: true, detached: false });
});

it('deduplicates identical complete drafts in persisted order without forking scheduled editors', () => {
  const first = { id: 2, initialData: { _draftId: 'same', _draftRevision: 3, body: 'exact', attachments: [{ content: '' }] } };
  expect(mergeComposeSession([], [first, { ...first, id: 3 }])).toHaveLength(1);
  const scheduled = { ...first, initialData: { ...first.initialData, _editScheduledId: 'schedule', body: 'scheduled' } };
  const merged = mergeComposeSession([scheduled], [{ ...scheduled, initialData: { ...scheduled.initialData, body: 'changed' } }]);
  expect(merged).toHaveLength(1); expect(merged[0].initialData._draftId).toBe('same');
});

it('treats failed or malformed stored sessions as settled empty and strips transient admission markers on save', async () => {
  values.set('mailvault-compose-session', '{malformed');
  await expect(loadComposeSession()).resolves.toEqual([]);
  const saved = { id: 1, _awaitDraftHydration: true, initialData: { _draftId: 'kept', body: 'native data' } };
  saveComposeSession([saved]);
  expect(values.get('mailvault-compose-session')).not.toContain('_awaitDraftHydration');
  await expect(loadComposeSession()).resolves.toMatchObject([{ initialData: { body: 'native data' } }]);
});

const semanticDraft = () => ({ _draftId: 'semantic', _draftRevision: 2, _draftAcceptedRevision: 2, _draftAccountId: 'a', _draftMailbox: 'Drafts', _draftUid: 10,
  _accountId: 'a', _fromAddress: 'from@example.test', to: 'to@example.test', cc: '', bcc: 'secret@example.test', subject: 'Subject', body: '<p>body</p>',
  _quotedHtml: '', _forward: false, inReplyTo: '<parent>', references: '<root> <parent>',
  attachments: [{ filename: 'empty', contentType: 'text/plain', size: 0, content: '' }],
});
const semanticRequest = () => ({ accountId: 'a', fromAddress: 'from@example.test', displayName: 'Sender', payload: {
  to: 'to@example.test', cc: '', bcc: 'secret@example.test', subject: 'Subject', html: '<p>body</p>', text: 'body', inReplyTo: '<parent>', references: '<root> <parent>',
  attachments: [{ filename: 'empty', contentType: 'text/plain', content: '', encoding: 'base64' }],
}, snippet: 'body' });
it('deduplicates semantic native and session content without treating request presence as a difference', () => {
  const native = semanticDraft(); const request = semanticRequest();
  const merged = mergeComposeSession([{ id: 1, initialData: native }], [{ id: 2, initialData: { ...native, _draftContent: request } }]);
  expect(merged).toHaveLength(1);
  expect(merged[0].initialData._draftContent).toEqual(request);
  expect(merged[0].initialData._draftId).toBe('semantic');
});
it.each(['text', 'snippet', 'displayName'])('preserves genuinely different known request-only %s in recovery', field => {
  const content = semanticRequest(); const different = JSON.parse(JSON.stringify(content));
  if (field === 'text') different.payload.text = 'different plain bytes'; else different[field] = 'different known value';
  const merged = mergeComposeSession([{ id: 1, initialData: { ...semanticDraft(), _draftContent: content } }],
    [{ id: 2, initialData: { ...semanticDraft(), _draftContent: different } }]);
  expect(merged).toHaveLength(2);
  expect(merged[1].initialData._draftRecoveredContent).toEqual(different);
});

it.each([false, true])('joins accepted native/request representations in either direction (%s) and retains exact long snippet evidence', reverse => {
  const native = { ...semanticDraft(), _draftNativeContent: { revision: 2, html: '<p>body</p>', text: 'body', displayName: 'Sender' } };
  const request = { ...semanticRequest(), snippet: 'long raw snippet '.repeat(50) + 'A' };
  const rich = { ...semanticDraft(), _draftContent: request, _draftUiSignature: 'exact-ui-signature' };
  const [first, second] = reverse ? [rich, native] : [native, rich];
  const once = mergeComposeSession([{ id: 1, initialData: first }], [{ id: 2, initialData: second }]);
  expect(once).toHaveLength(1); expect(once[0].initialData._draftContent).toEqual(request);
  expect(once[0].initialData._draftUiSignature).toBe('exact-ui-signature');
  expect(once[0].initialData._draftNativeContent).toMatchObject({ text: 'body', displayName: 'Sender' });
  const b = { ...rich, _draftContent: { ...request, snippet: 'long raw snippet '.repeat(50) + 'B' } };
  const forked = mergeComposeSession(once, [{ id: 3, initialData: b }]);
  expect(forked).toHaveLength(2); expect(forked[1].initialData._draftRecoveredContent.snippet).toBe(b._draftContent.snippet);
});
it('retains explicit empty request-only evidence rather than replacing it with absent native metadata', () => {
  const content = semanticRequest(); content.payload.text = ''; content.displayName = ''; content.snippet = '';
  const native = semanticDraft();
  const once = mergeComposeSession([{ id: 1, initialData: { ...native, _draftContent: content } }], [{ id: 2, initialData: native }]);
  expect(once).toHaveLength(1); expect(once[0].initialData._draftContent).toEqual(content);
  const knownDifferent = { ...native, _draftNativeContent: { revision: 2, text: 'known nonempty', displayName: '' } };
  expect(mergeComposeSession(once, [{ id: 3, initialData: knownDifferent }])).toHaveLength(2);
});
it('keeps pending request acceptance unknown when native accepted metadata omits its original raw snippet', () => {
  const native = { ...semanticDraft(), _draftNativeContent: { revision: 2, text: 'body', displayName: 'Sender' } };
  const request = semanticRequest(); const pending = { ...semanticDraft(), _draftAcceptedRevision: 1, _draftContent: request };
  const merged = mergeComposeSession([{ id: 1, initialData: native }], [{ id: 2, initialData: pending }]);
  expect(merged).toHaveLength(1);
  expect(merged[0].initialData).toMatchObject({ _draftRevision: 2, _draftAcceptedRevision: 2, _draftAcceptanceUnknown: true, _draftContent: request });
});
