import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import * as db from '../services/db';
import { retryKeychainAccess } from '../services/workflows/retryKeychainAccess';
import { notify } from './focusStore';
import { t } from '../i18n/index.js';

// The daemon's keychain gate (src-daemon/src/credentials.rs): blocked while a
// keychain item the daemon needs cannot be read for a reason unlocking would
// fix. The daemon watches that itself and owns the state; this store mirrors
// it for KeychainUnlockCard and runs the unlock.
export const useKeychainGateStore = create((set, get) => ({
  blocked: false,
  reason: null,
  unlocking: false,
  // After a failed Unlock: 'timeout' | 'locked' | 'denied' | 'error'.
  error: null,

  /// A `keychain-status` event or a `keychain.status` reply. Only the live
  /// event may `announce`: the launch-time ask is often the app being opened
  /// by a click on the daemon's own banner, and must not raise a second one.
  apply: (status, { announce = false } = {}) => {
    const blocked = !!status?.blocked;
    if (blocked && !get().blocked) {
      set({ blocked: true, reason: status.reason || null, error: null });
      if (announce && windowInBackground()) {
        // Not a mail banner, so notify() applies no mail policy to it; a
        // Focus session still holds it, and the card is waiting either way.
        notify(t('keychainGate.notifyTitle'), t('keychainGate.notifyBody'));
      }
    } else if (!blocked && get().blocked) {
      set({ blocked: false, reason: null, error: null });
      // However it was unlocked (here, in Keychain Access, by the daemon's
      // watcher noticing), the app's own "Password missing" state recovers
      // and `sync.watch` registers again. Once per unblock: this branch only
      // runs on the transition.
      retryKeychainAccess().catch(() => {});
    }
  },

  unlock: async () => {
    if (get().unlocking) return;
    set({ unlocking: true, error: null });
    try {
      // The daemon's own read first: the user is here to answer its prompt,
      // and that is the only prompt in the common case. No client-side budget
      // on a dotted daemon method (reply_timeout in src-tauri/src/main.rs), so
      // the daemon's own 120s clock is the limit.
      let result = await daemonCall('keychain.retry');
      if (!result?.ok && result?.reason === 'locked') {
        // A locked keychain will not prompt for a background process. A read
        // by the foreground app makes macOS ask for the password; the cache
        // and a past refusal would both skip that read, so both are cleared.
        db.clearCredentialsCache();
        await db.getAccounts();
        result = await daemonCall('keychain.retry');
      }
      if (!result?.ok) {
        set({ unlocking: false, error: result?.reason || 'error' });
        return;
      }
      set({ unlocking: false });
      // The daemon's clear event may still be on its way; `apply` runs the
      // recovery once, whichever of the two lands first.
      get().apply({ blocked: false });
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

/// Once, from KeychainUnlockCard. The daemon drops an event nobody is
/// subscribed to, so the state is asked for at start and again on every
/// `daemon-reconnected`, after the listeners are attached (VaultAlertBanner's
/// pattern).
///
/// macOS only: the card explains the macOS Keychain and its prompts. Elsewhere
/// the gate only closes on a read timing out, and the existing keychain toast
/// already covers the app's own reads.
export function initKeychainGate() {
  if (_initialized || !/Mac/i.test(navigator.platform || navigator.userAgent || '')) return;
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
  useKeychainGateStore.setState({ blocked: false, reason: null, unlocking: false, error: null });
}
