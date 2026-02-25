import * as api from './api';
import { ensureFreshToken } from './authUtils';

// Operation states: 'idle' | 'archiving' | 'verifying' | 'deleting' | 'complete' | 'cancelled' | 'error'

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
    return this._operation && ['archiving', 'verifying', 'deleting'].includes(this._operation.status);
  }

  /**
   * Start a bulk operation.
   * @param {Object} params
   * @param {string} params.type - 'archive' | 'delete' | 'archive_and_delete'
   * @param {string} params.accountId
   * @param {Object} params.account - Full account object (for IMAP auth)
   * @param {string} params.mailbox
   * @param {number[]} params.uids - UIDs to operate on
   * @param {Function} params.onProgress - Called with operation state updates
   */
  async start({ type, accountId, account, mailbox, uids, onProgress }) {
    if (this.isRunning) {
      throw new Error('An operation is already running');
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
      currentPhase: type === 'delete' ? 'delete' : 'archive',
      status: type === 'delete' ? 'deleting' : 'archiving',
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

      if (type === 'archive' || type === 'archive_and_delete') {
        // Phase 1: Archive
        this._operation.currentPhase = 'archive';
        this._operation.status = 'archiving';
        this._emitProgress();

        const invoke = window.__TAURI__?.core?.invoke;
        if (invoke) {
          await invoke('archive_emails', {
            accountId,
            accountJson: JSON.stringify(freshAccount),
            mailbox,
            uids,
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
          await api.bulkDeleteEmails(freshAccount2, accountId, mailbox, verifiedUids);
        }
      } else if (type === 'delete') {
        // Delete only — no archive, no verify
        this._operation.currentPhase = 'delete';
        this._operation.status = 'deleting';
        this._emitProgress();

        await api.bulkDeleteEmails(freshAccount, accountId, mailbox, uids);
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

    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) {
      invoke('cancel_archive').catch(() => {});
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
        this._operation.completed = p.completed;
        this._operation.errors = p.errors;
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
