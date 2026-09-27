import { create } from 'zustand';

/// Bulk attachment saves run as daemon jobs: the RPC answers `{ jobId }` at
/// once and `attachment-export-progress` frames follow, one per step, then a
/// last one (`finished`) with the `result` or the `error`.
export const EXPORT_PROGRESS_EVENT = 'attachment-export-progress';

/// Saves in flight, keyed by what they cover (one message, one view), as
/// `{ done, total }`. Anything drawing those attachments reads it to stay
/// locked until the save is over.
export const useAttachmentExports = create(() => ({}));

export const messageExportKey = (accountId, mailbox, uid) => `message:${accountId}|${mailbox}|${uid}`;
export const viewExportKey = viewId => `view:${viewId ?? 'search'}`;

function setExport(key, progress) {
  useAttachmentExports.setState(state => {
    const next = { ...state };
    if (progress) next[key] = progress;
    else delete next[key];
    return next;
  }, true);
}

const newJobId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Run one export job under `key` and answer its result.
 *
 * `start(jobId)` sends the RPC. The listener is up before it goes, so a job
 * that ends before the reply lands is still heard. A helper that restarts
 * mid-job never sends its last frame, so a reconnect ends the wait as a
 * failure. `fallback(error, report)`, when given, runs while the key is still
 * held (the attachments stay locked) and answers in the job's place.
 */
export async function runAttachmentExport(key, start, fallback) {
  const jobId = newJobId();
  const report = (done, total) => setExport(key, { done, total });
  const unlisten = [];
  let settle;
  const finished = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  // Settled while nobody awaits it (the RPC itself threw) is not an error.
  finished.catch(() => {});
  report(0, 0);
  try {
    const { listen } = await import('@tauri-apps/api/event');
    unlisten.push(await listen(EXPORT_PROGRESS_EVENT, ({ payload }) => {
      if (payload?.jobId !== jobId) return;
      if (payload.error) settle.reject(new Error(payload.error));
      else if (payload.finished) settle.resolve(payload.result);
      else report(payload.done || 0, payload.total || 0);
    }));
    unlisten.push(await listen('daemon-reconnected', () => settle.reject(new Error('The helper restarted during the export'))));
    await start(jobId);
    return await finished;
  } catch (error) {
    if (!fallback) throw error;
    console.warn('[attachments] export job failed, falling back:', error);
    return await fallback(error, report);
  } finally {
    for (const stop of unlisten) {
      try { stop(); } catch { /* the other listener still goes */ }
    }
    setExport(key, null);
  }
}

/// Ask where to save: the native folder picker, opening on Downloads. `null`
/// is a cancel. The same `plugin:dialog|open` the dialog plugin's own `open()`
/// sends (the plugin still adds the pick to the fs scope), but through the live
/// `window.__TAURI__.core` bridge, which an e2e probe can answer: the plugin
/// module's frozen import reaches the native side where no probe sees it.
export async function pickFolder(title) {
  const { downloadDir } = await import('@tauri-apps/api/path');
  const picked = await window.__TAURI__.core.invoke('plugin:dialog|open', {
    options: { directory: true, multiple: false, defaultPath: await downloadDir(), title },
  });
  return typeof picked === 'string' && picked ? picked : null;
}

/// The last component of a native path: `\` separates on Windows, `/` elsewhere.
export const leafOf = path => String(path || '').split(/[\\/]/).pop();

/// Reveal a saved folder. A refusal (a sandbox scope Finder does not hold)
/// leaves the "Saved to" line as the only pointer, which it already is.
export function showSavedFolder(path) {
  return window.__TAURI__?.core?.invoke?.('show_in_folder', { path })?.catch?.(() => {});
}
