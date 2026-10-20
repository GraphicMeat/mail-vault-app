import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `safeStorage` reads the settings file through Tauri, so hydration is async,
 * and `ensureLoaded` lets an in-session write keep its key only once the
 * document has loaded.
 *
 * Any `setState` during module evaluation makes zustand's persist middleware
 * write the settings key immediately: the store's defaults plus one change.
 * Before the read lands, that write must not win, or every setting the user
 * ever saved is dropped (and, written back, lost on disk).
 */
describe('safeStorage and a write that beats the disk read', () => {
  let safeStorage;

  beforeEach(async () => {
    vi.resetModules();
    const disk = JSON.stringify({
      'mailvault-settings': { version: 4, state: { listPaneSize: 470, language: 'de' } },
    });
    globalThis.window = {
      __TAURI__: { core: { invoke: vi.fn((cmd) => (
        cmd === 'read_settings_json' ? Promise.resolve(disk) : Promise.resolve()
      )) } },
    };
    ({ safeStorage } = await import('../../src/stores/safeStorage.js'));
  });

  it('returns the disk copy when nothing wrote first', async () => {
    const raw = await safeStorage.getItem('mailvault-settings');
    expect(JSON.parse(raw).state.language).toBe('de');
    expect(JSON.parse(raw).state.listPaneSize).toBe(470);
  });

  it('keeps the disk copy when a write lands first', async () => {
    // What `setLocale(...)` at import time does, via persist: the store's
    // defaults plus one change. It used to replace the disk copy whole, and
    // every other saved setting went with it. The disk copy wins now; the
    // store's hydration merges it over the in-memory state.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    safeStorage.setItem('mailvault-settings', JSON.stringify({
      version: 4, state: { language: 'en' },
    }));
    const raw = await safeStorage.getItem('mailvault-settings');
    const state = JSON.parse(raw).state;
    expect(state.language).toBe('de');
    expect(state.listPaneSize).toBe(470);
  });
});
