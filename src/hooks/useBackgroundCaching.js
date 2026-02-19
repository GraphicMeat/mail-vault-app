import { useEffect, useRef, useCallback, useState } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import * as db from '../services/db';
import * as api from '../services/api';

export function useBackgroundCaching() {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const queueRef = useRef([]);
  const retryQueueRef = useRef([]); // UIDs that failed, waiting to retry
  const retryTimerRef = useRef(null);
  const retryDelayRef = useRef(3000); // starts at 3s, grows exponentially
  const stoppedRef = useRef(false);
  const pausedRef = useRef(false);
  const processingRef = useRef(false);

  const {
    activeAccountId,
    activeMailbox,
    emails,
    savedEmailIds,
    addToCache,
    accounts
  } = useMailStore();

  const { localCacheDurationMonths, cacheLimitMB } = useSettingsStore();

  // Handle online/offline status
  useEffect(() => {
    const handleOnline = () => {
      if (pausedRef.current && isRunning) {
        pausedRef.current = false;
        processNext();
      }
    };

    const handleOffline = () => {
      if (isRunning) {
        pausedRef.current = true;
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [isRunning]);

  // Schedule retry of failed UIDs with exponential backoff
  const scheduleRetry = useCallback(() => {
    if (stoppedRef.current || retryQueueRef.current.length === 0) return;

    const delay = retryDelayRef.current;
    console.log(`[BackgroundCaching] Scheduling retry of ${retryQueueRef.current.length} failed UIDs in ${delay / 1000}s`);

    retryTimerRef.current = setTimeout(() => {
      if (stoppedRef.current) return;
      // Move retry queue back to main queue
      queueRef.current = [...retryQueueRef.current, ...queueRef.current];
      retryQueueRef.current = [];
      // Grow delay: 3s → 9s → 18s → 36s → 72s → 120s cap
      retryDelayRef.current = Math.min(delay * 2, 120000);
      processNext();
    }, delay);
  }, []);

  // Process next UID in queue
  const processNext = useCallback(() => {
    if (stoppedRef.current || pausedRef.current || processingRef.current) return;
    if (queueRef.current.length === 0) {
      // Main queue empty — check if there are failed UIDs to retry
      if (retryQueueRef.current.length > 0) {
        scheduleRetry();
        return;
      }
      // All done
      console.log('[BackgroundCaching] Completed');
      setIsRunning(false);

      (async () => {
        const accountId = useMailStore.getState().activeAccountId;
        const mailbox = useMailStore.getState().activeMailbox;
        const newSavedIds = await db.getSavedEmailIds(accountId, mailbox);
        const newArchivedIds = await db.getArchivedEmailIds(accountId, mailbox);
        const newLocalEmails = await db.getLocalEmails(accountId, mailbox);
        useMailStore.setState({ savedEmailIds: newSavedIds, archivedEmailIds: newArchivedIds, localEmails: newLocalEmails });
        useMailStore.getState().updateSortedEmails();
      })();
      return;
    }

    processingRef.current = true;
    const uid = queueRef.current.shift();
    const account = useMailStore.getState().accounts.find(a => a.id === useMailStore.getState().activeAccountId);
    const mailbox = useMailStore.getState().activeMailbox;
    const accountId = useMailStore.getState().activeAccountId;

    (async () => {
      try {
        const fullEmail = await api.fetchEmail(account, uid, mailbox);
        await db.saveEmail(fullEmail, accountId, mailbox);

        const cacheKey = `${accountId}-${mailbox}-${uid}`;
        useMailStore.getState().addToCache(cacheKey, fullEmail, useSettingsStore.getState().cacheLimitMB);

        setProgress(prev => ({
          completed: prev.completed + 1,
          total: prev.total
        }));

        // Success — reset retry delay since connection is healthy
        retryDelayRef.current = 3000;
        processingRef.current = false;
        setTimeout(() => processNext(), 500);
      } catch (error) {
        console.error(`[BackgroundCaching] Failed to fetch email ${uid}, queued for retry:`, error.message || error);
        retryQueueRef.current.push(uid);
        processingRef.current = false;
        // Continue processing remaining main queue items before retrying failed ones
        setTimeout(() => processNext(), 1000);
      }
    })();
  }, []);

  // Start background caching
  const startBackgroundCaching = useCallback(async () => {
    if (!activeAccountId || !activeMailbox || emails.length === 0) {
      return;
    }

    const account = accounts.find(a => a.id === activeAccountId);
    const hasCredentials = account && (account.password || (account.authType === 'oauth2' && account.oauth2AccessToken));
    if (!hasCredentials) {
      console.log('[BackgroundCaching] No account or credentials, skipping');
      return;
    }

    // Filter emails that aren't already locally saved
    const emailsToCache = emails.filter(email => {
      if (savedEmailIds.has(email.uid)) return false;
      if (localCacheDurationMonths === 0) return true;

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
    stoppedRef.current = false;
    pausedRef.current = false;
    processingRef.current = false;
    queueRef.current = [...uidsToFetch];
    retryQueueRef.current = [];
    retryDelayRef.current = 3000;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    setIsRunning(true);
    setProgress({ completed: 0, total: uidsToFetch.length });

    // Kick off processing
    processNext();
  }, [
    activeAccountId,
    activeMailbox,
    emails,
    savedEmailIds,
    localCacheDurationMonths,
    accounts,
    processNext
  ]);

  // Stop caching
  const stopBackgroundCaching = useCallback(() => {
    stoppedRef.current = true;
    queueRef.current = [];
    retryQueueRef.current = [];
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryDelayRef.current = 3000;
    setIsRunning(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stoppedRef.current = true;
      queueRef.current = [];
      retryQueueRef.current = [];
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  return {
    startBackgroundCaching,
    stopBackgroundCaching,
    isRunning,
    progress
  };
}
