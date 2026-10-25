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
