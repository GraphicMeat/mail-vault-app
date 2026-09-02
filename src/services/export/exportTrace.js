// e2e trace ring: where an export got to, read by the spec when nothing lands
// on disk in time. Compiled out of a shipped build like the fault seam in
// exportService.js — a bare "0 files" has twice sent a session re-deriving
// this whole pipeline by hand.
const E2E = Boolean(import.meta.env?.VITE_E2E);

export const trace = (step, data) => {
  if (E2E) (globalThis.window.__MV_EXPORT_TRACE__ ??= []).push({ t: Date.now(), step, ...data });
};
