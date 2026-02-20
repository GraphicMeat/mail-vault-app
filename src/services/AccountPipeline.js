import * as api from './api';
import * as db from './db';
import { hasValidCredentials, ensureFreshToken } from './authUtils';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';

export { hasValidCredentials };

/**
 * Manages the complete background loading pipeline for a single account:
 *   Phase 1 — load and cache INBOX headers (paginated)
 *   Phase 2 — download email bodies (.eml) with configurable concurrency
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
   * Phase 1: Load all INBOX headers for this account and write to disk cache.
   * Does NOT modify Zustand active-account state — purely warms headers.json.
   */
  async loadHeaders(mailbox = 'INBOX') {
    if (this._destroyed || !hasValidCredentials(this.account)) return;

    this._phase = 'headers';
    this.onProgress(this.state);

    try {
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
        if (hasMore) await new Promise(r => setTimeout(r, 1000));
      }

      if (allEmails.length > 0 && !this._destroyed) {
        await db.saveEmailHeaders(this.accountId, mailbox, allEmails, total);
        console.log(`[Pipeline:${this.account.email}] Cached ${allEmails.length}/${total} headers`);
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

    // Launch concurrent worker slots with 500ms stagger
    for (let i = 0; i < this.concurrency; i++) {
      setTimeout(() => this._workerLoop(i, mailbox), i * 500);
    }
  }

  async _workerLoop(slotIndex, mailbox) {
    this._activeSlots++;

    while (!this._destroyed && !this._paused) {
      const uid = this._queue.shift();
      if (uid === undefined) break; // queue empty, slot goes idle

      try {
        // Ensure OAuth2 token is fresh before each fetch
        const freshAccount = await ensureFreshToken(this.account);
        if (freshAccount !== this.account) this.account = freshAccount;

        // Light fetch: auto-persists .eml to Maildir in Rust, returns metadata only
        const email = await api.fetchEmailLight(freshAccount, uid, mailbox);

        const cacheKey = `${this.accountId}-${mailbox}-${uid}`;
        const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;
        const store = useMailStore.getState();
        store.addToCache(cacheKey, email, cacheLimitMB);

        // Update hasAttachments on the email list item (both emails array and emailsByIndex map)
        if (email?.hasAttachments) {
          useMailStore.setState(state => {
            const newEmailsByIndex = new Map(state.emailsByIndex);
            for (const [idx, e] of newEmailsByIndex) {
              if (e.uid === uid) {
                newEmailsByIndex.set(idx, { ...e, hasAttachments: true });
                break;
              }
            }
            return {
              emails: state.emails.map(e => e.uid === uid ? { ...e, hasAttachments: true } : e),
              emailsByIndex: newEmailsByIndex,
            };
          });
        }

        this._completed++;
        this._retryDelay = 3000; // reset on success
        this.onProgress(this.state);
      } catch (error) {
        console.error(`[Pipeline:${this.account.email}] Failed UID ${uid}:`, error.message || error);
        this._retryQueue.push(uid);
      }

      // Small breathing room between fetches
      await new Promise(r => setTimeout(r, 200));
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
    if (this._destroyed || this._retryQueue.length === 0) return;

    const delay = this._retryDelay;
    console.log(`[Pipeline:${this.account.email}] Retrying ${this._retryQueue.length} failed UIDs in ${delay / 1000}s`);

    this._retryTimer = setTimeout(() => {
      if (this._destroyed) return;
      this._queue = [...this._retryQueue, ...this._queue];
      this._retryQueue = [];
      this._retryDelay = Math.min(delay * 2, 120000);

      for (let i = 0; i < this.concurrency; i++) {
        setTimeout(() => this._workerLoop(i, mailbox), i * 500);
      }
    }, delay);
  }

  async _finish() {
    console.log(`[Pipeline:${this.account.email}] Content caching complete (${this._completed}/${this._total})`);
    this._phase = 'done';

    // Refresh saved/archived IDs for this account if it's the active one
    const { activeAccountId, activeMailbox } = useMailStore.getState();
    if (this.accountId === activeAccountId) {
      try {
        const newSavedIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);
        const newArchivedIds = await db.getArchivedEmailIds(activeAccountId, activeMailbox);
        const newLocalEmails = await db.getLocalEmails(activeAccountId, activeMailbox);
        useMailStore.setState({
          savedEmailIds: newSavedIds,
          archivedEmailIds: newArchivedIds,
          localEmails: newLocalEmails
        });
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
   */
  waitForComplete() {
    return new Promise(resolve => {
      const origComplete = this.onComplete;
      this.onComplete = () => {
        origComplete();
        resolve();
      };
    });
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
        setTimeout(() => this._workerLoop(i, mailbox), i * 500);
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
  }
}
