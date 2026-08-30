/**
 * Decide whether the full initialization (keychain access + first IMAP
 * fetch) should start.
 *
 * Extracted so the decision is testable on its own. A regex over App.jsx
 * source can confirm the right tokens appear, but it cannot catch a
 * state-machine defect: an equivalent-looking rewrite passes that regex just
 * as easily as the one it replaced, and the actual deadlock below would have
 * passed it too. This function is the state machine; App.jsx just calls it.
 *
 * The account half of the gate is `accountCount > 0 || onboardingComplete`,
 * not `accountCount > 0` alone. Quick load only reads accounts.json
 * (`db.getAccountsWithoutPasswords()`), so a keychain-only install — an
 * older install that stores accounts only in the OS keychain — reports
 * accountCount === 0 even though the user has a mailbox. `init()` is the
 * only caller of the keychain-inclusive `db.getAccounts()`, and the only
 * path to `ensureAccountsInFile()`, which heals accounts.json for the next
 * launch. Gating `init()` on accountCount alone would strand that install on
 * the loading screen forever — the one call that could raise the count past
 * 0 would never run because the count never rose past 0. Once onboarding is
 * complete there is no tour left to read underneath, so init() should start
 * regardless of what quick load found.
 */
export function shouldStartFullInit({
  initialized = false,
  quickLoadDone = false,
  accountCount = 0,
  onboardingComplete = false,
} = {}) {
  return !initialized && quickLoadDone && (accountCount > 0 || onboardingComplete);
}
