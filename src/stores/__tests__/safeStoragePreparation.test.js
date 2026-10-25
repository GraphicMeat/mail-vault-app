import { describe, it, expect, vi } from 'vitest';
const load = async handler => {
  vi.resetModules();
  globalThis.window = { __TAURI__: { core: { invoke: handler } }, location: { search: '' } };
  return import('../safeStorage');
};
const doc = aliases => ({ state: { aliases, sendAsAddresses: {} } });
describe('owner preparation settings barrier', () => {
  it('flushes and reads again when an identity edit arrives during the write', async () => {
    let values = { 'mailvault-settings': doc({}) }; let version = 1; let release;
    const invoke = vi.fn(async (cmd, args) => {
      if (cmd !== 'daemon_rpc') throw new Error('unexpected shell fallback');
      if (args.method === 'settings.get') return { values: structuredClone(values), version };
      if (args.method === 'settings.replace') { await new Promise(r => { release = r; }); values = { ...values, ...args.params.values }; return { version: ++version }; }
    });
    const { safeStorage, flushSafeStorage } = await load(invoke);
    await safeStorage.getItem('mailvault-settings');
    safeStorage.setItem('mailvault-settings', JSON.stringify(doc({ one: [{ address: 'first@example.test' }] })));
    const ack = flushSafeStorage({ acknowledge: true });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    safeStorage.setItem('mailvault-settings', JSON.stringify(doc({ one: [{ address: 'latest@example.test' }] })));
    const first = release; release = null; first();
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); release();
    expect(await ack).toBe(3);
    expect(values['mailvault-settings'].state.aliases.one[0].address).toBe('latest@example.test');
  });
  it.each([{ recovered: 'backup' }, { version: 'unknown' }])('refuses recovered or malformed acknowledgement %j', async extra => {
    const invoke = vi.fn(async () => ({ values: { 'mailvault-settings': doc({}) }, version: 1, ...extra }));
    const { flushSafeStorage } = await load(invoke);
    await expect(flushSafeStorage({ acknowledge: true })).rejects.toThrow('compose.preparationUnavailable');
  });
  it('refuses disabled child storage and a failed owner write', async () => {
    const invoke = vi.fn(async (_cmd, args) => {
      if (args?.method === 'settings.get') return { values: {}, version: 1 };
      throw new Error('errors.settingsWriteFailed');
    });
    const { safeStorage, flushSafeStorage, setSafeStorageWriteEnabled } = await load(invoke);
    await safeStorage.getItem('mailvault-settings');
    safeStorage.setItem('mailvault-settings', JSON.stringify(doc({})));
    await expect(flushSafeStorage({ acknowledge: true })).rejects.toThrow('errors.settingsWriteFailed');
    setSafeStorageWriteEnabled(false);
    await expect(flushSafeStorage({ acknowledge: true })).rejects.toThrow('compose.preparationUnavailable');
  });
});
