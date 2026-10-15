// A worker can drop a doc the page still holds an id for (it evicts the least recently used past its cap,
// and a restart loses them all). Any op that finds its doc gone reports it here, so the registry stops
// serving that id to the next acquirer. A leaf module: service.js reports, docRegistry.js listens.
const UNKNOWN_DOC = 'render_unknown_doc';
const listeners = new Set();

/** Calls `fn(docId)` whenever an op finds its doc gone. Returns the unsubscribe. */
export function onDocGone(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** For an op's rejection: reports `docId` when the error says the worker no longer has it. */
export function reportDocGone(docId, err) {
  if ((err?.message ?? err?.code ?? err) !== UNKNOWN_DOC) return;
  listeners.forEach((fn) => { try { fn(docId); } catch { /* a listener never breaks the op's own rejection */ } });
}
