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

it.each(['displayNames', 'attachmentReminder', 'billingProfile', 'shareGrant', 'sendDelay', 'undoSendEnabled', 'undoSendDelay'])('send-check ACK refuses a divergent %s while reply-only ACK keeps its numeric contract', async field => {
  let reads = 0;
  const state = { aliases: {}, sendAsAddresses: {}, displayNames: { one: 'Owner' }, attachmentReminder: false, billingProfile: { hasSubscription: true }, shareGrant: { expiresAt: 1 }, sendDelay: 5, undoSendEnabled: false, undoSendDelay: 10 };
  const invoke = vi.fn(async () => {
    reads++;
    const observed = structuredClone(state);
    if (reads > 1) delete observed[field];
    return { values: { 'mailvault-settings': { state: observed } }, version: reads };
  });
  const { flushSafeStorage } = await load(invoke);
  await expect(flushSafeStorage({ acknowledge: true, purpose: 'send-check' })).rejects.toThrow('errors.settingsConflict');
  expect(reads).toBe(4);
  expect(await flushSafeStorage({ acknowledge: true })).toBe(5);
});
it('send-check ACK re-reads an edited policy generation and accepts absent defaults without fabricating them', async () => {
  let values = { 'mailvault-settings': { state: {} } }; let version = 1; let changed = false; let storage;
  const invoke = vi.fn(async (_cmd, { method, params }) => {
    if (method === 'settings.replace') { values = { ...values, ...params.values }; return { version: ++version }; }
    const result = { values: structuredClone(values), version };
    if (storage && !changed) { changed = true; storage.setItem('mailvault-settings', JSON.stringify({ state: { attachmentReminder: false } })); }
    return result;
  });
  const { safeStorage, flushSafeStorage } = await load(invoke);
  await safeStorage.getItem('mailvault-settings'); storage = safeStorage;
  expect(await flushSafeStorage({ acknowledge: true, purpose: 'send-check' })).toBe(2);
  expect(values['mailvault-settings'].state).toEqual({ attachmentReminder: false });
});
