// Auto-cleanup engine — executes cleanup rules on a schedule or on demand.
// Runs once per 24h (or manually via "Run All Now"), processes enabled rules,
// and deletes or archives+deletes emails older than the configured threshold.

import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { useMailStore } from '../stores/mailStore';
import { ensureFreshToken } from './authUtils';
import * as api from './api';
import * as db from './db';

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

/** Convert a rule's age + unit to milliseconds. 0 when it does not parse. */
function thresholdToMs(rule) {
  const unitMs = UNIT_MS[rule?.unit];
  const age = Number(rule?.age);
  if (!unitMs || !Number.isFinite(age) || age <= 0) return 0;
  return age * unitMs;
}

/** Safety: folders that must never be cleaned. */
const PROTECTED_FOLDERS = new Set(['Drafts']);

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

// ── Rule execution ────────────────────────────────────────────────────────────

/**
 * Execute a single cleanup rule.
 * Returns { archived: number, deleted: number }.
 */
async function executeRule(rule, { dryRun = false } = {}) {
  if (!rule.enabled) return { archived: 0, deleted: 0 };
  if (isProtectedFolder(rule.folder)) {
    console.warn(`[CleanupEngine] Skipping rule ${rule.id} — "${rule.folder}" is a protected folder`);
    return { archived: 0, deleted: 0 };
  }

  const thresholdMs = thresholdToMs(rule);
  if (thresholdMs < MIN_THRESHOLD_MS) {
    console.warn(`[CleanupEngine] Skipping rule ${rule.id} — threshold "${rule.age} ${rule.unit}" is unusable or below the 7-day floor`);
    return { archived: 0, deleted: 0 };
  }
  if (!ALLOWED_ACTIONS.has(rule.action)) {
    console.warn(`[CleanupEngine] Skipping rule ${rule.id} — unknown action "${rule.action}"`);
    return { archived: 0, deleted: 0 };
  }
  const cutoff = Date.now() - thresholdMs;

  // Determine target accounts ('all' is the form's every-account sentinel)
  const accounts = rule.account === 'all'
    ? getVisibleAccounts()
    : getVisibleAccounts().filter(a => a.email === rule.account);

  let totalArchived = 0;
  let totalDeleted = 0;

  for (const account of accounts) {
    try {
      const emails = await loadCachedEmails(account.id, rule.folder);
      // Filter emails older than threshold
      const staleEmails = emails.filter(e => {
        if (!e.date) return false;
        const emailTime = new Date(e.date).getTime();
        return !isNaN(emailTime) && emailTime < cutoff;
      });

      if (staleEmails.length === 0) continue;

      if (dryRun) {
        totalDeleted += staleEmails.length;
        continue;
      }

      console.log(`[CleanupEngine] Processing ${staleEmails.length} stale emails for ${account.email}/${rule.folder} (action: ${rule.action})`);

      // Refresh token before IMAP operations
      const freshAccount = await ensureFreshToken(account);

      if (rule.action === 'archive-then-delete') {
        // Archive first, then delete
        const uids = staleEmails.map(e => e.uid);
        try {
          // Use the Tauri archive command directly (same as saveEmailsLocally but with explicit account)
          const IS_TAURI = !!window.__TAURI__;
          if (IS_TAURI) {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('archive_emails', {
              accountId: account.id,
              account: freshAccount,
              uids,
              mailbox: rule.folder,
            });
          }
          totalArchived += uids.length;
        } catch (e) {
          console.error(`[CleanupEngine] Failed to archive emails for ${account.email}/${rule.folder}:`, e);
          // Skip deletion if archive failed — don't lose emails
          continue;
        }

        // Delete from server after successful archive
        for (const email of staleEmails) {
          try {
            await api.deleteEmail(freshAccount, email.uid, rule.folder);
            totalDeleted++;
          } catch (e) {
            console.error(`[CleanupEngine] Failed to delete UID ${email.uid}:`, e);
          }
        }
      } else if (rule.action === 'delete') {
        // Delete only (no local archive)
        for (const email of staleEmails) {
          try {
            await api.deleteEmail(freshAccount, email.uid, rule.folder);
            totalDeleted++;
          } catch (e) {
            console.error(`[CleanupEngine] Failed to delete UID ${email.uid}:`, e);
          }
        }
      }
    } catch (e) {
      console.error(`[CleanupEngine] Error processing account ${account.email}:`, e);
    }
  }

  return { archived: totalArchived, deleted: totalDeleted };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run all enabled cleanup rules.
 * Returns { archived: number, deleted: number } totals.
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

  let totalArchived = 0;
  let totalDeleted = 0;

  for (const rule of enabledRules) {
    try {
      const result = await executeRule(rule);
      totalArchived += result.archived;
      totalDeleted += result.deleted;
    } catch (e) {
      console.error(`[CleanupEngine] Rule ${rule.id} failed:`, e);
    }
  }

  _lastRunTimestamp = Date.now();

  if (totalArchived > 0 || totalDeleted > 0) {
    console.log(`[CleanupEngine] Done — archived: ${totalArchived}, deleted: ${totalDeleted}`);
  } else {
    console.log('[CleanupEngine] Done — no emails matched cleanup criteria');
  }

  return { archived: totalArchived, deleted: totalDeleted };
}

/**
 * Check if enough time has passed since the last run.
 */
export function shouldRunCleanup() {
  return Date.now() - _lastRunTimestamp > CLEANUP_INTERVAL;
}
