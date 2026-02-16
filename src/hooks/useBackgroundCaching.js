import { useEffect, useRef, useCallback, useState } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import * as db from '../services/db';
import * as api from '../services/api';

export function useBackgroundCaching() {
  const workerRef = useRef(null);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });

  const {
    activeAccountId,
    activeMailbox,
    emails,
    savedEmailIds,
    addToCache,
    accounts
  } = useMailStore();

  const { localCacheDurationMonths, cacheLimitMB } = useSettingsStore();

  // Create worker on mount
  useEffect(() => {
    // Create worker from blob URL for better compatibility
    const workerCode = `
      let isPaused = false;
      let isStopped = false;
      let uidQueue = [];

      const FETCH_DELAY = 500;
      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      self.onmessage = function(event) {
        const { type, payload } = event.data;

        switch (type) {
          case 'start':
            isStopped = false;
            isPaused = false;
            uidQueue = [...payload.uids];
            // Signal ready - main thread will handle actual fetching
            self.postMessage({ type: 'ready', uids: uidQueue });
            break;

          case 'pause':
            isPaused = true;
            self.postMessage({ type: 'paused' });
            break;

          case 'resume':
            isPaused = false;
            self.postMessage({ type: 'resumed' });
            break;

          case 'stop':
            isStopped = true;
            uidQueue = [];
            self.postMessage({ type: 'stopped' });
            break;

          case 'nextUid':
            if (uidQueue.length > 0 && !isStopped && !isPaused) {
              const uid = uidQueue.shift();
              self.postMessage({ type: 'fetchUid', uid, remaining: uidQueue.length });
            } else if (uidQueue.length === 0) {
              self.postMessage({ type: 'done' });
            }
            break;
        }
      };
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    workerRef.current = new Worker(workerUrl);

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      URL.revokeObjectURL(workerUrl);
    };
  }, []);

  // Handle online/offline status
  useEffect(() => {
    const handleOnline = () => {
      if (workerRef.current && isRunning) {
        workerRef.current.postMessage({ type: 'resume' });
      }
    };

    const handleOffline = () => {
      if (workerRef.current && isRunning) {
        workerRef.current.postMessage({ type: 'pause' });
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [isRunning]);

  // Start background caching
  const startBackgroundCaching = useCallback(async () => {
    if (!activeAccountId || !activeMailbox || emails.length === 0) {
      return;
    }

    const account = accounts.find(a => a.id === activeAccountId);
    if (!account || !account.password) {
      console.log('[BackgroundCaching] No account or password, skipping');
      return;
    }

    // Filter emails that aren't already locally saved
    // If localCacheDurationMonths is 0, cache all emails (no date cutoff)
    const emailsToCache = emails.filter(email => {
      if (savedEmailIds.has(email.uid)) return false;

      // If duration is 0, cache all emails
      if (localCacheDurationMonths === 0) return true;

      // Otherwise, only cache emails within the duration
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - localCacheDurationMonths);
      const emailDate = new Date(email.date || email.internalDate);
      return emailDate >= cutoffDate;
    });

    if (emailsToCache.length === 0) {
      console.log('[BackgroundCaching] All recent emails already cached');
      return;
    }

    // Check which emails are already in Maildir
    const uidsToFetch = [];
    for (const email of emailsToCache) {
      const emailExists = await db.isEmailSaved(activeAccountId, activeMailbox, email.uid);
      if (!emailExists) {
        uidsToFetch.push(email.uid);
      }
    }

    if (uidsToFetch.length === 0) {
      console.log('[BackgroundCaching] All recent emails already in Maildir');
      return;
    }

    console.log(`[BackgroundCaching] Starting to cache ${uidsToFetch.length} emails`);
    setIsRunning(true);
    setProgress({ completed: 0, total: uidsToFetch.length });

    // Set up worker message handler
    const handleMessage = async (event) => {
      const { type, uid, remaining } = event.data;

      switch (type) {
        case 'fetchUid':
          try {
            // Fetch full email from server
            const fullEmail = await api.fetchEmail(account, uid, activeMailbox);

            // Save to Maildir
            await db.saveEmail(fullEmail, activeAccountId, activeMailbox);

            // Add to in-memory cache
            const cacheKey = `${activeAccountId}-${activeMailbox}-${uid}`;
            addToCache(cacheKey, fullEmail, cacheLimitMB);

            setProgress(prev => ({
              completed: prev.completed + 1,
              total: prev.total
            }));

            // Small delay then request next
            setTimeout(() => {
              if (workerRef.current) {
                workerRef.current.postMessage({ type: 'nextUid' });
              }
            }, 500);
          } catch (error) {
            console.error(`[BackgroundCaching] Failed to fetch email ${uid}:`, error);
            // Continue with next
            setTimeout(() => {
              if (workerRef.current) {
                workerRef.current.postMessage({ type: 'nextUid' });
              }
            }, 1000);
          }
          break;

        case 'done':
          console.log('[BackgroundCaching] Completed');
          setIsRunning(false);

          // Update savedEmailIds and archivedEmailIds in store
          const newSavedIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);
          const newArchivedIds = await db.getArchivedEmailIds(activeAccountId, activeMailbox);
          const newLocalEmails = await db.getLocalEmails(activeAccountId, activeMailbox);
          useMailStore.setState({ savedEmailIds: newSavedIds, archivedEmailIds: newArchivedIds, localEmails: newLocalEmails });
          useMailStore.getState().updateSortedEmails();
          break;

        case 'ready':
          // Worker is ready, request first UID
          workerRef.current.postMessage({ type: 'nextUid' });
          break;
      }
    };

    workerRef.current.onmessage = handleMessage;

    // Start the worker
    workerRef.current.postMessage({
      type: 'start',
      payload: { uids: uidsToFetch }
    });
  }, [
    activeAccountId,
    activeMailbox,
    emails,
    savedEmailIds,
    localCacheDurationMonths,
    accounts,
    addToCache,
    cacheLimitMB
  ]);

  // Stop caching
  const stopBackgroundCaching = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'stop' });
      setIsRunning(false);
    }
  }, []);

  return {
    startBackgroundCaching,
    stopBackgroundCaching,
    isRunning,
    progress
  };
}
