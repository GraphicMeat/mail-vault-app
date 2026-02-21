import { AccountPipeline } from './AccountPipeline';
import { hasValidCredentials } from './authUtils';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import * as db from './db';

/** Check if an account is hidden in settings */
function isHidden(accountId) {
  return !!useSettingsStore.getState().hiddenAccounts[accountId];
}

/**
 * Singleton coordinator that manages per-account loading pipelines.
 *
 * Cascade order:
 *   1. Active account runs content caching at full concurrency (3)
 *   2. After active finishes → background accounts load headers then cache content (concurrency 1)
 */
class EmailPipelineManager {
  constructor() {
    this.pipelines = new Map(); // accountId → AccountPipeline
    this._activeAccountId = null;
    this._backgroundRunning = false;
  }

  /**
   * Start the content caching pipeline for the active account.
   * Called after loadEmails finishes and UI has stabilized.
   */
  async startActiveAccountPipeline(accountId) {
    const { accounts, activeMailbox, emails, savedEmailIds } = useMailStore.getState();
    const account = accounts.find(a => a.id === accountId);
    if (!account || !hasValidCredentials(account) || isHidden(accountId)) return;

    this._activeAccountId = accountId;

    // Destroy previous pipeline for this account if any
    if (this.pipelines.has(accountId)) {
      this.pipelines.get(accountId).destroy();
    }

    const pipeline = new AccountPipeline(account, {
      concurrency: 3,
      onProgress: (state) => this._onProgress(accountId, state),
      onComplete: () => this._onActiveComplete(accountId),
      onError: (err) => console.warn(`[PipelineManager] Active pipeline error:`, err.message)
    });

    this.pipelines.set(accountId, pipeline);

    // Load Sent folder headers in parallel (for chat view)
    this._loadSentHeaders(account, pipeline);

    // Filter UIDs that need caching
    const { localCacheDurationMonths } = useSettingsStore.getState();
    const uidsToFetch = await this._getUncachedUids(accountId, activeMailbox, emails, savedEmailIds, localCacheDurationMonths);

    if (uidsToFetch.length > 0) {
      await pipeline.startContentCaching(uidsToFetch, activeMailbox);
    } else {
      console.log(`[PipelineManager] Active account fully cached, starting background pipelines`);
      this._startBackgroundPipelines();
    }
  }

  /**
   * Called when the active account's content pipeline finishes.
   * Triggers background loading for all other accounts.
   */
  _onActiveComplete(accountId) {
    // Only cascade if this is still the active account
    if (accountId !== this._activeAccountId) return;
    console.log(`[PipelineManager] Active account ${accountId} complete, starting background pipelines`);
    this._startBackgroundPipelines();
  }

  /**
   * Load headers + cache content for all non-active accounts, sequentially.
   */
  async _startBackgroundPipelines() {
    if (this._backgroundRunning) return;
    this._backgroundRunning = true;

    const { accounts } = useMailStore.getState();
    const otherAccounts = accounts.filter(
      a => a.id !== this._activeAccountId && hasValidCredentials(a) && !isHidden(a.id)
    );

    for (const account of otherAccounts) {
      if (this._isDestroyed(account.id)) continue;

      // Destroy any existing pipeline for this account
      if (this.pipelines.has(account.id)) {
        this.pipelines.get(account.id).destroy();
      }

      const pipeline = new AccountPipeline(account, {
        concurrency: 1, // low priority — single worker
        onProgress: (state) => this._onProgress(account.id, state),
        onComplete: () => console.log(`[PipelineManager] Background account ${account.email} complete`),
        onError: (err) => console.warn(`[PipelineManager] Background pipeline error (${account.email}):`, err.message)
      });

      this.pipelines.set(account.id, pipeline);

      // Phase 1: load headers (INBOX + Sent)
      await pipeline.loadHeaders('INBOX');
      if (pipeline._destroyed) continue;

      await this._loadSentHeaders(account, pipeline);
      if (pipeline._destroyed) continue;

      // Phase 2: cache content
      const { localCacheDurationMonths } = useSettingsStore.getState();
      const cachedHeaders = await db.getEmailHeaders(account.id, 'INBOX');
      if (cachedHeaders?.emails) {
        const savedIds = await db.getSavedEmailIds(account.id, 'INBOX');
        const uids = await this._getUncachedUids(account.id, 'INBOX', cachedHeaders.emails, savedIds, localCacheDurationMonths);
        if (uids.length > 0) {
          const done = pipeline.waitForComplete();
          pipeline.startContentCaching(uids, 'INBOX');
          await done;
        }
      }
    }

    this._backgroundRunning = false;
  }

  /**
   * Handle account switch — pause backgrounds, promote new active.
   */
  onAccountSwitch(newActiveAccountId) {
    this._activeAccountId = newActiveAccountId;
    this._backgroundRunning = false; // allow background cascade to restart for new account context

    // Pause all non-active pipelines
    for (const [id, pipeline] of this.pipelines) {
      if (id !== newActiveAccountId) {
        pipeline.pause();
      }
    }

    // If the new account already has a pipeline running in background, promote it
    if (this.pipelines.has(newActiveAccountId)) {
      const existing = this.pipelines.get(newActiveAccountId);
      existing.concurrency = 3;
      existing.resume('INBOX');
    }
    // Otherwise, startActiveAccountPipeline will be called by the coordinator hook
    // after loadEmails finishes for the new account
  }

  /**
   * Sync pipelines with the current accounts list (handle removals).
   */
  syncAccounts(accounts) {
    const accountIds = new Set(accounts.map(a => a.id));
    for (const [id, pipeline] of this.pipelines) {
      if (!accountIds.has(id)) {
        pipeline.destroy();
        this.pipelines.delete(id);
      }
    }
  }

  /**
   * Pause all pipelines (e.g., on offline).
   */
  pauseAll() {
    for (const pipeline of this.pipelines.values()) {
      pipeline.pause();
    }
  }

  /**
   * Resume all pipelines (e.g., on online).
   */
  resumeAll() {
    for (const pipeline of this.pipelines.values()) {
      pipeline.resume('INBOX');
    }
  }

  /**
   * Restart background pipelines (e.g., after unhiding an account).
   */
  restartBackgroundPipelines() {
    this._backgroundRunning = false;
    this._startBackgroundPipelines();
  }

  /**
   * Destroy all pipelines.
   */
  destroyAll() {
    for (const pipeline of this.pipelines.values()) {
      pipeline.destroy();
    }
    this.pipelines.clear();
    this._backgroundRunning = false;
  }

  /**
   * Get progress for all accounts.
   */
  getProgress() {
    const progress = {};
    for (const [id, pipeline] of this.pipelines) {
      progress[id] = pipeline.state;
    }
    return progress;
  }

  // ── Private helpers ──────────────────────────────────────────────

  _isDestroyed(accountId) {
    const pipeline = this.pipelines.get(accountId);
    return pipeline && pipeline._destroyed;
  }

  _onProgress(accountId, state) {
    // Progress is available via getProgress() — no store write needed
    // The coordinator hook can poll this if UI needs it
  }

  /**
   * Load Sent folder headers for chat view (INBOX + Sent merge).
   * Caches to disk and populates store for the active account.
   */
  async _loadSentHeaders(account, pipeline) {
    const store = useMailStore.getState();
    const sentPath = store.getSentMailboxPath();
    if (!sentPath || pipeline._destroyed) return;

    try {
      // Always refresh Sent headers from IMAP (Sent folder grows as user sends)
      if (pipeline._destroyed) return;
      console.log(`[PipelineManager] Loading Sent headers for ${account.email} (${sentPath})`);
      await pipeline.loadHeaders(sentPath);
      if (pipeline._destroyed) return;

      // Populate store if this is the active account
      if (account.id === this._activeAccountId) {
        useMailStore.getState().loadSentHeaders(account.id);
      }
    } catch (e) {
      console.warn(`[PipelineManager] Sent headers load failed (${account.email}):`, e.message);
    }
  }

  /**
   * Filter emails to only UIDs not yet cached in Maildir.
   */
  async _getUncachedUids(accountId, mailbox, emails, savedEmailIds, localCacheDurationMonths) {
    const cutoffDate = localCacheDurationMonths > 0
      ? new Date(new Date().setMonth(new Date().getMonth() - localCacheDurationMonths))
      : null;

    const candidates = emails.filter(email => {
      if (savedEmailIds.has(email.uid)) return false;
      if (!cutoffDate) return true;
      const emailDate = new Date(email.date || email.internalDate);
      return emailDate >= cutoffDate;
    });

    // Check which are actually on disk (batch check)
    const uids = [];
    for (const email of candidates) {
      const exists = await db.isEmailSaved(accountId, mailbox, email.uid);
      if (!exists) uids.push(email.uid);
    }
    return uids;
  }
}

// Export singleton instance
export const pipelineManager = new EmailPipelineManager();
