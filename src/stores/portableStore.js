import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { retryKeychainAccess } from '../services/workflows/retryKeychainAccess';

// Portable mode (src-daemon/src/handlers/portable.rs): a copy running from a
// drive keeps its accounts sealed there, locked at every launch. The daemon
// owns that state; this store mirrors it for the unlock card, the sidebar
// badge and Settings > Portable.
const INSTALLED = { portable: false };

export const usePortableStore = create((set, get) => ({
  status: INSTALLED,
  unlocking: false,
  // After a failed unlock: 'wrong' | 'error'.
  error: null,

  /// A `portable-status` event or a `portable.status` reply.
  apply: (status) => {
    const was = get().status;
    const next = status || INSTALLED;
    set({ status: next });
    // Once per unlock, however it happened: the accounts read while locked
    // came back empty-handed, so they are read again now.
    if (was.portable && was.locked && next.portable && !next.locked) {
      set({ error: null });
      retryKeychainAccess().catch(() => {});
    }
  },

  refresh: () => daemonCall('portable.status').then(s => get().apply(s)).catch(() => {}),

  unlock: async (passphrase) => {
    if (get().unlocking) return;
    set({ unlocking: true, error: null });
    try {
      await daemonCall('portable.unlock', { passphrase });
      set({ unlocking: false });
      // The daemon's event may still be on its way; `apply` recovers once.
      get().apply({ ...get().status, locked: false });
    } catch (err) {
      const wrong = String(err?.message || err).includes('E_PORTABLE_PASSPHRASE');
      set({ unlocking: false, error: wrong ? 'wrong' : 'error' });
    }
  },
}));

let _initialized = false;

/// Once, from the unlock card: the state is asked for at start and on every
/// `daemon-reconnected`, after the listeners are attached.
export function initPortable() {
  if (_initialized) return;
  _initialized = true;
  const ask = () => usePortableStore.getState().refresh();
  (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      await listen('portable-status', e => usePortableStore.getState().apply(e.payload));
      await listen('daemon-reconnected', ask);
    } catch { /* web dev mode: no Tauri events */ }
    await ask();
  })();
}

export function __resetPortableForTests() {
  _initialized = false;
  usePortableStore.setState({ status: INSTALLED, unlocking: false, error: null });
}
