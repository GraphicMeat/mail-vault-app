import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import * as db from '../services/db';
import { retryKeychainAccess } from '../services/workflows/retryKeychainAccess';
import { notify } from './focusStore';
import { t } from '../i18n/index.js';

// The daemon's keychain gate (src-daemon/src/credentials.rs): blocked while a
// keychain read the user can fix by unlocking keeps failing, cleared by the
// next read that answers. The daemon owns that state; this store mirrors it
// for KeychainUnlockDialog and runs the unlock.
export const useKeychainGateStore = create((set, get) => ({
  blocked: false,
  reason: null,
  dismissed: false,
  unlocking: false,
  // After a failed Unlock: 'timeout' | 'locked' | 'denied' | 'error'.
  error: null,

  /// A `keychain-status` event or a `keychain.status` reply. Only the live
  /// event may `announce`: the launch-time ask is often the app being opened
  /// by a click on the daemon's own banner, and must not raise a second one.
  apply: (status, { announce = false } = {}) => {
    const blocked = !!status?.blocked;
    if (blocked && !get().blocked) {
      // A new block reopens a dialog the user put off during the last one.
      set({ blocked: true, reason: status.reason || null, dismissed: false, error: null });
      if (announce && windowInBackground()) {
        // Not a mail banner, so notify() applies no mail policy to it; a
        // Focus session still holds it, and the dialog is waiting either way.
        notify(t('keychainGate.notifyTitle'), t('keychainGate.notifyBody'));
      }
    } else if (!blocked && get().blocked) {
      set({ blocked: false, reason: null, error: null });
    }
  },

  dismiss: () => set({ dismissed: true }),

  unlock: async () => {
    if (get().unlocking) return;
    set({ unlocking: true, error: null });
    try {
      // The app's own read first: a foreground app is what macOS shows the
      // unlock or "allow" prompt to. The cache and a past refusal would both
      // skip the read, so both are cleared.
      db.clearCredentialsCache();
      await db.getAccounts();
      // No client-side budget on a dotted daemon method (reply_timeout in
      // src-tauri/src/main.rs), so the daemon's own 120s clock is the limit.
      const result = await daemonCall('keychain.retry');
      if (!result?.ok) {
        set({ unlocking: false, error: result?.reason || 'error' });
        return;
      }
      set({ blocked: false, reason: null, unlocking: false });
      // Re-activate, so `sync.watch` registers again now the daemon can read.
      await retryKeychainAccess();
    } catch (err) {
      console.warn('[keychainGate] unlock failed:', err);
      set({ unlocking: false, error: 'error' });
    }
  },
}));

function windowInBackground() {
  return typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
}

let _initialized = false;

/// Once, from KeychainUnlockDialog. The daemon drops an event nobody is
/// subscribed to, so the state is asked for at start and again on every
/// `daemon-reconnected`, after the listeners are attached (VaultAlertBanner's
/// pattern).
export function initKeychainGate() {
  if (_initialized) return;
  _initialized = true;
  const ask = () => daemonCall('keychain.status')
    .then(status => useKeychainGateStore.getState().apply(status))
    .catch(() => {});
  (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      await listen('keychain-status', e => useKeychainGateStore.getState().apply(e.payload, { announce: true }));
      await listen('daemon-reconnected', ask);
    } catch { /* web dev mode: no Tauri events */ }
    await ask();
  })();
}

export function __resetKeychainGateForTests() {
  _initialized = false;
  useKeychainGateStore.setState({ blocked: false, reason: null, dismissed: false, unlocking: false, error: null });
}
