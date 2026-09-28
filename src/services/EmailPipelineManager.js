import { AccountPipeline } from './AccountPipeline';
import { hasValidCredentials } from './authUtils';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import * as db from './db';
import { graphFoldersToMailboxes, isGraphAccount } from './graphConfig';
import { adoptGraphFolderKeysFromListing } from './workflows/adoptGraphFolderKeys';
import { waitForSentMailboxPath, findSentMailboxPath, mergesSentIntoThreads } from '../utils/sentFolder';
import { fetchPolicy, keepsBody } from '../utils/fetchPolicy';

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
    // Accounts whose background content cascade already finished this launch.
    // Without this the cascade restarts from the first account on every switch
    // and re-walks every other account's bodies.
    this._contentCascadeDone = new Set();
    this._destroyed = false;
  }

  /**
   * Start the content caching pipeline for the active account.
   * Called after loadEmails finishes and UI has stabilized.
   */
  async startActiveAccountPipeline(accountId) {
    const { accounts, activeMailbox, mailboxScope, emails, savedEmailIds } = useMailStore.getState();
    const account = accounts.find(a => a.id === accountId);
    if (!account || !hasValidCredentials(account) || isHidden(accountId)) return;

    this._activeAccountId = accountId;
    this._destroyed = false; // Reset so background pipelines can run after destroyAll()

    // ── What this pipeline is actually allowed to fetch ──
    //
    // In All Inboxes the list spans accounts AND folders, and both of the
    // values below were read straight off the store:
    //   - `emails` holds EVERY account's rows, so this account's pipeline was
    //     handed other accounts' uids — a uid names a message only inside one
    //     (account, mailbox).
    //   - `activeMailbox` is the literal 'UNIFIED', which no server can SELECT.
    //     Every body fetch died on `SELECT UNIFIED … [NONEXISTENT]`, so nothing
    //     was cached in that view at all and each refused uid went back on the
    //     retry queue for the life of the session.
    //
    // The rows carry the answer: loadUnifiedInbox stamps each with its own
    // `_accountId` and the `_mailbox` it resolved for that account. It builds
    // the list from one folder per account, so a single mailbox covers this
    // account's whole slice of the list.
    //
    // A branch listing (loadSubtree) spans mailboxes the other way: one
    // account, but rows from every folder under `activeMailbox`, which is the
    // branch root. The pipeline fetches from one folder, so it takes the root's
    // own rows only. Handing it the whole branch asked the root for uids it
    // does not hold, and each "not here" answer pruned that row from the root
    // and took one off the branch's count.
    const spanning = activeMailbox === 'UNIFIED';
    const ownRows = spanning
      ? emails.filter(e => e._accountId === accountId)
      : mailboxScope
        ? emails.filter(e => (e._mailbox ?? activeMailbox) === activeMailbox)
        : emails;
    const pipelineMailbox = spanning
      ? (ownRows.find(e => e._mailbox)?._mailbox || 'INBOX')
      : activeMailbox;

    // What the account already keeps, read before the pipeline is picked:
    // everything from the reuse check to `startContentCaching` must run
    // without a yield (see below). Only Index Only asks the index.
    const policy = fetchPolicy(useSettingsStore.getState(), accountId);
    let kept = savedEmailIds;
    if (policy?.mode === 'indexOnly') {
      kept = await this._keptUids(accountId, pipelineMailbox, savedEmailIds, policy);
      // The read yielded: a newer activation owns the pipelines now.
      if (this._activeAccountId !== accountId || this._destroyed) return;
    }

    // Reuse a live pipeline for this account — switching away and back used to
    // destroy it and rebuild from scratch, throwing away its queue and the
    // headers it had already loaded. Callbacks are plain fields, so a pipeline
    // built as a background one is re-pointed here rather than replaced.
    // Only when it is idle, though: startContentCaching() resets _activeSlots
    // to 0, so reusing one with live workers would launch a second full set of
    // slots and let the drainers decrement past zero.
    const existing = this.pipelines.get(accountId);
    let pipeline;
    if (existing && !existing._destroyed && existing._activeSlots === 0) {
      pipeline = existing;
      pipeline.account = account; // credentials/token may have been refreshed
      pipeline.concurrency = 3;   // promote from background concurrency
      pipeline.onProgress = (state) => this._onProgress(accountId, state);
      pipeline.onComplete = () => this._onActiveComplete(accountId);
      pipeline.onError = (err) => console.warn(`[PipelineManager] Active pipeline error:`, err.message);
      pipeline.resume?.(pipelineMailbox);
    } else {
      if (existing) existing.destroy();
      pipeline = new AccountPipeline(account, {
        concurrency: 3,
        onProgress: (state) => this._onProgress(accountId, state),
        onComplete: () => this._onActiveComplete(accountId),
        onHeadersRefreshed: (mailbox, emails) => this._onHeadersRefreshed(account, pipeline, mailbox, emails),
        onError: (err) => console.warn(`[PipelineManager] Active pipeline error:`, err.message)
      });
      this.pipelines.set(accountId, pipeline);
    }

    // Load Sent folder headers in parallel (for chat view)
    this._loadSentHeaders(account, pipeline);

    // Start background headers immediately (don't wait for active to finish)
    this._startBackgroundHeadersOnly();

    // Filter UIDs that need caching
    const uidsToFetch = this._getUncachedUids(ownRows, kept, policy);

    // An empty list still runs the after-bodies step (attachment prefetch)
    // and completes at once, which cascades to the background accounts.
    await pipeline.startContentCaching(uidsToFetch, pipelineMailbox);
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
          onHeadersRefreshed: (mailbox, emails) => this._onHeadersRefreshed(account, pipeline, mailbox, emails),
          onError: (err) => console.warn(`[PipelineManager] Background pipeline error (${account.email}):`, err.message)
        });

        this.pipelines.set(account.id, pipeline);

        // Load headers (INBOX + Sent)
        await pipeline.loadHeaders('INBOX');
        let sentFound = false;
        if (!pipeline._destroyed) {
          sentFound = await this._loadSentHeaders(account, pipeline);
        }

        // Pre-fetch mailbox list for instant account switching
        if (!pipeline._destroyed) {
          try {
            const freshAccount = await import('./authUtils').then(m => m.ensureFreshToken(account));
            const apiMod = await import('./api');
            let mailboxes;
            if (isGraphAccount(freshAccount)) {
              // Graph API: fetch folders and convert to app's mailbox format
              const graphFolders = await apiMod.graphListFolders(freshAccount.oauth2AccessToken);
              await adoptGraphFolderKeysFromListing(freshAccount, graphFolders);
              mailboxes = graphFoldersToMailboxes(graphFolders);
            } else {
              mailboxes = await apiMod.fetchMailboxes(freshAccount);
            }
            // Guard: refuse to persist empty mailbox list if prior cache was non-empty
            if (mailboxes && mailboxes.length === 0) {
              const cachedEntry = await db.getCachedMailboxEntry(account.id).catch(() => null);
              const priorMailboxes = cachedEntry?.lastKnownGoodMailboxes || cachedEntry?.mailboxes;
              if (priorMailboxes && priorMailboxes.length > 0) {
                console.warn(`[PipelineManager] Server returned [] mailboxes for ${account.email} — skipping persist (prior cache had data)`);
                return; // Skip saving, keep prior cache
              }
            }
            await db.saveMailboxes(account.id, mailboxes);
            // A first launch knows no folder list for this account until the
            // one just saved, so its Sent path could not be found above.
            if (!sentFound && !pipeline._destroyed) await this._loadSentHeaders(account, pipeline);
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

      // Already walked this launch — a later switch must not re-download it.
      if (this._contentCascadeDone.has(account.id)) continue;

      const pipeline = this.pipelines.get(account.id);
      if (!pipeline || pipeline._destroyed) continue;

      const policy = fetchPolicy(useSettingsStore.getState(), account.id);
      // Use in-memory headers from header loading phase (avoids re-reading from disk)
      const emails = pipeline._lastLoadedEmails;
      if (emails && emails.length > 0) {
        const vault = await db.getVaultUidSets(account.id, 'INBOX');
        // Unknown is not "nothing saved": treating it so re-fetched every
        // cached body. Skip this account unmarked; the next cascade retries.
        // `continue`, never `return`: _backgroundContentRunning must reset.
        if (!vault) continue;
        const kept = await this._keptUids(account.id, 'INBOX', vault.saved, policy);
        const uids = this._getUncachedUids(emails, kept, policy);
        // Start caching first, THEN await completion — avoids race where
        // synchronous onComplete fires before waitForComplete sets up its promise.
        // Empty list: nothing to fetch, but the attachment prefetch still runs.
        pipeline.startContentCaching(uids, 'INBOX');
        await pipeline.waitForComplete();
      }
      // Mark done only if we got through it — a destroy mid-flight should be
      // retried on the next cascade rather than silently skipped forever.
      if (!this._destroyed && !pipeline._destroyed) {
        this._contentCascadeDone.add(account.id);
      }
    }

    this._backgroundContentRunning = false;
  }

  /**
   * Handle account switch — pause backgrounds, promote new active.
   */
  onAccountSwitch(newActiveAccountId) {
    this._activeAccountId = newActiveAccountId;
    // Deliberately NOT clearing _backgroundContentRunning. It guards against a
    // second cascade running concurrently with the first; clearing it here let
    // every switch start another full walk of every other account's bodies on
    // top of the one already in flight. Per-account progress lives in
    // _contentCascadeDone, so a later cascade resumes instead of restarting.

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
   * Caches to disk and populates the store for the active account, and for
   * every account while All inboxes shows INBOX. False when no Sent folder
   * could be found for the account.
   */
  async _loadSentHeaders(account, pipeline) {
    // Each account's OWN Sent path. Every account used to be read at the
    // active account's, which only worked while their servers agreed on it.
    const isActive = account.id === useMailStore.getState().activeAccountId;
    let sentPath = useMailStore.getState().getSentMailboxPath(account.id);
    if (!sentPath && !pipeline._destroyed) {
      // The pipeline starts ~200ms after the list paints, which on a cold
      // profile is before the server folder list lands — read once and the
      // Sent path is still unknown. Wait for it rather than skipping the
      // folder; another account's comes from its folder list saved on disk.
      sentPath = isActive
        ? await waitForSentMailboxPath(useMailStore)
        : findSentMailboxPath(await db.getCachedMailboxes(account.id).catch(() => null), account.sentFolderOverride || null);
    }
    if (!sentPath || pipeline._destroyed) return false;

    try {
      // Always refresh Sent headers from IMAP (Sent folder grows as user sends)
      console.log(`[PipelineManager] Loading Sent headers for ${account.email} (${sentPath})`);
      await pipeline.loadHeaders(sentPath);
      if (pipeline._destroyed) return true;
      this._publishSent(account);
    } catch (e) {
      console.warn(`[PipelineManager] Sent headers load failed (${account.email}):`, e.message);
    }
    return true;
  }

  /**
   * Hand an account's freshly saved Sent headers to the store, when the list
   * on screen threads them: the active account's always, any other account's
   * while All inboxes shows INBOX (read from the cache the pipeline just wrote).
   */
  _publishSent(account) {
    // The store's active account, the same one `_loadSentHeaders` resolved the
    // path against: the two must never disagree about whose Sent this is.
    const state = useMailStore.getState();
    if (account.id === state.activeAccountId) {
      state.loadSentHeaders(account.id);
    } else if (state.activeMailbox === 'UNIFIED' && mergesSentIntoThreads(state)) {
      state.loadSentHeaders(account.id, { cacheOnly: true });
    }
  }

  /**
   * A sync landed after its headers were already painted from cache.
   * Sent feeds the chat view; INBOX arrivals for an account whose content
   * cascade already ran would otherwise never get their bodies this session.
   */
  async _onHeadersRefreshed(account, pipeline, mailbox, emails) {
    if (pipeline._destroyed || this._destroyed) return;

    if (mailbox === useMailStore.getState().getSentMailboxPath(account.id)) {
      this._publishSent(account);
    } else if (
      mailbox === 'INBOX' &&
      this._contentCascadeDone.has(account.id) &&
      (pipeline._phase === 'idle' || pipeline._phase === 'done')
    ) {
      const policy = fetchPolicy(useSettingsStore.getState(), account.id);
      const vault = await db.getVaultUidSets(account.id, 'INBOX');
      // Unknown: fetch nothing rather than re-fetch every cached body.
      if (!vault || pipeline._destroyed || this._destroyed) return;
      const kept = await this._keptUids(account.id, 'INBOX', vault.saved, policy);
      if (pipeline._destroyed || this._destroyed) return;
      const uids = this._getUncachedUids(emails, kept, policy);
      if (uids.length > 0) pipeline.startContentCaching(uids, 'INBOX');
    }
  }

  /**
   * The uids whose body the account already keeps: the vault's, plus, under
   * Index Only, those whose body the search index holds. Index Only evicts
   * those files on purpose, so counting the vault alone downloaded them again
   * at every launch. The index unknown (`null`): the vault's alone.
   */
  async _keptUids(accountId, mailbox, saved, policy) {
    if (policy?.mode !== 'indexOnly') return saved;
    const indexed = await db.getBodyIndexedUids(accountId, mailbox);
    return indexed?.size ? new Set([...saved, ...indexed]) : saved;
  }

  /**
   * Filter emails to the UIDs whose body the account's download mode keeps
   * (`fetchPolicy`, the daemon's own rule) and that are not yet in Maildir.
   * On Demand and a hidden account (`policy` null) download nothing ahead.
   * Uses the pre-loaded savedEmailIds Set for O(1) lookups instead of per-UID IPC calls.
   */
  _getUncachedUids(emails, savedEmailIds, policy, nowMs = Date.now()) {
    if (!policy || policy.mode === 'onDemand') return [];
    return emails
      .filter(email => !savedEmailIds.has(email.uid)
        && keepsBody(policy, new Date(email.date || email.internalDate).getTime(), nowMs))
      .map(email => email.uid);
  }
}

// Export singleton instance
export const pipelineManager = new EmailPipelineManager();
