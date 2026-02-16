import { describe, it, expect } from 'vitest';
import { computeDisplayEmails } from '../../src/services/emailListUtils.js';

// ---------------------------------------------------------------------------
// These tests verify the quick-load → full-init state machine that prevents
// the black screen / "Add Your First Account" flash on app launch.
//
// The flow:
//   1. Quick-load: initBasic() (no keychain) → getAccountsWithoutPasswords()
//      → reads accounts.json → if accounts found, loads cached emails → UI renders
//   2. Full init (2s later): initDB() → loadKeychain() (may prompt) → getAccounts()
//      → backfills accounts.json via ensureAccountInFile() → setActiveAccount()
//
// Key invariants tested:
//   - Quick-load with populated accounts.json → full app UI with cached data
//   - Quick-load with empty accounts.json → branded loading screen (NOT "Add Account")
//   - After full init backfills, subsequent quick-loads find accounts
//   - ensureAccountInFile strips passwords, doesn't duplicate
//   - Display emails work correctly during quick-load (cached headers only)
// ---------------------------------------------------------------------------

const mkEmail = (uid, subject, date) => ({
  uid,
  subject,
  date: date || '2026-02-10T12:00:00Z',
  from: { address: 'luke@forceunwrap.com' },
  flags: ['\\Seen'],
});

const mkAccount = (id, email) => ({
  id,
  email,
  imapServer: 'imap.example.com',
  smtpServer: 'smtp.example.com',
  password: 'secret123',
  createdAt: '2026-01-01T00:00:00Z',
});

// ---------------------------------------------------------------------------
// ensureAccountInFile logic (pure function simulation)
// ---------------------------------------------------------------------------
describe('ensureAccountInFile logic', () => {
  // Simulates the core logic of ensureAccountInFile
  function ensureAccountInFile(existingAccounts, newAccount) {
    if (existingAccounts.some((a) => a.id === newAccount.id)) {
      return existingAccounts; // No change — already present
    }
    const { password, ...acctData } = newAccount;
    return [...existingAccounts, acctData];
  }

  it('adds account to empty file (strips password)', () => {
    const account = mkAccount('abc-123', 'luke@forceunwrap.com');
    const result = ensureAccountInFile([], account);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('abc-123');
    expect(result[0].email).toBe('luke@forceunwrap.com');
    expect(result[0]).not.toHaveProperty('password');
  });

  it('does not duplicate existing account', () => {
    const account = mkAccount('abc-123', 'luke@forceunwrap.com');
    const existing = [{ id: 'abc-123', email: 'luke@forceunwrap.com' }];
    const result = ensureAccountInFile(existing, account);
    expect(result).toHaveLength(1);
    expect(result).toBe(existing); // Same reference — no mutation
  });

  it('adds second account alongside existing', () => {
    const existing = [{ id: 'abc-123', email: 'luke@forceunwrap.com' }];
    const newAccount = mkAccount('def-456', 'vader@forceunwrap.com');
    const result = ensureAccountInFile(existing, newAccount);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('abc-123');
    expect(result[1].id).toBe('def-456');
    expect(result[1]).not.toHaveProperty('password');
  });

  it('backfills multiple accounts from keychain', () => {
    const keychainAccounts = [
      mkAccount('a', 'a@test.com'),
      mkAccount('b', 'b@test.com'),
      mkAccount('c', 'c@test.com'),
    ];
    let file = [];
    for (const account of keychainAccounts) {
      file = ensureAccountInFile(file, account);
    }
    expect(file).toHaveLength(3);
    expect(file.every((a) => !a.password)).toBe(true);
    expect(file.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('skips accounts already in file during backfill', () => {
    const existing = [{ id: 'a', email: 'a@test.com' }];
    const keychainAccounts = [
      mkAccount('a', 'a@test.com'),
      mkAccount('b', 'b@test.com'),
    ];
    let file = existing;
    for (const account of keychainAccounts) {
      file = ensureAccountInFile(file, account);
    }
    expect(file).toHaveLength(2);
    expect(file[0].id).toBe('a');
    expect(file[1].id).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// App rendering state machine
// ---------------------------------------------------------------------------
describe('app rendering state machine', () => {
  // Simulates the render decision in App.jsx
  function getAppScreen({ onboardingComplete, accounts, initialized, quickLoadDone }) {
    if (!onboardingComplete) return 'onboarding';
    if (accounts.length === 0) {
      if (!initialized) return 'loading'; // Branded loading screen
      return 'welcome'; // "Add Your First Account"
    }
    return 'main-app'; // Full UI: Sidebar + EmailList + EmailViewer
  }

  it('shows onboarding if not complete', () => {
    expect(
      getAppScreen({ onboardingComplete: false, accounts: [], initialized: false, quickLoadDone: false })
    ).toBe('onboarding');
  });

  it('shows loading screen before init when accounts.json is empty', () => {
    // Quick-load done but found no accounts, full init not done yet
    expect(
      getAppScreen({ onboardingComplete: true, accounts: [], initialized: false, quickLoadDone: true })
    ).toBe('loading');
  });

  it('shows loading screen before quick-load when accounts.json is empty', () => {
    expect(
      getAppScreen({ onboardingComplete: true, accounts: [], initialized: false, quickLoadDone: false })
    ).toBe('loading');
  });

  it('shows welcome screen only after full init confirms no accounts', () => {
    // Full init done, truly no accounts
    expect(
      getAppScreen({ onboardingComplete: true, accounts: [], initialized: true, quickLoadDone: true })
    ).toBe('welcome');
  });

  it('shows main app when quick-load finds accounts (before full init)', () => {
    // Quick-load found accounts in accounts.json — show cached data immediately
    const accounts = [{ id: 'abc', email: 'luke@forceunwrap.com' }];
    expect(
      getAppScreen({ onboardingComplete: true, accounts, initialized: false, quickLoadDone: true })
    ).toBe('main-app');
  });

  it('shows main app after full init loads accounts from keychain', () => {
    const accounts = [{ id: 'abc', email: 'luke@forceunwrap.com' }];
    expect(
      getAppScreen({ onboardingComplete: true, accounts, initialized: true, quickLoadDone: true })
    ).toBe('main-app');
  });
});

// ---------------------------------------------------------------------------
// Quick-load display emails (cached headers without keychain)
// ---------------------------------------------------------------------------
describe('quick-load display emails', () => {
  it('renders cached server headers during quick-load (all mode)', () => {
    const cachedHeaders = [
      mkEmail(1, 'Email A', '2026-02-15T10:00:00Z'),
      mkEmail(2, 'Email B', '2026-02-14T10:00:00Z'),
      mkEmail(3, 'Email C', '2026-02-13T10:00:00Z'),
    ];
    const result = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: cachedHeaders,
      localEmails: [],
      archivedEmailIds: new Set(),
      viewMode: 'all',
    });
    expect(result).toHaveLength(3);
    expect(result.every((e) => e.source === 'server')).toBe(true);
    expect(result[0].uid).toBe(1); // Newest first
  });

  it('renders local archived emails during quick-load (local mode)', () => {
    const localEmails = [mkEmail(10, 'Archived A'), mkEmail(20, 'Archived B')];
    const result = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: [],
      localEmails,
      archivedEmailIds: new Set([10, 20]),
      viewMode: 'local',
    });
    expect(result).toHaveLength(2);
    // No server emails → can't distinguish, default to 'local' (not 'local-only')
    expect(result.every((e) => e.source === 'local')).toBe(true);
  });

  it('combines cached headers + local emails during quick-load (all mode)', () => {
    const cachedHeaders = [mkEmail(1, 'Server A'), mkEmail(2, 'Server B')];
    const localEmails = [mkEmail(1, 'Also local'), mkEmail(99, 'Deleted from server')];
    const result = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: cachedHeaders,
      localEmails,
      archivedEmailIds: new Set([1, 99]),
      viewMode: 'all',
    });
    // uid 1 from server + uid 99 as local-only
    expect(result).toHaveLength(3);
    expect(result.find((e) => e.uid === 1).source).toBe('server');
    expect(result.find((e) => e.uid === 99).source).toBe('local-only');
  });

  it('empty state renders nothing (no crash)', () => {
    const result = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: [],
      localEmails: [],
      archivedEmailIds: new Set(),
      viewMode: 'all',
    });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Full init → quick-load backfill lifecycle
// ---------------------------------------------------------------------------
describe('backfill lifecycle', () => {
  // Simulates the full app lifecycle across launches
  function simulateLaunchCycle({ accountsJsonContent, keychainAccounts }) {
    // Phase 1: Quick-load reads accounts.json
    const quickLoadAccounts = [...accountsJsonContent];

    // Phase 2: Full init reads keychain, backfills accounts.json
    let updatedFile = [...accountsJsonContent];
    for (const account of keychainAccounts) {
      if (!updatedFile.some((a) => a.id === account.id)) {
        const { password, ...acctData } = account;
        updatedFile.push(acctData);
      }
    }

    return {
      quickLoadFoundAccounts: quickLoadAccounts.length > 0,
      fileAfterBackfill: updatedFile,
    };
  }

  it('first launch: empty accounts.json, accounts only in keychain', () => {
    const result = simulateLaunchCycle({
      accountsJsonContent: [],
      keychainAccounts: [mkAccount('abc', 'luke@forceunwrap.com')],
    });
    // Quick-load finds nothing → loading screen shown
    expect(result.quickLoadFoundAccounts).toBe(false);
    // After full init, accounts.json is backfilled
    expect(result.fileAfterBackfill).toHaveLength(1);
    expect(result.fileAfterBackfill[0].email).toBe('luke@forceunwrap.com');
    expect(result.fileAfterBackfill[0]).not.toHaveProperty('password');
  });

  it('second launch: accounts.json populated from backfill', () => {
    // Simulates second launch after backfill wrote accounts.json
    const result = simulateLaunchCycle({
      accountsJsonContent: [{ id: 'abc', email: 'luke@forceunwrap.com' }],
      keychainAccounts: [mkAccount('abc', 'luke@forceunwrap.com')],
    });
    // Quick-load finds accounts → main app shown instantly
    expect(result.quickLoadFoundAccounts).toBe(true);
    // No duplicates after backfill
    expect(result.fileAfterBackfill).toHaveLength(1);
  });

  it('new account added between launches', () => {
    const result = simulateLaunchCycle({
      accountsJsonContent: [{ id: 'abc', email: 'luke@forceunwrap.com' }],
      keychainAccounts: [
        mkAccount('abc', 'luke@forceunwrap.com'),
        mkAccount('def', 'vader@forceunwrap.com'),
      ],
    });
    // Quick-load finds first account → main app shown
    expect(result.quickLoadFoundAccounts).toBe(true);
    // Backfill adds the new account
    expect(result.fileAfterBackfill).toHaveLength(2);
    expect(result.fileAfterBackfill[1].email).toBe('vader@forceunwrap.com');
  });

  it('multiple launches converge — no duplicates', () => {
    // Simulate 3 launches
    let file = [];
    const keychain = [mkAccount('a', 'a@test.com'), mkAccount('b', 'b@test.com')];

    for (let launch = 0; launch < 3; launch++) {
      const result = simulateLaunchCycle({
        accountsJsonContent: file,
        keychainAccounts: keychain,
      });
      file = result.fileAfterBackfill;
    }

    expect(file).toHaveLength(2);
    expect(file[0].id).toBe('a');
    expect(file[1].id).toBe('b');
  });
});
