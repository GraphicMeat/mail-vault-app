import { useEffect, useState } from 'react';

/**
 * `{supported, enabled, reason, needsApproval}` from Rust's `autostart_state`
 * (see DaemonAlwaysOn.jsx, which reads the same command for the Settings
 * switch) — `null` before the first answer, or outside Tauri. Used by
 * scheduled-send copy to say whether the user *could* turn always-on on,
 * never to guess it.
 */
export function useAutostartState() {
  const [state, setState] = useState(null);
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const next = await invoke('autostart_state');
        if (!disposed) setState(next);
      } catch {
        if (!disposed) setState(null);
      }
    })();
    return () => { disposed = true; };
  }, []);
  return state;
}
