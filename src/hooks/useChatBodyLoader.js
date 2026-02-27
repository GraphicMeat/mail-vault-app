import { useEffect, useRef, useCallback, useState } from 'react';
import { useMailStore, getGraphMessageId, graphMessageToEmail } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import * as db from '../services/db';
import * as api from '../services/api';
import { ensureFreshToken } from '../services/authUtils';

const CONCURRENCY = 3;

/** Unique key for an email across mailboxes (UIDs are per-mailbox) */
export const emailKey = (email) => email._fromSentFolder ? `sent-${email.uid}` : `${email.uid}`;

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
      const accountId = store.activeAccountId;
      const inboxMailbox = store.activeMailbox;
      const sentMailbox = store.getSentMailboxPath();
      for (const email of topicEmails) {
        const key = emailKey(email);
        const mailbox = email._fromSentFolder && sentMailbox ? sentMailbox : inboxMailbox;
        const cacheKey = `${accountId}-${mailbox}-${email.uid}`;
        const cached = store.getFromCache(cacheKey);
        if (cached) {
          bodiesMapRef.current.set(key, { status: 'loaded', email: cached });
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
    const account = store.accounts.find(a => a.id === store.activeAccountId);
    const accountId = store.activeAccountId;
    const inboxMailbox = store.activeMailbox;
    const sentMailbox = store.getSentMailboxPath();

    // Helper: resolve the correct mailbox for an email
    const getMailbox = (email) => email._fromSentFolder && sentMailbox ? sentMailbox : inboxMailbox;

    // Collect emails still needing fetch — newest first so the latest messages load first
    const pendingEmails = topicEmails
      .filter(e => bodiesMap.get(emailKey(e))?.status === 'loading')
      .reverse();

    if (pendingEmails.length === 0) return;

    let activeCount = 0;
    let queueIndex = 0;

    const fetchOne = async (email) => {
      if (cancelled) return;
      const key = emailKey(email);
      const uid = email.uid;
      const mailbox = getMailbox(email);
      const cacheKey = `${accountId}-${mailbox}-${uid}`;

      try {
        let freshAccount = account;
        if (freshAccount) {
          try { freshAccount = await ensureFreshToken(freshAccount); } catch (_) {}
        }

        // 1. Check Maildir .eml (fast disk read)
        let emailBody = await db.getLocalEmailLight(accountId, mailbox, uid);

        // 2. Fetch from server if not on disk
        if (!emailBody && freshAccount) {
          if (freshAccount.oauth2Transport === 'graph') {
            // Graph API: fast JSON fetch for display, background MIME cache for disk
            const graphId = getGraphMessageId(accountId, mailbox, uid);
            if (graphId) {
              const graphMsg = await api.graphGetMessage(freshAccount.oauth2AccessToken, graphId);
              emailBody = graphMessageToEmail(graphMsg, uid);
              // Background: save .eml to disk for offline access
              api.graphCacheMime(freshAccount.oauth2AccessToken, graphId, accountId, mailbox, uid)
                .catch(() => {});
            }
          } else {
            emailBody = await api.fetchEmailLight(freshAccount, uid, mailbox);
          }
        }

        if (cancelled) return;

        if (emailBody) {
          store.addToCache(cacheKey, emailBody, cacheLimitMB);
          bodiesMap.set(key, { status: 'loaded', email: emailBody });
        } else {
          bodiesMap.set(key, { status: 'error', email: null });
        }
      } catch (err) {
        console.warn(`[useChatBodyLoader] Failed to load UID ${uid}:`, err);
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
