import * as api from './api';
import * as db from './db';
import { hasValidCredentials, ensureFreshToken } from './authUtils';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { isGraphAccount, GRAPH_FOLDER_NAME_MAP, normalizeGraphFolderName } from './graphConfig';

export { hasValidCredentials };

/**
 * Manages the complete background loading pipeline for a single account:
 *   Phase 1 — load and cache INBOX headers (paginated)
 *   Phase 2 — download email bodies (.eml) with configurable concurrency
 *
 * Supports both IMAP and Graph API transports — Graph accounts are detected
 * via `account.oauth2Transport === 'graph'` and use Graph API equivalents.
 */
export class AccountPipeline {
  constructor(account, options = {}) {
    this.account = account;
    this.accountId = account.id;
    this.concurrency = options.concurrency || 3;
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});

    this._queue = [];
    this._retryQueue = [];
    this._retryTimer = null;
    this._retryDelay = 3000;
    this._activeSlots = 0;
    this._completed = 0;
    this._total = 0;
    this._phase = 'idle'; // 'idle' | 'headers' | 'content' | 'done'
    this._destroyed = false;
    this._paused = false;
    this._lastLoadedEmails = null; // Cache loaded headers in memory for content caching phase
    this._graphIdMap = null; // Map<uid, graphMessageId> for Graph content caching
  }

  get state() {
    return {
      phase: this._phase,
      queued: this._queue.length,
      completed: this._completed,
      total: this._total,
      failed: this._retryQueue.length,
      isRunning: this._phase === 'headers' || this._phase === 'content'
    };
  }

  /**
   * Phase 1: Load all headers for this account and write to disk cache.
   * Does NOT modify Zustand active-account state — purely warms headers.json.
   * Supports both IMAP (paginated fetch) and Graph API (skip-based pagination).
   */
  async loadHeaders(mailbox = 'INBOX') {
    if (this._destroyed || !hasValidCredentials(this.account)) return;

    this._phase = 'headers';
    this.onProgress(this.state);

    try {
      if (isGraphAccount(this.account)) {
        await this._loadHeadersGraph(mailbox);
      } else {
        await this._loadHeadersImap(mailbox);
      }
    } catch (e) {
      console.warn(`[Pipeline:${this.account.email}] Header load failed:`, e.message);
      this.onError(e);
    }

    if (!this._destroyed) {
      this._phase = 'idle';
      this.onProgress(this.state);
    }
  }

  /** IMAP header loading — paginated via fetchEmails */
  async _loadHeadersImap(mailbox) {
    console.log(`[Pipeline:${this.account.email}] Loading headers for ${mailbox}...`);
    const allEmails = [];
    let page = 1;
    let hasMore = true;
    let total = 0;

    while (hasMore && !this._destroyed && !this._paused) {
      this.account = await ensureFreshToken(this.account);
      const result = await api.fetchEmails(this.account, mailbox, page);
      allEmails.push(...result.emails);
      total = result.total;
      hasMore = result.hasMore;
      page++;
      if (hasMore) await new Promise(r => setTimeout(r, 0));
    }

    if (allEmails.length > 0 && !this._destroyed) {
      await db.saveEmailHeaders(this.accountId, mailbox, allEmails, total);
      this._lastLoadedEmails = allEmails;
      console.log(`[Pipeline:${this.account.email}] Cached ${allEmails.length}/${total} headers`);
    }
  }

  /** Graph API header loading — uses graphListFolders + graphListMessages with skip pagination */
  async _loadHeadersGraph(mailbox) {
    console.log(`[Pipeline:${this.account.email}] Loading Graph headers for ${mailbox}...`);

    this.account = await ensureFreshToken(this.account);
    const token = this.account.oauth2AccessToken;

    // 1. Fetch folder list to find the Graph folder ID
    const graphFolders = await api.graphListFolders(token);
    const targetFolder = graphFolders.find(
      f => normalizeGraphFolderName(f.displayName) === mailbox
    );

    if (!targetFolder) {
      console.warn(`[Pipeline:${this.account.email}] No Graph folder matching "${mailbox}"`);
      return;
    }

    // 2. Paginate through all messages
    const allHeaders = [];
    const allGraphIds = [];
    const PAGE_SIZE = 200;
    let skip = 0;
    let hasMore = true;

    while (hasMore && !this._destroyed && !this._paused) {
      this.account = await ensureFreshToken(this.account);
      const result = await api.graphListMessages(
        this.account.oauth2AccessToken, targetFolder.id, PAGE_SIZE, skip
      );

      const headers = result.headers || [];
      const graphMessageIds = result.graphMessageIds || [];
      allHeaders.push(...headers);
      allGraphIds.push(...graphMessageIds);

      hasMore = !!result.nextLink && headers.length === PAGE_SIZE;
      skip += headers.length;

      if (hasMore) await new Promise(r => setTimeout(r, 0));
    }

    if (allHeaders.length > 0 && !this._destroyed) {
      await db.saveEmailHeaders(this.accountId, mailbox, allHeaders, allHeaders.length);
      this._lastLoadedEmails = allHeaders;

      // Build UID → Graph message ID mapping for content caching phase
      const idMap = new Map();
      allHeaders.forEach((h, i) => {
        if (allGraphIds[i]) idMap.set(h.uid, allGraphIds[i]);
      });
      this._graphIdMap = idMap;

      console.log(`[Pipeline:${this.account.email}] Cached ${allHeaders.length} Graph headers for ${mailbox}`);
    }
  }

  /**
   * Phase 2: Cache email bodies with concurrent workers.
   * @param {number[]} uids - UIDs to download
   * @param {string} mailbox - Mailbox name (default 'INBOX')
   */
  async startContentCaching(uids, mailbox = 'INBOX') {
    if (this._destroyed || uids.length === 0) {
      this.onComplete();
      return;
    }

    this._phase = 'content';
    this._queue = [...uids];
    this._retryQueue = [];
    this._retryDelay = 3000;
    this._completed = 0;
    this._total = uids.length;
    this._activeSlots = 0;
    if (this._retryTimer) clearTimeout(this._retryTimer);

    console.log(`[Pipeline:${this.account.email}] Starting content caching: ${uids.length} emails, concurrency=${this.concurrency}`);
    this.onProgress(this.state);

    // Launch concurrent worker slots with 100ms stagger
    for (let i = 0; i < this.concurrency; i++) {
      setTimeout(() => this._workerLoop(i, mailbox), i * 100);
    }
  }

  async _workerLoop(slotIndex, mailbox) {
    this._activeSlots++;

    // Ensure OAuth2 token is fresh once before the loop starts
    try {
      const freshAccount = await ensureFreshToken(this.account);
      if (freshAccount !== this.account) this.account = freshAccount;
    } catch (e) {
      console.warn(`[Pipeline:${this.account.email}] Token refresh failed before worker loop:`, e.message);
    }

    const isGraph = isGraphAccount(this.account);

    while (!this._destroyed && !this._paused) {
      const uid = this._queue.shift();
      if (uid === undefined) break; // queue empty, slot goes idle

      try {
        let email;

        if (isGraph) {
          // Graph API: fetch MIME, cache to Maildir, return parsed email
          const graphId = this._graphIdMap?.get(uid);
          if (!graphId) {
            console.warn(`[Pipeline:${this.account.email}] No Graph ID for UID ${uid}, skipping`);
            this._completed++;
            this.onProgress(this.state);
            continue;
          }
          email = await api.graphCacheMime(
            this.account.oauth2AccessToken, graphId, this.accountId, mailbox, uid
          );
        } else {
          // IMAP: light fetch auto-persists .eml to Maildir in Rust, returns metadata only
          email = await api.fetchEmailLight(this.account, uid, mailbox, this.accountId);
        }

        const cacheKey = `${this.accountId}-${mailbox}-${uid}`;
        const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;
        const store = useMailStore.getState();
        store.addToCache(cacheKey, email, cacheLimitMB);

        // Update hasAttachments on the email list item — mutate in place to avoid
        // creating a new emails array (which would trigger expensive re-renders)
        if (email?.hasAttachments) {
          const state = useMailStore.getState();
          const target = state.emails.find(e => e.uid === uid);
          if (target) target.hasAttachments = true;
          for (const [, e] of state.emailsByIndex) {
            if (e.uid === uid) { e.hasAttachments = true; break; }
          }
        }

        this._completed++;
        this._retryDelay = 3000; // reset on success
        this.onProgress(this.state);
      } catch (error) {
        console.error(`[Pipeline:${this.account.email}] Failed UID ${uid}:`, error.message || error);
        // Re-refresh token on auth errors before retrying
        const msg = String(error.message || error).toLowerCase();
        if (msg.includes('auth') || msg.includes('token') || msg.includes('expired')) {
          try {
            const freshAccount = await ensureFreshToken(this.account);
            if (freshAccount !== this.account) this.account = freshAccount;
          } catch (_) {}
        }
        this._retryQueue.push(uid);
      }

      // Small breathing room between fetches (yield to event loop)
      await new Promise(r => setTimeout(r, 10));
    }

    this._activeSlots--;

    // Last slot to finish checks if we need retries or are done
    if (this._activeSlots === 0 && !this._destroyed) {
      if (this._queue.length === 0 && this._retryQueue.length > 0) {
        this._scheduleRetry(mailbox);
      } else if (this._queue.length === 0 && this._retryQueue.length === 0) {
        this._finish();
      }
    }
  }

  _scheduleRetry(mailbox) {
    if (this._destroyed || this._retryQueue.length === 0 || this._retryTimer) return;

    const delay = this._retryDelay;
    console.log(`[Pipeline:${this.account.email}] Retrying ${this._retryQueue.length} failed UIDs in ${delay / 1000}s`);

    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this._destroyed || this._activeSlots > 0) return;
      this._queue = [...this._retryQueue, ...this._queue];
      this._retryQueue = [];
      this._retryDelay = Math.min(delay * 2, 120000);

      for (let i = 0; i < this.concurrency; i++) {
        setTimeout(() => this._workerLoop(i, mailbox), i * 100);
      }
    }, delay);
  }

  async _finish() {
    console.log(`[Pipeline:${this.account.email}] Content caching complete (${this._completed}/${this._total})`);
    this._phase = 'done';
    this._lastLoadedEmails = null; // Free header data — no longer needed
    this._graphIdMap = null;

    // Refresh saved/archived IDs for this account if it's the active one
    const { activeAccountId, activeMailbox } = useMailStore.getState();
    if (this.accountId === activeAccountId) {
      try {
        const [newSavedIds, newArchivedIds] = await Promise.all([
          db.getSavedEmailIds(activeAccountId, activeMailbox),
          db.getArchivedEmailIds(activeAccountId, activeMailbox),
        ]);
        useMailStore.setState({
          savedEmailIds: newSavedIds,
          archivedEmailIds: newArchivedIds,
        });
        // Refresh archived emails from disk (async Rust, won't freeze UI)
        if (newArchivedIds.size > 0) {
          db.getArchivedEmails(activeAccountId, activeMailbox, newArchivedIds, (batchEmails) => {
            const current = useMailStore.getState();
            if (current.activeAccountId !== activeAccountId) return;
            useMailStore.setState({ localEmails: batchEmails });
            useMailStore.getState().updateSortedEmails();
          }).catch(() => {});
        }
        useMailStore.getState().updateSortedEmails();

        // Persist updated hasAttachments values to headers cache
        const { emails, totalEmails } = useMailStore.getState();
        db.saveEmailHeaders(activeAccountId, activeMailbox, emails, totalEmails)
          .catch(e => console.warn(`[Pipeline:${this.account.email}] Failed to save updated headers:`, e));
      } catch (e) {
        console.warn(`[Pipeline:${this.account.email}] Failed to refresh saved IDs:`, e);
      }
    }

    this.onProgress(this.state);
    this.onComplete();
  }

  /**
   * Returns a promise that resolves when the current content caching run completes.
   * Also resolves if the pipeline is destroyed before completion.
   * Idempotent: returns the same promise if called multiple times.
   */
  waitForComplete() {
    // Already finished, idle, or destroyed — resolve immediately
    if (this._phase === 'idle' || this._phase === 'done' || this._destroyed) return Promise.resolve();
    // Reuse existing wait promise if one exists
    if (this._waitPromise) return this._waitPromise;

    this._waitPromise = new Promise(resolve => {
      this._waitResolve = resolve;
      const origComplete = this.onComplete;
      this.onComplete = () => {
        this._waitResolve = null;
        this._waitPromise = null;
        origComplete();
        resolve();
      };
    });
    return this._waitPromise;
  }

  pause() {
    this._paused = true;
  }

  resume(mailbox = 'INBOX') {
    if (!this._paused) return;
    this._paused = false;

    // Re-launch idle slots if we have work to do
    if (this._phase === 'content' && this._queue.length > 0) {
      const slotsToLaunch = Math.min(this.concurrency - this._activeSlots, this._queue.length);
      for (let i = 0; i < slotsToLaunch; i++) {
        setTimeout(() => this._workerLoop(i, mailbox), i * 100);
      }
    }
  }

  destroy() {
    this._destroyed = true;
    this._queue = [];
    this._retryQueue = [];
    // Do NOT reset _activeSlots — let in-flight workers drain naturally.
    // Workers check _destroyed and exit cleanly on their own.
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._phase = 'idle';
    this._graphIdMap = null;
    // Resolve any pending waitForComplete() promise so callers don't hang forever
    if (this._waitResolve) {
      this._waitResolve();
      this._waitResolve = null;
      this._waitPromise = null;
    }
  }
}
