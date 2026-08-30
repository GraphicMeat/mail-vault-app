// tests/unit/onboardingSyncGate.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { shouldStartFullInit } from '../../src/utils/shouldStartFullInit.js';

const app = readFileSync('src/App.jsx', 'utf8');

// A regex over App.jsx source cannot catch a state-machine defect: any
// equivalent rewrite of the gate passes a source-grep test just as easily as
// the one it replaced, and a real deadlock (see the keychain-only case
// below) would have passed one too. The decision is a pure function instead,
// covered here by a truth table; App.jsx just calls it (asserted below so
// the extraction can't be silently bypassed by an inline rewrite).
describe('shouldStartFullInit', () => {
  it('fresh install: no accounts yet, tour unfinished — waits', () => {
    expect(shouldStartFullInit({
      initialized: false, quickLoadDone: true, accountCount: 0, onboardingComplete: false,
    })).toBe(false);
  });

  it('account added mid-tour — starts under the remaining screens', () => {
    expect(shouldStartFullInit({
      initialized: false, quickLoadDone: true, accountCount: 1, onboardingComplete: false,
    })).toBe(true);
  });

  // THE BUG: quick load only reads accounts.json (db.getAccountsWithoutPasswords()),
  // so a keychain-only install — an older install with accounts stored only in the
  // OS keychain — reports accountCount 0 forever. init() is the only call that
  // reaches the keychain (db.getAccounts()) and heals accounts.json for next time.
  // Gating on accountCount alone would mean the one thing that could raise the
  // count past 0 never runs, because the count never rose past 0 — an infinite
  // loading spinner with no retry. Once onboarding is complete there is no tour
  // left to read underneath, so init() must start regardless of the count.
  it('keychain-only returning user: 0 accounts, onboarding complete — must still start', () => {
    expect(shouldStartFullInit({
      initialized: false, quickLoadDone: true, accountCount: 0, onboardingComplete: true,
    })).toBe(true);
  });

  it('not yet quick-loaded — waits even with an account and a finished tour', () => {
    expect(shouldStartFullInit({
      initialized: false, quickLoadDone: false, accountCount: 1, onboardingComplete: true,
    })).toBe(false);
  });

  it('already initialized — does not restart', () => {
    expect(shouldStartFullInit({
      initialized: true, quickLoadDone: true, accountCount: 1, onboardingComplete: true,
    })).toBe(false);
  });

  it('App.jsx calls the predicate instead of reimplementing the gate inline', () => {
    expect(app).toMatch(/if \(shouldStartFullInit\(\{ initialized, quickLoadDone, accountCount: accounts\.length, onboardingComplete \}\)\)/);
  });
});
