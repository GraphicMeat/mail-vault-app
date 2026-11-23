import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map());
const setItem = vi.hoisted(() => vi.fn());
vi.mock('../safeStorage', () => ({ safeStorage: {
  getItem: key => storage.get(key) || null,
  setItem: (key, value) => { setItem(key, value); storage.set(key, value); },
  removeItem: key => storage.delete(key),
} }));
const { useKeepStore } = await import('../keepStore');
const { DEFAULT_DOCK, keepId } = await import('../../shared/keep');

const entry = (uid, address = 'sam@x') => ({
  accountId: 'a1', mailbox: 'INBOX', uid, subject: `s${uid}`, sender: { name: 'Sam', address },
});
const valid = { ...entry(9), keptAt: 5 };

beforeEach(() => {
  storage.clear();
  setItem.mockClear();
  useKeepStore.setState({ items: [], dock: DEFAULT_DOCK });
});

describe('keepStore', () => {
  it('toggle keeps an email and toggle again removes it', () => {
    useKeepStore.getState().toggle(entry(1));
    expect(useKeepStore.getState().items.map(i => keepId(i))).toEqual(['a1|INBOX|1']);
    useKeepStore.getState().toggle(entry(1));
    expect(useKeepStore.getState().items).toEqual([]);
  });

  it("removeSender removes only that sender's stack", () => {
    const { toggle } = useKeepStore.getState();
    toggle(entry(1)); toggle(entry(2, 'lena@x')); toggle(entry(3));
    useKeepStore.getState().removeSender('sam@x');
    expect(useKeepStore.getState().items.map(i => i.uid)).toEqual([2]);
  });

  it('remove drops one email', () => {
    const { toggle } = useKeepStore.getState();
    toggle(entry(1)); toggle(entry(2));
    useKeepStore.getState().remove('a1|INBOX|1');
    expect(useKeepStore.getState().items.map(i => i.uid)).toEqual([2]);
  });

  it('moveDock stores a valid side and top, ignores an invalid one', () => {
    useKeepStore.getState().moveDock({ side: 'left', top: 0.2 });
    expect(useKeepStore.getState().dock).toEqual({ side: 'left', top: 0.2 });
    useKeepStore.getState().moveDock({ side: 'up', top: 'x' });
    expect(useKeepStore.getState().dock).toEqual(DEFAULT_DOCK);
  });

  it('rejects malformed items value before it enters the persisted patch', async () => {
    const stored = (items) => storage.set('mailvault-keep', JSON.stringify({ state: { items, dock: { side: 'top', top: 'x' } }, version: 0 }));
    for (const items of [42, [null, { uid: 'x' }, { accountId: 5, mailbox: 'INBOX', uid: 1 }, valid]]) {
      stored(items);
      setItem.mockClear();
      await useKeepStore.persist.rehydrate();
      expect(useKeepStore.getState().items).toEqual(Array.isArray(items) ? [valid] : []);
      expect(useKeepStore.getState().dock).toEqual(DEFAULT_DOCK);
      useKeepStore.getState().toggle(entry(77));
      const written = JSON.parse(setItem.mock.calls.at(-1)[1]).state;
      expect(written.items.every(i => i.accountId && Number.isInteger(i.uid) && Number.isFinite(i.keptAt))).toBe(true);
      expect(written.items.map(i => i.uid)).toEqual(Array.isArray(items) ? [77, 9] : [77]);
      expect(written.dock).toEqual(DEFAULT_DOCK);
    }
  });

  it('kept emails survive a restart', async () => {
    useKeepStore.getState().toggle(entry(1));
    useKeepStore.getState().moveDock({ side: 'left', top: 0.3 });
    const saved = storage.get('mailvault-keep');
    useKeepStore.setState({ items: [], dock: DEFAULT_DOCK });
    storage.set('mailvault-keep', saved);
    await useKeepStore.persist.rehydrate();
    expect(useKeepStore.getState().items.map(i => i.uid)).toEqual([1]);
    expect(useKeepStore.getState().dock).toEqual({ side: 'left', top: 0.3 });
  });
});
