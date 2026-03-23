/**
 * Keychain session state machine.
 *
 * Tracks whether keychain access has been attempted, what the outcome was,
 * and whether automatic re-prompts are allowed. The state persists for the
 * lifetime of the browser/webview session (not across restarts).
 *
 * Statuses:
 *   idle         — no attempt yet
 *   requesting   — a keychain read is in flight
 *   granted      — credentials returned
 *   denied       — user explicitly denied access
 *   cancelled    — user dismissed/cancelled the prompt
 *   timed_out    — prompt never completed in time
 *   unavailable  — keychain service failed or is inaccessible
 *   empty        — keychain read succeeded but no credentials exist
 */

let _status = 'idle';
let _message = null;
let _promptShown = false; // whether the OS prompt has appeared this session

/** Get current keychain session status. */
export function getStatus() { return _status; }

/** Get last error message (if any). */
export function getMessage() { return _message; }

/** Whether an OS keychain prompt has already appeared this session. */
export function hasPromptedThisSession() { return _promptShown; }

/**
 * Whether automatic (background) keychain reads should be blocked.
 * True when a previous attempt was denied/cancelled/timed_out — the user
 * either said no or the system couldn't respond, so we shouldn't re-prompt
 * until the user explicitly requests it.
 */
export function isLockedOut() {
  return _status === 'denied' || _status === 'cancelled' || _status === 'timed_out';
}

/** Whether credentials were successfully retrieved this session. */
export function isGranted() {
  return _status === 'granted';
}

/**
 * Record the outcome of a keychain read.
 * Called by db.js after the Tauri get_credentials command returns.
 */
export function recordOutcome(status, message = null) {
  _status = status;
  _message = message;
  if (status !== 'idle') _promptShown = true;
  console.log(`[keychainSession] status → ${status}${message ? ` (${message})` : ''}`);
  _notifyListeners();
}

/**
 * Reset session state for an explicit user-initiated retry.
 * Allows one new keychain prompt attempt.
 */
export function resetForRetry() {
  console.log('[keychainSession] Reset for explicit retry');
  _status = 'idle';
  _message = null;
  // Note: _promptShown stays true — we track that a prompt was shown,
  // but we allow the retry to trigger a new one
}

// ── Listeners ────────────────────────────────────────────────────────────────

const _listeners = new Set();

export function subscribe(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

function _notifyListeners() {
  for (const fn of _listeners) {
    try { fn(_status, _message); } catch (e) { console.error('[keychainSession] listener error:', e); }
  }
}
