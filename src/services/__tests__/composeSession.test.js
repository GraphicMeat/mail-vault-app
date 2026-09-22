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
