import { useEffect, useRef } from 'react';
import { useMailStore } from '../stores/mailStore';
import { pipelineManager } from '../services/EmailPipelineManager';

/**
 * React bridge for the EmailPipelineManager.
 * Watches store state and drives pipeline lifecycle:
 *   - Starts active account pipeline after emails load
 *   - Handles account switching
 *   - Pauses/resumes on offline/online
 *   - Cleans up on unmount
 */
export function usePipelineCoordinator() {
  const { activeAccountId, emails, loading, accounts } = useMailStore();
  const startedForRef = useRef(null); // tracks which account we started the pipeline for
  const prevAccountIdRef = useRef(null);

  // Start active account pipeline after emails load
  useEffect(() => {
    if (!activeAccountId || emails.length === 0 || loading) return;

    // Don't restart if we already started for this account
    if (startedForRef.current === activeAccountId) return;

    const timer = setTimeout(() => {
      console.log(`[PipelineCoordinator] Starting pipeline for account ${activeAccountId}`);
      startedForRef.current = activeAccountId;
      pipelineManager.startActiveAccountPipeline(activeAccountId);
    }, 5000); // 5s delay — matches the original useBackgroundCaching delay

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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      pipelineManager.destroyAll();
    };
  }, []);
}
