import * as api from './api';
import { send } from './transport.js';
import { ensureFreshToken } from './authUtils';
import { t } from '../i18n/index.js';

// Operation states: 'idle' | 'archiving' | 'verifying' | 'backingUp' | 'deleting' | 'complete' | 'cancelled' | 'error'

// How many uids one `backup_copy_uids` call carries. Each call is one round trip to the
// daemon that reads and writes the backup drive file by file, so a batch is also the unit
// after which progress moves and a cancel or a vanished drive is noticed.
const BACKUP_COPY_BATCH = 100;

class BulkOperationManager {
  constructor() {
    this._operation = null;
    this._unlisten = null;
    this._onProgress = null;
    this._cancelled = false;
  }

  get operation() {
    return this._operation;
  }

  get isRunning() {
    return this._operation && ['archiving', 'verifying', 'backingUp', 'deleting'].includes(this._operation.status);
  }

  /**
   * Start a bulk operation.
   * @param {Object} params
   * @param {string} params.type - 'archive' | 'delete' | 'archive_and_delete' | 'archive_backup_delete' | 'delete_everywhere'
   * @param {string} params.accountId
   * @param {Object} params.account - Full account object (for IMAP auth)
   * @param {string} params.mailbox
   * @param {number[]} params.uids - UIDs to operate on
   * @param {Function} params.onProgress - Called with operation state updates
   */
  async start({ type, accountId, account, mailbox, uids, onProgress }) {
    if (this.isRunning) {
      throw new Error(t('errors.operationRunning'));
    }

    this._cancelled = false;
    this._onProgress = onProgress;

    this._operation = {
      id: `op_${Date.now()}`,
      type,
      accountId,
      mailbox,
      totalUids: [...uids],
      completedUids: [],
      currentPhase: (type === 'delete' || type === 'delete_everywhere') ? 'delete' : 'archive',
      status: (type === 'delete' || type === 'delete_everywhere') ? 'deleting' : 'archiving',
      total: uids.length,
      completed: 0,
      errors: 0,
      createdAt: new Date().toISOString(),
    };

    // Persist operation state
    await this._persist();
    this._emitProgress();

    // Set up event listener for Rust progress events
    await this._setupEventListener();

    try {
      const freshAccount = await ensureFreshToken(account);

      if (type === 'archive' || type === 'archive_and_delete' || type === 'archive_backup_delete') {
        // Phase 1: Archive
        this._operation.currentPhase = 'archive';
        this._operation.status = 'archiving';
        this._emitProgress();

        if (window.__TAURI__?.core?.invoke) {
          await send('archive_emails', {
            accountId,
            accountJson: JSON.stringify(freshAccount),
            mailbox,
            uids,
            // Off the click lane: a bulk run must not queue the message the user opens.
            background: true,
          });
        }

        if (this._cancelled) return;

        // Phase 2: Verify (only if delete follows)
        if (type === 'archive_and_delete') {
          this._operation.currentPhase = 'verify';
          this._operation.status = 'verifying';
          this._emitProgress();

          const result = await api.verifyArchivedEmails(accountId, mailbox, uids);
          const verifiedUids = result.verified;

          if (result.missing.length > 0) {
            console.warn(`[BulkOp] ${result.missing.length} UIDs failed verification, skipping delete for those`);
          }

          if (this._cancelled) return;

          // Phase 3: Delete verified UIDs
          this._operation.currentPhase = 'delete';
          this._operation.status = 'deleting';
          this._operation.totalUids = verifiedUids;
          this._operation.total = verifiedUids.length;
          this._operation.completed = 0;
          this._operation.errors = 0;
          await this._persist();
          this._emitProgress();

          const freshAccount2 = await ensureFreshToken(account);
          // No deleted-mail bin copy: the vault copies were just verified.
          await api.bulkDeleteEmails(freshAccount2, accountId, mailbox, verifiedUids, { bin: false });
        } else if (type === 'archive_backup_delete') {
          await this._backUpThenDelete({ account, accountId, mailbox, uids });
          if (this._cancelled) return;
        }
      } else if (type === 'delete') {
        // Delete only — no archive, no verify
        this._operation.currentPhase = 'delete';
        this._operation.status = 'deleting';
        this._emitProgress();

        await api.bulkDeleteEmails(freshAccount, accountId, mailbox, uids);
      } else if (type === 'delete_everywhere') {
        // Server, vault and backup mirror. purgeEverywhere owns the ordering
        // and the "server delete failed → keep the local copies" rule.
        const { purgeEverywhere } = await import('./workflows/messageMutations');
        const result = await purgeEverywhere(uids, {
          onProgress: (p) => {
            this._operation.currentPhase = p.phase;
            // `delete`'s total/completed cover the whole batch — the
            // meaningful denominator for the progress bar. `vault`/`backup`
            // report a per-(account,mailbox)-group count instead, which can
            // be smaller than what `delete` already reached; letting them
            // overwrite total/completed would make the bar jump backward.
            // Relay the phase label only for those two.
            if (p.phase === 'delete') {
              this._operation.total = p.total;
              this._operation.completed = p.completed;
            }
            this._emitProgress();
          },
        });
        this._operation.result = result;
      }

      if (!this._cancelled) {
        this._operation.status = 'complete';
        this._emitProgress();
        await api.clearPendingOperation();
      }
    } catch (error) {
      console.error('[BulkOp] Operation failed:', error);
      this._operation.status = 'error';
      this._operation.lastError = error.message || String(error);
      this._emitProgress();
    } finally {
      this._cleanup();
    }
  }

  /**
   * Archive, Back up & Delete, after the archive step: verify the vault copies,
   * copy the verified ones to the backup drive and check them there, then delete
   * from the server ONLY the uids proven in both places. A uid that fails either
   * proof stays on the server and is counted under the reason, in `result`.
   * The delete is a permanent server delete (`bin: false`), as Archive & Delete's is.
   */
  async _backUpThenDelete({ account, accountId, mailbox, uids }) {
    const op = this._operation;
    const result = { removed: 0, keptNotArchived: 0, keptBackupUnreachable: 0, keptCopyMismatch: 0, keptDeleteFailed: 0 };
    op.result = result;

    // Step 2: the vault holds an archived copy of each uid.
    op.currentPhase = 'verify';
    op.status = 'verifying';
    this._emitProgress();
    const vault = await api.verifyArchivedEmails(accountId, mailbox, uids);
    const vaultVerified = vault.verified || [];
    result.keptNotArchived = uids.length - vaultVerified.length;
    if (this._cancelled) return;

    // Step 3: the drive holds a verified copy of each of those.
    op.currentPhase = 'copy';
    op.status = 'backingUp';
    op.totalUids = vaultVerified;
    op.total = vaultVerified.length;
    op.completed = 0;
    op.errors = 0;
    await this._persist();
    this._emitProgress();

    const asked = new Set(vaultVerified);
    const bothVerified = [];
    let driveGone = false;
    for (let i = 0; i < vaultVerified.length; i += BACKUP_COPY_BATCH) {
      const batch = vaultVerified.slice(i, i + BACKUP_COPY_BATCH);
      if (driveGone) {
        // The drive stopped answering: do not hammer it, and delete none of the rest.
        result.keptBackupUnreachable += batch.length;
        op.completed += batch.length;
        continue;
      }
      let copied;
      try {
        copied = await api.backupCopyUids(accountId, account.email, mailbox, batch);
      } catch (e) {
        console.warn('[BulkOp] Backup copy failed, keeping the rest on the server:', e);
        driveGone = true;
        result.keptBackupUnreachable += batch.length;
        // Kept on purpose, not failed: the result reports them under their reason.
        op.completed += batch.length;
        this._emitProgress();
        continue;
      }
      if (this._cancelled) return;
      // Only what this batch asked about and the drive proved. The vault check
      // already gated `asked`; the drive's word never widens it.
      const proven = (copied?.verified || []).filter((u) => asked.has(u) && batch.includes(u));
      const provenSet = new Set(proven);
      const mismatched = new Set(copied?.mismatched || []);
      const missing = new Set(copied?.missing || []);
      for (const uid of batch) {
        if (provenSet.has(uid)) continue;
        if (mismatched.has(uid)) result.keptCopyMismatch += 1;
        else if (missing.has(uid)) result.keptNotArchived += 1;
        else result.keptBackupUnreachable += 1;
      }
      bothVerified.push(...proven);
      op.completed += batch.length;
      this._emitProgress();
    }
    if (this._cancelled) return;

    // Step 4: delete what both places hold. Nothing proven, nothing sent.
    if (bothVerified.length > 0) {
      op.currentPhase = 'delete';
      op.status = 'deleting';
      op.totalUids = bothVerified;
      op.total = bothVerified.length;
      op.completed = 0;
      op.errors = 0;
      await this._persist();
      this._emitProgress();

      const freshAccount = await ensureFreshToken(account);
      // No deleted-mail bin copy: both copies were just verified.
      const reply = await api.bulkDeleteEmails(freshAccount, accountId, mailbox, bothVerified, { bin: false });
      // The daemon counts what the server really removed; a reply without a count
      // (an older daemon) is taken at its word. Anything it did not remove stayed.
      const removed = Number.isInteger(reply?.completed) ? Math.min(reply.completed, bothVerified.length) : bothVerified.length;
      result.removed = removed;
      result.keptDeleteFailed = bothVerified.length - removed;
    }
  }

  /**
   * Resume a pending operation (from app restart).
   */
  async resume(pendingOp, account, onProgress) {
    const remainingUids = pendingOp.totalUids.filter(
      uid => !pendingOp.completedUids.includes(uid)
    );

    if (remainingUids.length === 0) {
      await api.clearPendingOperation();
      return;
    }

    await this.start({
      type: pendingOp.type,
      accountId: pendingOp.accountId,
      account,
      mailbox: pendingOp.mailbox,
      uids: remainingUids,
      onProgress,
    });
  }

  /**
   * Cancel the running operation.
   */
  async cancel() {
    this._cancelled = true;

    if (window.__TAURI__?.core?.invoke) {
      // Task 3.5 (decision 7): cancel both registries, this manager runs
      // both archive and bulk-delete phases and cannot know from here alone
      // which one is in flight. cleanupEngine.js's own archive run is a
      // second caller of cancel_archive's registry (F5, sanctioned): this
      // cancel button can also stop a background cleanup archive.
      send('cancel_archive').catch(() => {});
      send('cancel_bulk_delete').catch(() => {});
    }

    if (this._operation) {
      this._operation.status = 'cancelled';
      this._emitProgress();
    }

    await api.clearPendingOperation();
    this._cleanup();
  }

  async _persist() {
    if (!this._operation) return;
    await api.savePendingOperation({
      id: this._operation.id,
      type: this._operation.type,
      accountId: this._operation.accountId,
      mailbox: this._operation.mailbox,
      totalUids: this._operation.totalUids,
      completedUids: this._operation.completedUids,
      currentPhase: this._operation.currentPhase,
      status: this._operation.status,
      createdAt: this._operation.createdAt,
    });
  }

  async _setupEventListener() {
    try {
      const { listen } = await import('@tauri-apps/api/event');

      const unlisten1 = await listen('archive-progress', (event) => {
        if (!this._operation) return;
        const p = event.payload;
        // Task 3.3 (R3.2): archive-progress is shared with backup.rs's own
        // run_with_backup call - take only this manager's own archive run's
        // account/mailbox, or a scheduled backup (or a cleanup-rule archive)
        // running alongside a manual bulk archive stomps this operation's
        // counts (N3).
        if (p.operation !== 'archive' || p.accountId !== this._operation.accountId || p.mailbox !== this._operation.mailbox) return;
        this._operation.completed = p.completed;
        this._operation.errors = p.errors;
        // Only surface the provider bandwidth-limit stop — per-email errors stay a count
        if (p.bandwidthLimited && p.lastError) this._operation.lastError = p.lastError;
        this._emitProgress();
      });

      const unlisten2 = await listen('bulk-operation-progress', (event) => {
        if (!this._operation) return;
        const p = event.payload;
        this._operation.completed = p.completed;
        this._operation.errors = p.errors;
        this._operation.currentPhase = p.phase;
        this._emitProgress();
      });

      this._unlisten = () => {
        unlisten1();
        unlisten2();
      };
    } catch (e) {
      console.warn('[BulkOp] Failed to register event listeners:', e);
    }
  }

  _emitProgress() {
    if (this._onProgress && this._operation) {
      this._onProgress({ ...this._operation });
    }
  }

  _cleanup() {
    if (this._unlisten) {
      this._unlisten();
      this._unlisten = null;
    }
  }
}

// Singleton
export const bulkOperationManager = new BulkOperationManager();
