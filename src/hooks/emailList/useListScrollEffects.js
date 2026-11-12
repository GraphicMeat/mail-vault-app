import { useEffect, useRef } from 'react';
import { useMailStore } from '../../stores/mailStore';
import { backfillTrackerVerdicts } from '../../services/rowVerdicts';
import { currentListView } from '../../stores/viewStore';
import { useSearchStore } from '../../stores/searchStore';
import { shouldPrefetch } from '../../services/cachePressure';

export function useListScrollEffects({ loading, rowCount, scrollContainerRef, activeMailbox, activeAccountId, viewMode, isExplorer, searchActive, loadingMore, hasMoreEmails, virtualizer, threadedDisplay, loadMoreEmails, ROW_HEIGHT_DEFAULT }) {
  // Diagnostic: trace loading spinner condition
  useEffect(() => {
    if (loading && rowCount === 0) {
      const state = useMailStore.getState();
      console.log('[EmailList] SPINNER VISIBLE — loading=%s, rowCount=%d, emails=%d, sortedEmails=%d, viewMode=%s, activeMailbox=%s',
        loading, rowCount, state.emails.length, state.sortedEmails.length, state.viewMode, state.activeMailbox);
    }
  }, [loading, rowCount]);

  // Reset scroll position when switching mailbox, account, or view mode
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [activeMailbox, activeAccountId, viewMode]);

  // Auto-load more emails when approaching the end of the loaded list
  useEffect(() => {
    if (isExplorer || searchActive || loadingMore || !hasMoreEmails || viewMode === 'local') return;
    const items = virtualizer.getVirtualItems();
    const lastVisible = items[items.length - 1];
    if (lastVisible && lastVisible.index >= threadedDisplay.length - 20) {
      const timer = setTimeout(() => { loadMoreEmails(); }, 100);
      return () => clearTimeout(timer);
    }
  }, [isExplorer, virtualizer, threadedDisplay.length, hasMoreEmails, loadingMore, searchActive, viewMode, loadMoreEmails]);

  // Tracker verdicts for rows nobody has opened. The scan needs a body and the
  // header cache has none, so the glyph used to appear only on messages that
  // had been read — invisible on a list of a thousand tracked newsletters.
  // Bodies already in the vault answer for free; this reads only what is on
  // screen, and only once per message.
  useEffect(() => {
    if (isExplorer) return;
    const container = scrollContainerRef.current;
    let timer = null;
    const run = () => {
      const headers = [];
      for (const item of virtualizer.getVirtualItems()) {
        const row = threadedDisplay[item.index];
        if (!row) continue;
        if (row.type === 'thread') headers.push(...row.thread.emails);
        else if (row.email) headers.push(row.email);
      }
      backfillTrackerVerdicts(headers, useMailStore.getState());
    };
    // Settle, then read. Mid-fling the visible window is a different set every
    // frame, and each one would cost a vault read per row.
    const arm = () => { clearTimeout(timer); timer = setTimeout(run, 400); };
    arm();
    container?.addEventListener('scroll', arm, { passive: true });
    return () => { clearTimeout(timer); container?.removeEventListener('scroll', arm); };
  }, [isExplorer, virtualizer, threadedDisplay]);

  // Idle memory trim — after scrolling settles, check pressure and trim if needed
  const scrollIdleTimerRef = useRef(null);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      // Re-arm pagination from the real scroll position. The auto-load effect
      // above cannot fire on scroll — the virtualizer instance is referentially
      // stable, so that effect's deps only change when the DATA changes. It
      // keeps a running load chain going but can never restart a dead one,
      // which left the list permanently stuck when the chain died silently
      // (offline blip, aborted probe). loadMoreEmails self-guards against
      // double-entry via `loadingMore`.
      if (currentListView() !== 'explorer'
        && container.scrollTop + container.clientHeight >= container.scrollHeight - 20 * ROW_HEIGHT_DEFAULT) {
        const { hasMoreEmails, loadingMore, viewMode, loadMoreEmails } = useMailStore.getState();
        if (hasMoreEmails && !loadingMore && viewMode !== 'local' && !useSearchStore.getState().searchActive) {
          loadMoreEmails();
        }
      }
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = setTimeout(() => {
        if (!shouldPrefetch()) {
          const { evictPrefetchEntries } = useMailStore.getState();
          if (evictPrefetchEntries) evictPrefetchEntries();
        }
      }, 1500);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
    };
  }, []);
}
