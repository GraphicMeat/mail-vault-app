/**
 * Auto-cleanup rules: thin bindings to the daemon's `cleanup.*` RPCs
 * (src-daemon/src/handlers/cleanup.rs, runs in src-daemon/src/cleanup_worker.rs,
 * selection in src-core/src/cleanup_rules.rs). The daemon runs the rules once
 * a day on its own and when asked, through the Archive & delete engine; the
 * app only stores the rules (Storage settings) and shows the last run.
 */

import { send } from './transport.js';

/** `{ running, lastRun: {archived, deleted, skipped, at} | null, nextDueAt }`. */
export function cleanupStatus() {
  return send('cleanup.status', {});
}

/** Start a run. `{ started }`, or `{ started: false, running: true }` while one is going. */
export function runCleanupNow() {
  return send('cleanup.run_now', {});
}

/** The dry run from the caches: `{ ran, archived: 0, deleted, skipped: 0, rules: [{ id, matched }] }`. */
export function previewCleanup() {
  return send('cleanup.preview', {});
}

/** The stored rules as the daemon reads them, each with `refused` (catalog key or null) and `runs`. */
export function cleanupRules() {
  return send('cleanup.rules.get', {});
}

/**
 * Follow runs: `onRun(payload)` gets every `cleanup-run` event
 * (`{state: 'running'}` then `{state: 'done', ran, lastRun}`). Returns the
 * unsubscribe function. A no-op outside the desktop shell.
 */
export async function onCleanupRun(onRun) {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen('cleanup-run', (e) => onRun(e?.payload || {}));
  } catch {
    return () => {};
  }
}
