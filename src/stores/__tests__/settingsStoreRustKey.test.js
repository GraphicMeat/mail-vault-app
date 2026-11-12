/**
 * The Rust side (daemon, shell, core) reads this store straight out of
 * `frontend-settings.json` at `<persist name>.state.<key>`, through the one
 * constant `settings_doc::STORE` (src-core/src/settings_doc.rs). Renaming the
 * store, bumping its persist version (a migration may rename a key the Rust
 * readers use) or dropping a key the shell reads at exit must fail here, not
 * as a silently ignored setting.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
  };
});

const { useSettingsStore } = await import('../settingsStore');
const rust = readFileSync('src-core/src/settings_doc.rs', 'utf8');

function rustConst(name) {
  const m = rust.match(new RegExp(`pub const ${name}: [^=]+= "?([^";]+)"?;`));
  return m && m[1];
}

describe('the Rust readers of the persisted settings store', () => {
  it('use the persist name and version this store writes', () => {
    const { name, version } = useSettingsStore.persist.getOptions();
    expect(rustConst('STORE')).toBe(name);
    expect(Number(rustConst('STORE_VERSION'))).toBe(version);
  });

  it('find the keys the shell reads at quit and close', () => {
    const state = useSettingsStore.getState();
    // src-core/src/autostart.rs: always_on_from_settings, close_to_tray_from_settings
    for (const key of ['daemonAlwaysOn', 'closeToTray']) {
      expect(typeof state[key], key).toBe('boolean');
    }
  });
});
