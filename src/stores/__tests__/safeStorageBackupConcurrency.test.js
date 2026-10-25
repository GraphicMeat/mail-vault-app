import { it, expect, vi, afterEach } from 'vitest';
// Atomic settings.replace + bases contract: the real native route has its
// own disk-backed tests. Only transport/file effects are simulated here.
const clone = value => value === undefined ? undefined : structuredClone(value);
function delta(current, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return clone(current);
  if (!before || !after || Array.isArray(before) || Array.isArray(after) || typeof before !== 'object' || typeof after !== 'object') return clone(after);
  const result = current && typeof current === 'object' ? clone(current) : {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!Object.hasOwn(after, key)) delete result[key];
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) result[key] = delta(result[key], before[key], after[key]);
  }
  return result;
}
const name = 'mailvault-settings';
const original = () => ({ version: 3, state: { language: 'en', backupHistory: {}, backupState: {}, snapshotLastTimes: {}, obsolete: null } });
async function rig(shell = false) {
  vi.resetModules();
  const host = { disk: { [name]: original() }, version: 1, beforeWrite: null, fail: false, writes: 0, configWrites: [] };
  const write = async (values, bases) => {
    host.writes++;
    await host.beforeWrite?.();
    if (host.fail) throw new Error('errors.settingsWriteFailed');
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete host.disk[key];
      else host.disk[key] = bases && Object.hasOwn(bases, key) ? delta(host.disk[key], bases[key], value) : clone(value);
    }
    return { values: clone(host.disk), version: ++host.version };
  };
  globalThis.window = { location: { search: '' }, __TAURI__: { core: { invoke: async (command, args) => {
    if (command === 'daemon_rpc') {
      if (shell) throw new Error('errors.daemonOutdated');
      if (args.method === 'backup.schedule.get') return { version: host.version, config: clone(host.disk[name].state) };
      if (args.method === 'backup.schedule.set') {
        host.configWrites.push(clone(args.params));
        const apply = (target, patch) => { for (const [key, value] of Object.entries(patch)) { if (value === null) delete target[key]; else if (value && typeof value === 'object' && !Array.isArray(value)) { target[key] ||= {}; apply(target[key], value); } else target[key] = clone(value); } };
        apply(host.disk[name].state, args.params.patch); host.version++;
        return { version: host.version, config: clone(host.disk[name].state) };
      }
      if (args.method === 'settings.get') return { values: clone(host.disk), version: host.version };
      if (args.method === 'settings.replace') return write(args.params.values, args.params.bases);
    }
    if (command === 'read_settings_json') return JSON.stringify(host.disk);
    if (command === 'write_settings_json') {
      if (args.values) return write(args.values, args.bases);
      await host.beforeWrite?.(); if (host.fail) throw new Error('errors.settingsWriteFailed'); host.disk = JSON.parse(args.data); return;
    }
    throw new Error(`unexpected ${command}`);
  } } } };
  const storage = await import('../safeStorage');
  await storage.safeStorage.getItem(name);
  return { ...storage, host };
}
function complete(host) {
  host.disk[name].state.backupHistory.one = [{ success: true, timestamp: 42 }];
  host.disk[name].state.backupState.one = { lastBackupTime: 42 };
  host.disk[name].state.snapshotLastTimes.one = 42;
  host.version++;
}
afterEach(() => { vi.useRealTimers(); delete globalThis.window; });
it.each([false, true])('preserves a native completion racing an unrelated edit, shell=%s', async shell => {
  const { safeStorage, flushSafeStorage, host } = await rig(shell);
  const edited = original(); edited.state.language = 'de'; delete edited.state.obsolete; edited.state.literalNull = null;
  safeStorage.setItem(name, JSON.stringify(edited)); host.beforeWrite = () => { host.beforeWrite = null; complete(host); };
  await flushSafeStorage();
  expect(host.disk[name]).toEqual({ version: 3, state: { language: 'de', literalNull: null, backupHistory: { one: [{ success: true, timestamp: 42 }] }, backupState: { one: { lastBackupTime: 42 } }, snapshotLastTimes: { one: 42 } } });
  expect(JSON.parse(await safeStorage.getItem(name))).toEqual(host.disk[name]);
});
it.each([false, true])('keeps a second local mutation made during the write, shell=%s', async shell => {
  const { safeStorage, flushSafeStorage, host } = await rig(shell);
  const first = original(); first.state.language = 'de'; safeStorage.setItem(name, JSON.stringify(first));
  let release;
  host.beforeWrite = async () => { host.beforeWrite = null; await new Promise(r => { release = r; }); complete(host); };
  const pending = flushSafeStorage(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const next = { ...first, state: { ...first.state, language: 'fr', displayNames: { one: 'Owner' } } }; safeStorage.setItem(name, JSON.stringify(next)); release(); await pending; await flushSafeStorage();
  expect(host.disk[name].state.language).toBe('fr');
  expect(host.disk[name].state.backupHistory.one).toEqual([{ success: true, timestamp: 42 }]);
  expect(host.disk[name].state.displayNames).toEqual({ one: 'Owner' });
});
it.each([false, true])('rejects failed durability and preserves the queued edit, shell=%s', async shell => {
  const { safeStorage, flushSafeStorage, host } = await rig(shell);
  const next = original(); next.state.language = 'fr'; safeStorage.setItem(name, JSON.stringify(next)); host.fail = true;
  await expect(flushSafeStorage()).rejects.toThrow('errors.settingsWriteFailed');
  host.fail = false; complete(host); await flushSafeStorage();
  expect(host.disk[name].state.language).toBe('fr'); expect(host.disk[name].state.backupHistory.one).toEqual([{ success: true, timestamp: 42 }]);
});
it('adopts a coherent native completion returned during another store write', async () => {
  const { safeStorage, flushSafeStorage, host } = await rig();
  safeStorage.setItem('mailvault-theme', JSON.stringify({ version: 0, state: { theme: 'dark' } }));
  host.beforeWrite = () => { host.beforeWrite = null; complete(host); };
  await flushSafeStorage();
  expect(JSON.parse(await safeStorage.getItem(name)).state.backupState.one).toEqual({ lastBackupTime: 42 });
});

it('writes backup config as an exact targeted delta and preserves removals and completion', async () => {
  const { safeStorage, flushSafeStorage, host } = await rig();
  const seeded = original(); seeded.state.backupSchedules = { one: { enabled: true, interval: 'daily' } };
  host.disk[name] = seeded;
  // A fresh reader establishes the accepted baseline.
  const next = original(); next.state.backupSchedules = { one: { enabled: true, interval: 'daily' } };
  safeStorage.setItem(name, JSON.stringify(next)); await flushSafeStorage(); host.configWrites.length = 0;
  next.state.backupSchedules = {}; next.state.language = 'de';
  safeStorage.setItem(name,JSON.stringify(next));
  host.beforeWrite = () => { host.beforeWrite = null; complete(host); };
  await flushSafeStorage();
  expect(host.configWrites).toHaveLength(1);
  expect(host.configWrites[0].patch).toEqual({ backupSchedules: { one: null } });
  expect(host.disk[name].state.backupSchedules).toEqual({});
  expect(host.disk[name].state.language).toBe('de');
  expect(host.disk[name].state.backupHistory.one).toEqual([{ success: true, timestamp: 42 }]);
});
