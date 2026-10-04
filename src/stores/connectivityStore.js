import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';

/**
 * One answer to "is this machine online?", for the whole app.
 *
 * There are three sources and they disagree, so each is used for what it is
 * actually good for:
 *
 * - `window.offline` — the OS path monitor, via the webview. Instant, and
 *   trustworthy when it says *false*: nothing routes off a machine with no
 *   link. This is the fast edge.
 * - `window.online` — the same monitor saying the link came back. NOT proof of
 *   internet (a joined captive-portal Wi-Fi fires it), so it triggers a probe
 *   rather than setting the flag.
 * - a probe — the daemon's `net.probe`, or the Tauri command when no daemon is
 *   running. TCP handshakes against three resolvers. This is the authority.
 *
 * The daemon's 30s heartbeat carries the steady-state verdict along with it
 * (see transport.js), so nothing here polls.
 */

/** E2E mock connectivity object pins the verdict; see `installNetMock`. */
let _forced = null;
/** The probe in flight, shared by every caller that arrives during it. */
let _inflight = null;

function readNavigator() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export const useConnectivityStore = create((set, get) => ({
  online: readNavigator(),
  /** A probe is in flight — the banner shows it rather than looking stuck. */
  checking: false,
  /** Epoch ms of the last verdict, forced or probed. */
  lastVerdictAt: 0,

  /**
   * Adopt a verdict. `force` is the e2e mock; while it is pinned, real
   * verdicts (heartbeat, probe) are ignored so a test can't be raced by one.
   * `dialled` marks a verdict from a probe that actually reached the network.
   */
  setOnline(online, { force = false, dialled = false } = {}) {
    if (force) _forced = online === true;
    else if (_forced !== null) return;
    // The daemon's gate starts optimistic and only probes after one of its own
    // syncs fails, so a heartbeat `true` from an idle daemon is a default, not
    // a verdict. The OS path monitor saying "no link" outranks it: nothing
    // routes off a machine with no link, whatever the gate believes.
    // A dialled `true` is not outranked: an answer came back, so the monitor
    // is the one that is wrong. A confined snap without `network-status` has
    // its portal monitor refused and reads offline for the whole session.
    else if (online && !dialled && !readNavigator()) return;
    const next = force ? _forced : online === true;
    if (get().online !== next) {
      console.log(`[connectivity] ${next ? 'online' : 'OFFLINE'}`);
    }
    set({ online: next, lastVerdictAt: Date.now() });
  },

  /**
   * Ask the authority. Returns the verdict.
   *
   * Shape care: the daemon answers `{online: bool}` and the Tauri command
   * answers a bare bool — `{online:false}` is truthy, so both are narrowed to
   * `=== true` rather than used raw.
   */
  probe() {
    if (_forced !== null) return Promise.resolve(_forced);
    // A caller arriving mid-probe gets that probe's answer. Handing it the
    // flag instead gave it the pre-probe value (`false` in the snap), which
    // loadEmails took as "no internet" and stopped.
    if (_inflight) return _inflight;
    set({ checking: true });
    _inflight = (async () => {
      let online;
      let dialled = true;
      try {
        const status = await daemonCall('net.probe');
        online = status?.online === true;
      } catch {
        // No daemon (or it refused) — ask the app process directly.
        const invoke = typeof window !== 'undefined' && window.__TAURI__?.core?.invoke;
        dialled = !!invoke;
        online = invoke ? (await invoke('check_network_connectivity')) === true : readNavigator();
      }
      get().setOnline(online, { dialled });
      return online;
    })().finally(() => {
      _inflight = null;
      set({ checking: false });
    });
    return _inflight;
  },
}));

/** Wire the webview's path-monitor events. Idempotent. */
let _wired = false;
export function wireConnectivityEvents(target = typeof window !== 'undefined' ? window : null) {
  if (_wired || !target?.addEventListener) return;
  _wired = true;
  const store = useConnectivityStore.getState();
  // `false` is trustworthy on its own; `true` only earns a probe.
  target.addEventListener('offline', () => store.setOnline(false));
  target.addEventListener('online', () => { store.probe(); });
  // `offline` is an edge, so a monitor that starts offline and never changes
  // (the refused snap portal) fires nothing. Check it once instead of waiting
  // for an account activation to probe.
  if (!readNavigator()) store.probe();
}

/**
 * The mock connectivity object the e2e suite drives. Only installed in E2E
 * builds — `VITE_E2E` is a compile-time constant, so a shipped bundle drops
 * this entirely and nothing can pin the app offline in production.
 */
export function installNetMock(target) {
  if (!target) return;
  target.__mvNet = {
    /** Pin the app online/offline, ignoring heartbeats and probes. */
    setOnline: (online) => useConnectivityStore.getState().setOnline(online, { force: true }),
    /** Release the pin and re-probe for real. */
    release: () => { _forced = null; return useConnectivityStore.getState().probe(); },
    get online() { return useConnectivityStore.getState().online; },
  };
}

/** Test seam — resets module state between specs. */
export function __resetConnectivityForTests() {
  _forced = null;
  _inflight = null;
  _wired = false;
  useConnectivityStore.setState({ online: true, checking: false, lastVerdictAt: 0 });
}
