import { getDocRegistry } from './docRegistry';
import { hitRender } from '../service';
import { openBlitzWindow } from './popout';

const failures = [];
/** Every code that reached the failure UX (e2e reads it; production keeps the last 50). */
export function recordFailure(code) {
  failures.push(String(code));
  if (failures.length > 50) failures.shift();
}

export function installDebugHook(win = typeof window !== 'undefined' ? window : null) {
  if (import.meta.env.VITE_E2E !== '1' || !win) return;
  win.__MV_BLITZ_DEBUG__ = {
    // The registry is read per call: a test reset replaces the singleton.
    openDocs: () => getDocRegistry().openCount(),
    liveDocs: () => getDocRegistry().liveCount(),
    deferredDocs: () => getDocRegistry().deferredCount(),
    pendingOpens: () => getDocRegistry().pendingCount(),
    docIds: () => getDocRegistry().docIds(),
    failures: () => [...failures],
    // The same opener the Open in window seams call.
    openWindow: (args) => openBlitzWindow(args),
    // 'ok' while the worker holds the doc; the error code once it does not
    // (render.hit on a closed doc rejects with render_unknown_doc, plan A Task 4).
    probe: async (docId) => { try { await hitRender(docId, 0, 0); return 'ok'; } catch (e) { return String(e?.message || e); } },
  };
}
