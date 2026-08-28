import { useEffect, useRef, useCallback, useState } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { resolveMessageBody } from '../services/export/bodyResolver';
import { resolveEmailLocation, emailKey } from '../stores/slices/unifiedHelpers';

const CONCURRENCY = 3;

// Re-exported for the views that key their body listeners with it.
export { emailKey };

/**
 * Progressively loads email bodies for a list of header-only emails.
 * Reads from / writes to the store's emailCache (same LRU cache used everywhere).
 * Concurrency is capped at 3 to match the active pipeline's concurrency.
 *
 * Each MessageBubble registers a per-uid listener via registerListener().
 * When a body loads, only that bubble re-renders — not the entire list.
 *
 * @param {Array} topicEmails - header-only email objects from topic.emails
 * @returns {{ bodiesMapRef: React.RefObject<Map>, registerListener: Function }}
 */
export function useChatBodyLoader(topicEmails) {
  // bodiesMap: Map<uid, { status: 'loading'|'loaded'|'error', email: object|null }>
  const bodiesMapRef = useRef(new Map());
  // Per-uid listener callbacks from individual MessageBubble components
  const listenersRef = useRef(new Map());

  const notifyBubble = useCallback((key) => {
    const listener = listenersRef.current.get(key);
    if (listener) listener();
  }, []);

  const registerListener = useCallback((key, fn) => {
    listenersRef.current.set(key, fn);
    return () => listenersRef.current.delete(key);
  }, []);

  // Build a stable dependency key from the topic's emails
  const uidsKey = topicEmails?.map(e => emailKey(e)).join(',') || '';

  // ── Synchronous pre-population (runs during render, before any child reads) ──
  // This fixes the race condition where ThreadEmailItem reads bodiesMapRef
  // during render but useEffect hasn't populated it yet.
  const prevUidsKeyRef = useRef('');
  if (uidsKey !== prevUidsKeyRef.current) {
    prevUidsKeyRef.current = uidsKey;
    bodiesMapRef.current.clear();
    if (topicEmails && topicEmails.length > 0) {
      const store = useMailStore.getState();
      for (const email of topicEmails) {
        const key = emailKey(email);
        const loc = resolveEmailLocation(email, store);
        if (!loc) {
          // Location unknown — reading a UID out of a guessed mailbox returns
          // a different message, so show nothing instead.
          bodiesMapRef.current.set(key, { status: 'error', email: null });
          continue;
        }
        const cached = store.getFromCache(`${loc.accountId}-${loc.mailbox}-${email.uid}`);
        if (cached && bodyMatchesHeader(email, cached)) {
          // The body answers for the header it was loaded for: keep that
          // header's account on it, so replying to it leaves from there.
          bodiesMapRef.current.set(key, { status: 'loaded', email: { ...cached, _accountId: loc.accountId } });
        } else {
          bodiesMapRef.current.set(key, { status: 'loading', email: null });
        }
      }
    }
  }

  useEffect(() => {
    if (!topicEmails || topicEmails.length === 0) return;

    let cancelled = false;
    const bodiesMap = bodiesMapRef.current;

    const store = useMailStore.getState();
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;

    // Collect emails still needing fetch — newest first so the latest messages load first
    const pendingEmails = topicEmails
      .filter(e => bodiesMap.get(emailKey(e))?.status === 'loading')
      .reverse();

    if (pendingEmails.length === 0) return;

    let activeCount = 0;
    let queueIndex = 0;

    const MAX_RETRIES = 2;

    const fetchOne = async (email, retryCount = 0) => {
      if (cancelled) return;
      const key = emailKey(email);
      const uid = email.uid;
      const loc = resolveEmailLocation(email, store);
      if (!loc) {
        bodiesMap.set(key, { status: 'error', email: null });
        notifyBubble(key);
        return;
      }
      const { accountId: resolvedAccountId, mailbox: resolvedMailbox } = loc;
      const cacheKey = `${resolvedAccountId}-${resolvedMailbox}-${uid}`;

      try {
        // The vault-then-server sequence, with its custody guards, lives in
        // resolveMessageBody so the export resolves a body exactly the way the
        // reading pane does. What stays here is what is the hook's: capped
        // concurrency, retry, and the per-bubble notify.
        const resolved = await resolveMessageBody(email, store);

        if (cancelled) return;

        // A body whose Message-ID contradicts the header is the server's own
        // answer for this uid, so a retry only asks the same question again.
        if (!resolved.ok && /mismatch/i.test(resolved.reason || '')) {
          console.warn('[useChatBodyLoader] Body/header Message-ID mismatch — discarding', {
            uid, mailbox: resolvedMailbox, account: resolvedAccountId,
          });
          retryCount = MAX_RETRIES;
        }

        if (resolved.ok) {
          // The cached entry now carries _accountId. It is a superset of what
          // was cached before and every reader spreads it, so nothing reads a
          // field that changed meaning.
          store.addToCache(cacheKey, resolved.email, cacheLimitMB);
          bodiesMap.set(key, { status: 'loaded', email: resolved.email });
        } else if (retryCount < MAX_RETRIES) {
          // Retry after a short delay
          await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
          if (!cancelled) return fetchOne(email, retryCount + 1);
        } else {
          bodiesMap.set(key, { status: 'error', email: null });
        }
      } catch (err) {
        console.warn(`[useChatBodyLoader] Failed to load UID ${uid} (attempt ${retryCount + 1}):`, err);
        if (!cancelled && retryCount < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
          if (!cancelled) return fetchOne(email, retryCount + 1);
        }
        if (!cancelled) {
          bodiesMap.set(key, { status: 'error', email: null });
        }
      }

      if (!cancelled) notifyBubble(key);
    };

    const pump = () => {
      while (queueIndex < pendingEmails.length && !cancelled && activeCount < CONCURRENCY) {
        const email = pendingEmails[queueIndex++];
        activeCount++;
        fetchOne(email).finally(() => {
          activeCount--;
          if (!cancelled) pump();
        });
      }
    };

    pump();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uidsKey]);

  return { bodiesMapRef, registerListener };
}
