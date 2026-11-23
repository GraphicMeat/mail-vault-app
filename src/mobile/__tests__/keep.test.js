// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const entry = (uid) => ({ accountId: 'a1', mailbox: 'INBOX', uid, subject: `s${uid}`, sender: { name: 'Sam', address: 'sam@x' } });
const valid = { ...entry(9), keptAt: 5 };
const KEY = 'mailvault-keep';

async function load() {
  vi.resetModules();
  return import('../keep');
}

beforeEach(() => localStorage.clear());

describe('phone keep store', () => {
  it('the phone keeps an email and writes it to storage', async () => {
    const { useKeepStore } = await load();
    useKeepStore.getState().toggle(entry(1));
    expect(JSON.parse(localStorage.getItem(KEY)).items.map(i => i.uid)).toEqual([1]);
    useKeepStore.getState().toggle(entry(1));
    expect(JSON.parse(localStorage.getItem(KEY)).items).toEqual([]);
  });

  it('drops malformed kept emails read from storage', async () => {
    localStorage.setItem(KEY, '{bad');
    let { useKeepStore, DEFAULT_DOCK } = await load();
    expect(useKeepStore.getState().items).toEqual([]);
    expect(useKeepStore.getState().dock).toEqual(DEFAULT_DOCK);
    localStorage.setItem(KEY, JSON.stringify({ items: [null, { uid: -1 }, valid], dock: 7 }));
    ({ useKeepStore, DEFAULT_DOCK } = await load());
    expect(useKeepStore.getState().items).toEqual([valid]);
    expect(useKeepStore.getState().dock).toEqual(DEFAULT_DOCK);
    useKeepStore.getState().toggle(entry(2));
    const written = JSON.parse(localStorage.getItem(KEY));
    expect(written.items.map(i => i.uid)).toEqual([2, 9]);
    expect(written.dock).toEqual(DEFAULT_DOCK);
  });

  it('kept emails survive a phone restart', async () => {
    let { useKeepStore } = await load();
    useKeepStore.getState().toggle(entry(1));
    useKeepStore.getState().moveDock({ side: 'left', top: 0.25 });
    ({ useKeepStore } = await load());
    expect(useKeepStore.getState().items.map(i => i.uid)).toEqual([1]);
    expect(useKeepStore.getState().dock).toEqual({ side: 'left', top: 0.25 });
  });
});
