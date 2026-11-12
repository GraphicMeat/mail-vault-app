import { useEffect, useRef, useState } from 'react';
import { buildThreads, reconcileThreads } from '../../utils/emailParser';

export function useDeferredThreads({ isExplorer, mergedEmails, threadFingerprint, searchActive, activeViewId, viewMode, threadMode, emailRowHighlight, syncSelectedThread }) {
  // Deferred threading — buildThreads(17k+) is too slow for synchronous render.
  // Show flat list instantly, then compute threads in background and re-render.
  const threadCache = useRef({ fingerprint: '', threads: new Map() });
  const [deferredThreads, setDeferredThreads] = useState(null); // null = not computed yet

  // Compute threads in a deferred callback to avoid blocking render
  useEffect(() => {
    // Flat mode still builds threads when the marking mode needs them: they
    // answer "which rows are siblings", never "which rows group".
    // Not inside a saved view either: its rows are not the folder's, and the
    // folder's threads must not re-read (add to, drop from) a thread opened
    // there. While the view runs, the list shows its loading state anyway.
    if (isExplorer || !mergedEmails || searchActive || activeViewId || (threadMode === 'flat' && emailRowHighlight !== 'selection')) {
      setDeferredThreads(null);
      return;
    }

    // Use cached threads if fingerprint matches
    if (threadCache.current.fingerprint === threadFingerprint) {
      setDeferredThreads(threadCache.current.threads);
      syncSelectedThread(threadCache.current.threads);
      return;
    }

    // Schedule thread computation after paint — keeps UI responsive
    // Note: requestIdleCallback is NOT available in WebKit/Safari (Tauri macOS webview)
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return; // Guard against stale callback after view change
      // Threads that did not change keep their object, so their rows bail.
      const threads = reconcileThreads(threadCache.current.threads, buildThreads(mergedEmails));
      threadCache.current = { fingerprint: threadFingerprint, threads };
      setDeferredThreads(threads);
      // The reader's open thread is a snapshot of one of these. This is the
      // only place the whole pool is threaded, so it is where the snapshot is
      // re-read — a reply sent from inside a thread reaches the pane here.
      syncSelectedThread(threads);
    }, 0);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [isExplorer, mergedEmails, threadFingerprint, searchActive, activeViewId, viewMode, threadMode, emailRowHighlight, syncSelectedThread]);

  return { threadCache, deferredThreads, setDeferredThreads };
}
