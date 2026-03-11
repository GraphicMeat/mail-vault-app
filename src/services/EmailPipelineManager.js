import { AccountPipeline } from './AccountPipeline';
import { hasValidCredentials } from './authUtils';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import * as db from './db';
import { GRAPH_FOLDER_NAME_MAP, normalizeGraphFolderName as _normalizeGraphFolderName } from './graphConfig';

/** Check if an account is hidden in settings */
function isHidden(accountId) {
  return !!useSettingsStore.getState().hiddenAccounts[accountId];
}

/**
 * Singleton coordinator that manages per-account loading pipelines.
 *
 * Cascade order:
 *   1. Active account runs content caching at full concurrency (3)
 *   2. Background accounts load headers immediately in parallel (concurrency 1 per account)
 *   3. After active finishes → background accounts cache content (sequential, concurrency 1)
 */
class EmailPipelineManager {
  constructor() {
    this.pipelines = new Map(); // accountId → AccountPipeline
    this._activeAccountId = null;
    this._backgroundHeadersRunning = false;
    this._backgroundContentRunning = false;
    this._destroyed = false;
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
    this._destroyed = false; // Reset so background pipelines can run after destroyAll()

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

    // Start background headers immediately (don't wait for active to finish)
    this._startBackgroundHeadersOnly();

    // Filter UIDs that need caching
    const { localCacheDurationMonths } = useSettingsStore.getState();
    const uidsToFetch = this._getUncachedUids(emails, savedEmailIds, localCacheDurationMonths);

    if (uidsToFetch.length > 0) {
      await pipeline.startContentCaching(uidsToFetch, activeMailbox);
    } else {
      console.log(`[PipelineManager] Active account fully cached, starting background content pipelines`);
      this._startBackgroundContentPipelines();
    }
  }

  /**
   * Called when the active account's content pipeline finishes.
   * Triggers background content caching for all other accounts.
   */
  _onActiveComplete(accountId) {
    // Only cascade if this is still the active account
    if (accountId !== this._activeAccountId) return;
    console.log(`[PipelineManager] Active account ${accountId} complete, starting background content pipelines`);
    this._startBackgroundContentPipelines();
  }

  /**
   * Load headers for all non-active accounts immediately.
   * Runs in parallel alongside active account content caching.
   * Also pre-fetches and caches mailbox lists for instant account switching.
   */
  async _startBackgroundHeadersOnly() {
    if (this._backgroundHeadersRunning) return;
    this._backgroundHeadersRunning = true;

    const { accounts } = useMailStore.getState();
    const otherAccounts = accounts.filter(
      a => a.id !== this._activeAccountId && hasValidCredentials(a) && !isHidden(a.id)
    );

    const CHUNK_SIZE = 3;
    for (let i = 0; i < otherAccounts.length; i += CHUNK_SIZE) {
      if (this._destroyed) break;
      const chunk = otherAccounts.slice(i, i + CHUNK_SIZE);

      await Promise.all(chunk.map(async (account) => {
        if (this._destroyed) return;

        // Destroy any existing pipeline for this account
        if (this.pipelines.has(account.id)) {
          this.pipelines.get(account.id).destroy();
        }

        const pipeline = new AccountPipeline(account, {
          concurrency: 1,
          onProgress: (state) => this._onProgress(account.id, state),
          onComplete: () => console.log(`[PipelineManager] Background account ${account.email} headers complete`),
          onError: (err) => console.warn(`[PipelineManager] Background pipeline error (${account.email}):`, err.message)
        });

        this.pipelines.set(account.id, pipeline);

        // Load headers (INBOX + Sent)
        await pipeline.loadHeaders('INBOX');
        if (!pipeline._destroyed) {
          await this._loadSentHeaders(account, pipeline);
        }

        // Pre-fetch mailbox list for instant account switching
        if (!pipeline._destroyed) {
          try {
            const freshAccount = await import('./authUtils').then(m => m.ensureFreshToken(account));
            const apiMod = await import('./api');
            let mailboxes;
            if (freshAccount.oauth2Transport === 'graph') {
              // Graph API: fetch folders and convert to app's mailbox format
              const graphFolders = await apiMod.graphListFolders(freshAccount.oauth2AccessToken);
              mailboxes = graphFolders.map(f => ({
                name: _normalizeGraphFolderName(f.displayName),
                path: _normalizeGraphFolderName(f.displayName),
                flags: [],
                delimiter: '/',
                noselect: false,
                children: [],
              }));
            } else {
              mailboxes = await apiMod.fetchMailboxes(freshAccount);
            }
            await db.saveMailboxes(account.id, mailboxes);
          } catch (e) {
            // Non-fatal: cached mailboxes from last connection will be used
          }
        }
      }));
    }

    this._backgroundHeadersRunning = false;
  }

  /**
   * Cache content for all non-active accounts.
   * Runs after active account content caching completes.
   * Sequential at concurrency=1 to avoid overwhelming IMAP.
   */
  async _startBackgroundContentPipelines() {
    if (this._backgroundContentRunning) return;
    this._backgroundContentRunning = true;

    const { accounts } = useMailStore.getState();
    const otherAccounts = accounts.filter(
      a => a.id !== this._activeAccountId && hasValidCredentials(a) && !isHidden(a.id)
    );

    for (const account of otherAccounts) {
      if (this._destroyed) break;

      const pipeline = this.pipelines.get(account.id);
      if (!pipeline || pipeline._destroyed) continue;

      const { localCacheDurationMonths } = useSettingsStore.getState();
      // Use in-memory headers from header loading phase (avoids re-reading from disk)
      const emails = pipeline._lastLoadedEmails;
      if (emails && emails.length > 0) {
        const savedIds = await db.getSavedEmailIds(account.id, 'INBOX');
        const uids = this._getUncachedUids(emails, savedIds, localCacheDurationMonths);
        if (uids.length > 0) {
          // Start caching first, THEN await completion — avoids race where
          // synchronous onComplete fires before waitForComplete sets up its promise
          pipeline.startContentCaching(uids, 'INBOX');
          await pipeline.waitForComplete();
        }
      }
    }

    this._backgroundContentRunning = false;
  }

  /**
   * Handle account switch — pause backgrounds, promote new active.
   */
  onAccountSwitch(newActiveAccountId) {
    this._activeAccountId = newActiveAccountId;
    this._backgroundContentRunning = false; // allow background cascade to restart for new account context

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
    this._backgroundHeadersRunning = false;
    this._backgroundContentRunning = false;
    this._startBackgroundHeadersOnly();
  }

  /**
   * Destroy all pipelines.
   */
  destroyAll() {
    this._destroyed = true;
    for (const pipeline of this.pipelines.values()) {
      pipeline.destroy();
    }
    this.pipelines.clear();
    this._backgroundHeadersRunning = false;
    this._backgroundContentRunning = false;
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
   * Uses the pre-loaded savedEmailIds Set for O(1) lookups instead of per-UID IPC calls.
   */
  _getUncachedUids(emails, savedEmailIds, localCacheDurationMonths) {
    const cutoffDate = localCacheDurationMonths > 0
      ? new Date(new Date().setMonth(new Date().getMonth() - localCacheDurationMonths))
      : null;

    return emails
      .filter(email => {
        if (savedEmailIds.has(email.uid)) return false;
        if (!cutoffDate) return true;
        const emailDate = new Date(email.date || email.internalDate);
        return emailDate >= cutoffDate;
      })
      .map(email => email.uid);
  }
}

// Export singleton instance
export const pipelineManager = new EmailPipelineManager();
