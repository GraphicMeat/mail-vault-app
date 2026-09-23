// saveKeychain collapses queued writes into the latest one. A collapsed
// caller must not be told "stored" before a write carrying its data has
// landed: the account-transfer import reloads the window right after.
import { describe, it, expect, vi } from 'vitest';

const stores = []; // one entry per store_credentials call: { data, release, fail }
vi.mock('../../transport.js', () => ({
  send: vi.fn((cmd, args) => {
    if (cmd !== 'store_credentials') return Promise.resolve({});
    return new Promise((resolve, reject) => {
      stores.push({ data: args.credentials, release: resolve, fail: reject });
    });
  }),
}));
vi.mock('../../keychainSession.js', () => ({ recordOutcome: vi.fn(), isLockedOut: () => false, resetForRetry: vi.fn() }));

const { saveKeychain } = await import('../keychain.js');

const settled = (p) => {
  const state = { done: false, error: null };
  p.then(() => { state.done = true; }, (e) => { state.done = true; state.error = e; });
  return state;
};

describe('saveKeychain write queue', () => {
  it('resolves a collapsed write only when the write that superseded it lands', async () => {
    const a = settled(saveKeychain({ a: '1' }));
    await vi.waitFor(() => expect(stores).toHaveLength(1)); // A is in flight
    const b = settled(saveKeychain({ a: '1', b: '2' }));
    const c = settled(saveKeychain({ a: '1', b: '2', c: '3' }));

    stores[0].release(); // A lands; B collapses into C, C goes out
    await vi.waitFor(() => expect(stores).toHaveLength(2));
    expect(a.done).toBe(true);
    expect(stores[1].data).toEqual({ a: '1', b: '2', c: '3' });
    expect(b.done).toBe(false); // the old queue resolved B here, before C landed
    expect(c.done).toBe(false);

    stores[1].release();
    await vi.waitFor(() => expect(b.done && c.done).toBe(true));
    expect(b.error).toBeNull();
    expect(c.error).toBeNull();
  });
});
