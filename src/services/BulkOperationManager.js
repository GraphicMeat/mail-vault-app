import * as api from './api';
import { send } from './transport.js';
import { ensureFreshToken } from './authUtils';
import { t } from '../i18n/index.js';
import { _parseSelKey } from '../stores/slices/unifiedHelpers.js';
import { isLocalMailbox } from './workflows/mailboxTree.js';

// Operation states: 'idle' | 'archiving' | 'verifying' | 'backingUp' | 'deleting' | 'complete' | 'cancelled' | 'error'

// How many uids one `backup_copy_uids` call carries. Each call is one round trip to the
// daemon that reads and writes the backup drive file by file, so a batch is also the unit
// after which progress moves and a cancel or a vanished drive is noticed.
const BACKUP_COPY_BATCH = 100;

/**
 * The folders a bulk selection lives in. A selection is keyed the way the list
 * keys it: a bare uid for the open folder's own row, `account:mailbox:uid` for
 * a row from anywhere else (All Inboxes, a folder subtree, a Sent copy merged
 * into INBOX, a search hit). A uid names a message only inside one (account,
 * mailbox), and the daemon's routes take numbers for one folder at a time, so
 * each key runs in its own folder. A key that names no one folder is refused,
 * never guessed: a bare uid in a view spanning folders, a key without a folder,
 * the `UNIFIED` placeholder, a uid that is not a number.
 *
 * @returns {{ groups: { accountId: string, mailbox: string, uids: number[] }[], refused: Array }}
 */
export function groupBulkTargets(keys, { accountId, mailbox, spans = false }) {
  const groups = new Map();
  const refused = [];
  for (const key of keys || []) {
    const parsed = _parseSelKey(key);
    const target = parsed.accountId
      ? { accountId: parsed.accountId, mailbox: parsed.mailbox }
      : { accountId: spans ? null : accountId, mailbox };
    if (!target.accountId || !target.mailbox || target.mailbox === 'UNIFIED' || !Number.isInteger(parsed.uid)) {
      refused.push(key);
      continue;
    }
    const id = JSON.stringify([target.accountId, target.mailbox]);
    if (!groups.has(id)) groups.set(id, { ...target, uids: new Set() });
    groups.get(id).uids.add(parsed.uid);
  }
  return { groups: [...groups.values()].map(g => ({ ...g, uids: [...g.uids] })), refused };
}

// The persisted form of a uid: a full key names its folder on its own, so a
// resume after a restart runs it where it was, whatever view is open then.
const fullKey = (group, uid) => `${group.accountId}:${group.mailbox}:${uid}`;
const sum = (groups, field) => groups.reduce((n, g) => n + g[field].length, 0);

class BulkOperationManager {
  constructor() {
    this._operation = null;
    this._unlisten = null;
    this._onProgress = null;
    this._cancelled = false;
    // The folder whose daemon call is in flight, and what the folders before it reached.
    this._current = null;
    this._base = { completed: 0, errors: 0 };
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
   * @param {string} params.accountId - The open view's account: where a bare uid lives.
   * @param {Object} params.account - Full account object (for IMAP auth)
   * @param {Object[]} [params.accounts] - Every account a full key may name.
   * @param {Object} [params.localFolders] - Vault-only folders per account (`state.localFolders`).
   * @param {string} params.mailbox - The open view's folder: where a bare uid lives.
   * @param {boolean} [params.spans] - The view spans folders, so a bare uid names no one message.
   * @param {Array<number|string>} params.uids - Selection keys: bare uids and `account:mailbox:uid` keys.
   * @param {Function} params.onProgress - Called with operation state updates
   */
  async start({ type, accountId, account, accounts = [], localFolders = {}, mailbox, spans = false, uids, onProgress }) {
    if (this.isRunning) {
      throw new Error(t('errors.operationRunning'));
    }

    this._cancelled = false;
    this._onProgress = onProgress;

    // delete_everywhere resolves its keys itself (purgeEverywhere); every
    // other run goes out one folder at a time, under that folder's account.
    const everywhere = type === 'delete_everywhere';
    const accountsById = new Map([...accounts, account].filter(Boolean).map(a => [a.id, a]));
    const { groups: resolved, refused } = everywhere ? { groups: [], refused: [] } : groupBulkTargets(uids, { accountId, mailbox, spans });
    const groups = [];
    // A vault-only folder (an MBOX import kept on this computer) is on no
    // server: its archive or delete call can only fail, and a failure ends the
    // run before the folders after it. Kept out, and counted on its own.
    let skippedLocal = 0;
    for (const group of resolved) {
      const groupAccount = accountsById.get(group.accountId);
      if (!groupAccount) refused.push(...group.uids.map(uid => fullKey(group, uid)));
      else if (isLocalMailbox(localFolders, group.accountId, group.mailbox)) skippedLocal += group.uids.length;
      else groups.push({ ...group, account: groupAccount });
    }
    if (refused.length) console.warn(`[BulkOp] ${refused.length} selected keys name no one folder, skipped:`, refused);
    if (skippedLocal) console.warn(`[BulkOp] ${skippedLocal} selected messages are in a vault-only folder, skipped`);
    this._current = null;
    this._base = { completed: 0, errors: 0 };

    const totalUids = everywhere ? [...uids] : groups.flatMap(g => g.uids.map(uid => fullKey(g, uid)));
    this._operation = {
      id: `op_${Date.now()}`,
      type,
      accountId,
      mailbox,
      totalUids,
      completedUids: [],
      currentPhase: (type === 'delete' || everywhere) ? 'delete' : 'archive',
      status: (type === 'delete' || everywhere) ? 'deleting' : 'archiving',
      total: totalUids.length,
      completed: 0,
      errors: 0,
      skipped: refused.length,
      skippedLocal,
      createdAt: new Date().toISOString(),
    };

    // Persist operation state
    await this._persist();
    this._emitProgress();

    // Set up event listener for Rust progress events
    await this._setupEventListener();

    try {
      if (type === 'archive' || type === 'archive_and_delete' || type === 'archive_backup_delete') {
        // Phase 1: Archive
        this._operation.currentPhase = 'archive';
        this._operation.status = 'archiving';
        this._emitProgress();

        if (window.__TAURI__?.core?.invoke) {
          await this._eachGroup(groups, g => g.uids, async (g, freshAccount) => {
            await send('archive_emails', {
              accountId: g.accountId,
              accountJson: JSON.stringify(freshAccount),
              mailbox: g.mailbox,
              uids: g.uids,
              // Off the click lane: a bulk run must not queue the message the user opens.
              background: true,
            });
          });
        }

        if (this._cancelled) return;

        // Phase 2: Verify (only if delete follows)
        if (type === 'archive_and_delete') {
          this._operation.currentPhase = 'verify';
          this._operation.status = 'verifying';
          this._emitProgress();

          for (const g of groups) {
            const result = await api.verifyArchivedEmails(g.accountId, g.mailbox, g.uids);
            g.verified = result.verified;
            if (result.missing.length > 0) {
              console.warn(`[BulkOp] ${result.missing.length} UIDs failed verification in ${g.mailbox}, skipping delete for those`);
            }
            if (this._cancelled) return;
          }

          // Phase 3: Delete verified UIDs
          this._startPhase('delete', 'deleting', groups, 'verified');
          await this._persist();
          this._emitProgress();

          // No deleted-mail bin copy: the vault copies were just verified.
          await this._eachGroup(groups, g => g.verified, (g, freshAccount) =>
            api.bulkDeleteEmails(freshAccount, g.accountId, g.mailbox, g.verified, { bin: false }));
        } else if (type === 'archive_backup_delete') {
          await this._backUpThenDelete(groups);
          if (this._cancelled) return;
        }
      } else if (type === 'delete') {
        // Delete only — no archive, no verify
        this._operation.currentPhase = 'delete';
        this._operation.status = 'deleting';
        this._emitProgress();

        await this._eachGroup(groups, g => g.uids, (g, freshAccount) =>
          api.bulkDeleteEmails(freshAccount, g.accountId, g.mailbox, g.uids));
      } else if (everywhere) {
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
   * One daemon call per folder, in turn, each under its own account's fresh
   * credentials. A folder with nothing to send is skipped. The progress events
   * each call raises count from zero for that folder alone, so they are read
   * on top of what the folders before it already reached (`_base`), and only
   * the folder in flight is listened to (`_current`).
   */
  async _eachGroup(groups, uidsOf, run) {
    let done = 0;
    for (const g of groups) {
      const uids = uidsOf(g);
      if (!uids.length) continue;
      this._current = g;
      this._base = { completed: done, errors: this._operation.errors };
      await run(g, await ensureFreshToken(g.account));
      done += uids.length;
      if (this._cancelled) return;
    }
  }

  // A new phase counts the uids that reached it, from zero.
  _startPhase(phase, status, groups, field) {
    const op = this._operation;
    op.currentPhase = phase;
    op.status = status;
    op.totalUids = groups.flatMap(g => g[field].map(uid => fullKey(g, uid)));
    op.total = sum(groups, field);
    op.completed = 0;
    op.errors = 0;
    this._base = { completed: 0, errors: 0 };
  }

  /**
   * Archive, Back up & Delete, after the archive step: verify the vault copies,
   * copy the verified ones to the backup drive and check them there, then delete
   * from the server ONLY the uids proven in both places. A uid that fails either
   * proof stays on the server and is counted under the reason, in `result`.
   * The delete is a permanent server delete (`bin: false`), as Archive & Delete's is.
   * Each step runs over every folder before the next begins, so the phases
   * move forward once, and the result adds up across folders.
   */
  async _backUpThenDelete(groups) {
    const op = this._operation;
    const result = { removed: 0, keptNotArchived: 0, keptBackupUnreachable: 0, keptCopyMismatch: 0, keptDeleteFailed: 0 };
    op.result = result;

    // Step 2: the vault holds an archived copy of each uid.
    op.currentPhase = 'verify';
    op.status = 'verifying';
    this._emitProgress();
    for (const g of groups) {
      const vault = await api.verifyArchivedEmails(g.accountId, g.mailbox, g.uids);
      g.vaultVerified = vault.verified || [];
      result.keptNotArchived += g.uids.length - g.vaultVerified.length;
      if (this._cancelled) return;
    }

    // Step 3: the drive holds a verified copy of each of those.
    this._startPhase('copy', 'backingUp', groups, 'vaultVerified');
    await this._persist();
    this._emitProgress();

    // One drive for every folder: once it stops answering, none of the rest is tried.
    let driveGone = false;
    for (const g of groups) {
      const asked = new Set(g.vaultVerified);
      g.bothVerified = [];
      for (let i = 0; i < g.vaultVerified.length; i += BACKUP_COPY_BATCH) {
        const batch = g.vaultVerified.slice(i, i + BACKUP_COPY_BATCH);
        if (driveGone) {
          // The drive stopped answering: do not hammer it, and delete none of the rest.
          result.keptBackupUnreachable += batch.length;
          op.completed += batch.length;
          continue;
        }
        let copied;
        try {
          copied = await api.backupCopyUids(g.accountId, g.account.email, g.mailbox, batch);
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
        g.bothVerified.push(...proven);
        op.completed += batch.length;
        this._emitProgress();
      }
    }
    if (this._cancelled) return;

    // Step 4: delete what both places hold. Nothing proven, nothing sent.
    if (sum(groups, 'bothVerified') > 0) {
      this._startPhase('delete', 'deleting', groups, 'bothVerified');
      await this._persist();
      this._emitProgress();

      // No deleted-mail bin copy: both copies were just verified.
      await this._eachGroup(groups, g => g.bothVerified, async (g, freshAccount) => {
        const reply = await api.bulkDeleteEmails(freshAccount, g.accountId, g.mailbox, g.bothVerified, { bin: false });
        // The daemon counts what the server really removed; a reply without a count
        // (an older daemon) is taken at its word. Anything it did not remove stayed.
        const removed = Number.isInteger(reply?.completed) ? Math.min(reply.completed, g.bothVerified.length) : g.bothVerified.length;
        result.removed += removed;
        result.keptDeleteFailed += g.bothVerified.length - removed;
      });
    }
  }

  /**
   * Resume a pending operation (from app restart).
   */
  async resume(pendingOp, account, onProgress, { accounts = [], localFolders = {} } = {}) {
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
      accounts,
      localFolders,
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
        // A run over several folders archives one at a time: only the one in
        // flight is this run's, counted on top of the folders already done.
        // Before any folder is under way, the run's own folder is.
        const current = this._current || this._operation;
        if (p.operation !== 'archive' || p.accountId !== current.accountId || p.mailbox !== current.mailbox) return;
        this._operation.completed = this._base.completed + p.completed;
        this._operation.errors = this._base.errors + p.errors;
        // Only surface the provider bandwidth-limit stop — per-email errors stay a count
        if (p.bandwidthLimited && p.lastError) this._operation.lastError = p.lastError;
        this._emitProgress();
      });

      const unlisten2 = await listen('bulk-operation-progress', (event) => {
        if (!this._operation) return;
        const p = event.payload;
        this._operation.completed = this._base.completed + p.completed;
        this._operation.errors = this._base.errors + p.errors;
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
