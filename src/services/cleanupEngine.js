// Auto-cleanup engine — executes cleanup rules on a schedule or on demand.
// Runs once per 24h (or manually via "Run All Now"), processes enabled rules,
// and deletes or archives+deletes emails older than the configured threshold.
//
// The one invariant: a rule may delete a server copy only where a copy of that
// exact message is proven to be here first - in the vault, and in the external
// mirror when one is configured. Everything else it counts as skipped and says
// so. Until 2026-09-08 it deleted first and verified never: the archive invoke
// was rejected on every call (wrong argument name, see the accountJson below),
// its failure was swallowed, and the delete ran anyway.

import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { useMailStore } from '../stores/mailStore';
import { ensureFreshToken } from './authUtils';
import * as api from './api';
import * as db from './db';
import { PROTECTED_FOLDERS, resolveCleanupFolders, isTrashFolder } from '../utils/cleanupFolders';

// ── Module-level state ────────────────────────────────────────────────────────

let _lastRunTimestamp = 0;
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// ── Helpers ───────────────────────────────────────────────────────────────────

// A rule is stored in exactly one shape — the one the add/edit form in
// StorageSettings.jsx writes:
//   { id, account: 'all' | 'email@…', folder, age: number, unit, action, enabled }
// The engine used to read a different, never-written spec (`accountEmail`,
// `olderThan: { value, unit }`, `'archive-delete'`), so every rule a user ever
// saved matched nothing. See the v4 → v5 migration in settingsStore.js.
const DAY_MS = 24 * 60 * 60 * 1000;
const UNIT_MS = { days: DAY_MS, months: 30 * DAY_MS };

/** Actions the form can produce. An unrecognised one is refused, never guessed. */
const ALLOWED_ACTIONS = new Set(['delete', 'archive-then-delete']);

// The form enforces a 7-day floor (1 month). The engine enforces it again:
// a threshold that fails to parse must refuse to run, because the alternative
// — falling through to 0 — means "every message is stale".
const MIN_THRESHOLD_MS = 7 * DAY_MS;

const noWork = () => ({ archived: 0, deleted: 0, skipped: 0 });

/** Convert a rule's age + unit to milliseconds. 0 when it does not parse. */
function thresholdToMs(rule) {
  const unitMs = UNIT_MS[rule?.unit];
  const age = Number(rule?.age);
  if (!unitMs || !Number.isFinite(age) || age <= 0) return 0;
  return age * unitMs;
}

function isProtectedFolder(folder) {
  return PROTECTED_FOLDERS.has(folder);
}

/** Get visible (non-hidden) accounts. */
function getVisibleAccounts() {
  const { accounts } = useMailStore.getState();
  const { hiddenAccounts } = useSettingsStore.getState();
  return accounts.filter(a => !hiddenAccounts[a.id]);
}

/**
 * Load cached headers for a given account + folder from disk.
 * Returns an array of email header objects (each has uid, date, etc).
 */
async function loadCachedEmails(accountId, folder) {
  try {
    const data = await db.getEmailHeaders(accountId, folder);
    return data?.emails || [];
  } catch (e) {
    console.warn(`[CleanupEngine] Failed to load cached emails for ${accountId}/${folder}:`, e);
    return [];
  }
}

/**
 * "This app deleted the server copy" - what turns the vault row from "saved in
 * your vault" into "your only copy". Best-effort: a stamp that fails must not
 * report a delete that DID happen as a failure. Imported lazily so the engine
 * (loaded by the pipeline coordinator on launch) does not pull the whole
 * mutation workflow in with it.
 */
async function stampServerDeleted(accountId, mailbox, uid) {
  try {
    const { markServerDeleted } = await import('./workflows/messageMutations');
    await markServerDeleted(accountId, mailbox, uid);
  } catch (e) {
    console.warn(`[CleanupEngine] Could not stamp uid ${uid} as server-deleted:`, e);
  }
}

// ── One folder of one account ─────────────────────────────────────────────────

/**
 * Archive (when the rule says so), verify, then delete what was verified.
 * `stale` are the cached headers past the rule's threshold.
 */
async function cleanFolder(rule, account, freshAccount, box, stale) {
  const folder = box.path;
  const uids = stale.map(e => e.uid);
  const counts = noWork();

  console.log(`[CleanupEngine] Processing ${stale.length} stale emails for ${account.email}/${folder} (action: ${rule.action})`);

  if (rule.action === 'archive-then-delete' && window.__TAURI__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // `account_json: String` is what the command declares (main.rs). Passing
      // the object under `account` was rejected before the archiver ever ran.
      await invoke('archive_emails', {
        accountId: account.id,
        accountJson: JSON.stringify(freshAccount),
        uids,
        mailbox: folder,
      });
    } catch (e) {
      console.error(`[CleanupEngine] Failed to archive emails for ${account.email}/${folder}:`, e);
      counts.skipped += uids.length;
      return counts;
    }
  }

  // The vault's own answer, per uid - and where the header cache knows the
  // Message-ID, whether the file on disk is that same message rather than a
  // reused uid from a mailbox that was recreated.
  const expectedIds = {};
  for (const e of stale) {
    const id = e.messageId || e.message_id;
    if (id) expectedIds[e.uid] = id;
  }
  let verified = [];
  try {
    const result = await api.verifyArchivedEmails(
      account.id, folder, uids, Object.keys(expectedIds).length ? expectedIds : null,
    );
    verified = result?.verified || [];
  } catch (e) {
    console.error(`[CleanupEngine] Could not verify vault copies for ${account.email}/${folder}:`, e);
    counts.skipped += uids.length;
    return counts;
  }
  if (rule.action === 'archive-then-delete') counts.archived += verified.length;
  if (verified.length < uids.length) {
    console.warn(`[CleanupEngine] ${account.email}/${folder}: ${uids.length - verified.length} message(s) have no verified vault copy - leaving them on the server`);
  }

  // The external mirror is the user's second copy. `null` is "cannot tell"
  // (drive unplugged), never "holds nothing" - so with a location configured
  // it vetoes the whole folder rather than deleting past an unplugged disk.
  let deletable = new Set(verified);
  if (useSettingsStore.getState().externalBackupLocation) {
    const mirrored = await api.backupScanUids(account.email, folder).catch(() => null);
    if (mirrored === null) {
      console.warn(`[CleanupEngine] ${account.email}/${folder}: external backup cannot be read - skipping all ${uids.length} message(s)`);
      counts.skipped += uids.length;
      return counts;
    }
    const inMirror = new Set(mirrored);
    deletable = new Set(verified.filter(uid => inMirror.has(uid)));
  }

  // Only the Trash folder itself is emptied permanently; everything else moves
  // there, so a rule the user misjudged is still recoverable from the server.
  const permanent = isTrashFolder(box);
  // ponytail: one UID MOVE per message; batch imap_move_emails per folder if a
  // 26k run proves too slow.
  for (const uid of uids) {
    if (!deletable.has(uid)) { counts.skipped++; continue; }
    try {
      await api.deleteEmail(freshAccount, uid, folder, permanent);
      counts.deleted++;
      await stampServerDeleted(account.id, folder, uid);
    } catch (e) {
      console.error(`[CleanupEngine] Failed to delete UID ${uid}:`, e);
      counts.skipped++;
    }
  }
  return counts;
}

// ── Rule execution ────────────────────────────────────────────────────────────

/**
 * Execute a single cleanup rule.
 * Returns { archived, deleted, skipped }.
 */
async function executeRule(rule, { dryRun = false } = {}) {
  if (!rule.enabled) return noWork();
  if (isProtectedFolder(rule.folder)) {
    console.warn(`[CleanupEngine] Skipping rule ${rule.id} — "${rule.folder}" is a protected folder`);
    return noWork();
  }

  const thresholdMs = thresholdToMs(rule);
  if (thresholdMs < MIN_THRESHOLD_MS) {
    console.warn(`[CleanupEngine] Skipping rule ${rule.id} — threshold "${rule.age} ${rule.unit}" is unusable or below the 7-day floor`);
    return noWork();
  }
  if (!ALLOWED_ACTIONS.has(rule.action)) {
    console.warn(`[CleanupEngine] Skipping rule ${rule.id} — unknown action "${rule.action}"`);
    return noWork();
  }
  const cutoff = Date.now() - thresholdMs;

  // Determine target accounts ('all' is the form's every-account sentinel)
  const accounts = rule.account === 'all'
    ? getVisibleAccounts()
    : getVisibleAccounts().filter(a => a.email === rule.account);

  const totals = noWork();

  for (const account of accounts) {
    try {
      // The rule stores a role ("Sent"), not a path: on Dovecot the folder is
      // INBOX.Sent and the literal matched nothing at all. No cached list is
      // no answer - skip the account rather than guess at its folder names.
      const entry = await db.getCachedMailboxEntry(account.id);
      const folders = resolveCleanupFolders(
        rule.folder, entry?.lastKnownGoodMailboxes || entry?.mailboxes,
      );
      if (folders.length === 0) {
        console.warn(`[CleanupEngine] ${account.email}: "${rule.folder}" names no folder in the cached mailbox list - nothing to clean`);
        continue;
      }

      let freshAccount = null;
      for (const box of folders) {
        const emails = await loadCachedEmails(account.id, box.path);
        // Filter emails older than threshold
        const staleEmails = emails.filter(e => {
          if (!e.date) return false;
          const emailTime = new Date(e.date).getTime();
          return !isNaN(emailTime) && emailTime < cutoff;
        });

        if (staleEmails.length === 0) continue;

        if (dryRun) {
          totals.deleted += staleEmails.length;
          continue;
        }

        // Refresh token before IMAP operations - once per account, not per folder
        if (!freshAccount) freshAccount = await ensureFreshToken(account);

        const counts = await cleanFolder(rule, account, freshAccount, box, staleEmails);
        totals.archived += counts.archived;
        totals.deleted += counts.deleted;
        totals.skipped += counts.skipped;
      }
    } catch (e) {
      console.error(`[CleanupEngine] Error processing account ${account.email}:`, e);
    }
  }

  return totals;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run all enabled cleanup rules.
 * Returns { archived, deleted, skipped, at } and persists the same object, so
 * the 24h guard and the settings screen both survive a relaunch.
 */
export async function runCleanupRules() {
  const { billingProfile, cleanupRules } = useSettingsStore.getState();

  // Only premium users can run cleanup
  if (!hasPremiumAccess(billingProfile)) {
    console.log('[CleanupEngine] Skipping — no premium access');
    return { archived: 0, deleted: 0 };
  }

  const enabledRules = cleanupRules.filter(r => r.enabled);
  if (enabledRules.length === 0) {
    console.log('[CleanupEngine] No enabled cleanup rules');
    return { archived: 0, deleted: 0 };
  }

  console.log(`[CleanupEngine] Running ${enabledRules.length} cleanup rule(s)...`);

  const totals = noWork();

  for (const rule of enabledRules) {
    try {
      const result = await executeRule(rule);
      totals.archived += result.archived;
      totals.deleted += result.deleted;
      totals.skipped += result.skipped;
    } catch (e) {
      console.error(`[CleanupEngine] Rule ${rule.id} failed:`, e);
    }
  }

  const result = { ...totals, at: Date.now() };
  _lastRunTimestamp = result.at;
  useSettingsStore.getState().setCleanupLastRun(result);

  console.log(`[CleanupEngine] Done - archived: ${totals.archived}, deleted: ${totals.deleted}, skipped: ${totals.skipped}`);

  return result;
}

/**
 * Check if enough time has passed since the last run. The stored run is what
 * makes this a real 24h guard: a module variable re-armed on every launch.
 */
export function shouldRunCleanup() {
  const at = _lastRunTimestamp || useSettingsStore.getState().cleanupLastRun?.at || 0;
  return Date.now() - at > CLEANUP_INTERVAL;
}
