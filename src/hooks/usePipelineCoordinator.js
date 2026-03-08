import { useEffect, useRef } from 'react';
import { useMailStore } from '../stores/mailStore';
import { pipelineManager } from '../services/EmailPipelineManager';
import { runCleanupRules, shouldRunCleanup } from '../services/cleanupEngine';

/**
 * React bridge for the EmailPipelineManager.
 * Watches store state and drives pipeline lifecycle:
 *   - Starts active account pipeline after emails load
 *   - Handles account switching
 *   - Pauses/resumes on offline/online
 *   - Cleans up on unmount
 */
export function usePipelineCoordinator() {
  const activeAccountId = useMailStore(s => s.activeAccountId);
  const emails = useMailStore(s => s.emails);
  const loading = useMailStore(s => s.loading);
  const accounts = useMailStore(s => s.accounts);
  const startedForRef = useRef(null); // tracks which account we started the pipeline for
  const prevAccountIdRef = useRef(null);
  const prevEmailCountRef = useRef(0);

  // Reset pipeline tracking when emails drop to 0 (e.g., cache clear)
  useEffect(() => {
    if (prevEmailCountRef.current > 0 && emails.length === 0) {
      startedForRef.current = null;
    }
    prevEmailCountRef.current = emails.length;
  }, [emails.length]);

  // Start active account pipeline after emails load
  useEffect(() => {
    if (!activeAccountId || emails.length === 0 || loading) return;

    // Don't restart if we already started for this account
    if (startedForRef.current === activeAccountId) return;

    const timer = setTimeout(() => {
      console.log(`[PipelineCoordinator] Starting pipeline for account ${activeAccountId}`);
      startedForRef.current = activeAccountId;
      pipelineManager.startActiveAccountPipeline(activeAccountId);
    }, 200); // 200ms delay — enough for UI to stabilize after account switch

    return () => clearTimeout(timer);
  }, [activeAccountId, emails.length, loading]);

  // Handle account switching
  useEffect(() => {
    if (!activeAccountId || activeAccountId === prevAccountIdRef.current) return;

    if (prevAccountIdRef.current !== null) {
      // This is an actual switch, not the initial load
      console.log(`[PipelineCoordinator] Account switched to ${activeAccountId}`);
      pipelineManager.onAccountSwitch(activeAccountId);
      startedForRef.current = null; // allow pipeline to start for new account
    }
    prevAccountIdRef.current = activeAccountId;
  }, [activeAccountId]);

  // Sync pipelines when accounts list changes (handle removals)
  useEffect(() => {
    pipelineManager.syncAccounts(accounts);
  }, [accounts]);

  // Online/offline handling
  useEffect(() => {
    const handleOnline = () => {
      console.log('[PipelineCoordinator] Online — resuming pipelines');
      pipelineManager.resumeAll();
    };

    const handleOffline = () => {
      console.log('[PipelineCoordinator] Offline — pausing pipelines');
      pipelineManager.pauseAll();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Auto-cleanup rules — run once after initial sync, then check hourly
  const cleanupRanRef = useRef(false);
  useEffect(() => {
    if (!activeAccountId || emails.length === 0 || loading) return;
    if (cleanupRanRef.current) return;

    // Run cleanup after initial sync settles (5s delay to avoid competing with pipeline)
    const initialTimer = setTimeout(() => {
      if (shouldRunCleanup()) {
        cleanupRanRef.current = true;
        runCleanupRules().catch(e => console.error('[PipelineCoordinator] Cleanup failed:', e));
      }
    }, 5000);

    // Check hourly whether 24h has passed since last run
    const hourlyInterval = setInterval(() => {
      if (shouldRunCleanup()) {
        runCleanupRules().catch(e => console.error('[PipelineCoordinator] Scheduled cleanup failed:', e));
      }
    }, 60 * 60 * 1000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(hourlyInterval);
    };
  }, [activeAccountId, emails.length, loading]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      pipelineManager.destroyAll();
    };
  }, []);
}
