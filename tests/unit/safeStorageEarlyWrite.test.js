import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `safeStorage` reads the settings file through Tauri, so hydration is async,
 * and `ensureLoaded` deliberately refuses to overwrite a key already in the
 * cache — "in-session writes take priority".
 *
 * That rule is only safe while nothing writes before the read lands. Any
 * `setState` during module evaluation makes zustand's persist middleware write
 * the settings key immediately, and the disk copy is then dropped whole: not
 * just the field that was written, but every setting the user ever saved.
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

  it('drops the whole disk copy when a write lands first', async () => {
    // What `setLocale(...)` at import time does, via persist.
    safeStorage.setItem('mailvault-settings', JSON.stringify({
      version: 4, state: { language: 'en' },
    }));
    const raw = await safeStorage.getItem('mailvault-settings');
    const state = JSON.parse(raw).state;
    expect(state.language).toBe('en');
    // The point: listPaneSize was never written by the early caller, and it is
    // gone anyway. Every other saved setting goes with it.
    expect(state.listPaneSize).toBeUndefined();
  });
});
