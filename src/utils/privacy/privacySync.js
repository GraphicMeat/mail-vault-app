import { usePrivacyStore } from '../../stores/privacyStore';
import { isChildWindow } from './isChildWindow';

const EVENT = 'privacy-mode-changed';

/**
 * The main window owns the toggle. Detached windows read the persisted value at
 * mount (safeStorage) and follow every change through this event.
 */
// ponytail: a toggle between a child's disk read and its listen registering is
// missed until the next toggle or reopen; narrow (ms), revisit if ever reported.
export function startPrivacySync() {
  let stop = () => {};
  let cancelled = false;
  import('@tauri-apps/api/event').then(({ emit, listen }) => {
    if (cancelled) return;
    if (isChildWindow()) {
      listen(EVENT, ({ payload }) => usePrivacyStore.setState({ enabled: !!payload?.enabled, peek: false }))
        .then(un => { if (cancelled) un(); else stop = un; })
        .catch(() => {});
    } else {
      stop = usePrivacyStore.subscribe((s, prev) => {
        if (s.enabled !== prev.enabled) emit(EVENT, { enabled: s.enabled }).catch(() => {});
      });
    }
  }).catch(() => { /* no Tauri (web dev) */ });
  return () => { cancelled = true; stop(); };
}
