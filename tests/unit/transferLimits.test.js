import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GMAIL_LIMIT_DOWN_BYTES,
  GMAIL_DEFAULT_DOWN_BYTES,
  GMAIL_DEFAULT_UP_BYTES,
  isGmailAccount,
  resolveDailyLimitBytes,
} from '../../src/utils/transferLimits';

const MB = 1024 * 1024;
const RUST = readFileSync(new URL('../../src-core/src/transfer_limits.rs', import.meta.url), 'utf8');

/**
 * The daemon owns the daily-limit defaults (`transfer_limits.rs`); the app
 * repeats the two numbers to show them. Read out of the Rust source so the
 * copies cannot drift apart.
 */
describe('Gmail defaults agree with the daemon', () => {
  it('takes the same numbers as src-core/src/transfer_limits.rs', () => {
    const rust = (name) => Number(new RegExp(`pub const ${name}: u64 = (\\d+);`).exec(RUST)?.[1]);
    expect(rust('GMAIL_DEFAULT_DOWN_MB')).toBe(2000);
    expect(GMAIL_DEFAULT_DOWN_BYTES).toBe(rust('GMAIL_DEFAULT_DOWN_MB') * MB);
    expect(GMAIL_DEFAULT_UP_BYTES).toBe(rust('GMAIL_DEFAULT_UP_MB') * MB);
  });

  it('decides "Gmail" by the same host rule as default_limits', () => {
    expect(RUST).toContain('host.contains("gmail") || host.contains("googlemail")');
  });
});

describe('isGmailAccount', () => {
  it('goes by the IMAP host, case-insensitively', () => {
    expect(isGmailAccount({ email: 'a@gmail.com', imapHost: 'imap.gmail.com' })).toBe(true);
    expect(isGmailAccount({ email: 'a@x.example', imapHost: 'IMAP.GoogleMail.com' })).toBe(true);
  });

  it('is true for a Workspace address on Google\'s servers', () => {
    expect(isGmailAccount({ email: 'boss@company.example', imapHost: 'imap.gmail.com' })).toBe(true);
  });

  it('is false for an @gmail.com address on another host, and without a host', () => {
    expect(isGmailAccount({ email: 'a@gmail.com', imapHost: 'mail.example.com' })).toBe(false);
    expect(isGmailAccount({ email: 'a@gmail.com' })).toBe(false);
    expect(isGmailAccount(null)).toBe(false);
  });
});

describe('resolveDailyLimitBytes', () => {
  // The daemon enforces 2000 MB only when "Pause background downloads at daily
  // limit" is ON and the field is empty (`background_down_limit`). With the cap
  // off it enforces nothing, so the banner and the usage bar keep showing
  // Gmail's own limit, 2500 MB down.
  it('is Gmail\'s real limit, 2500 MB down and 500 MB up, while the cap is off', () => {
    expect(resolveDailyLimitBytes({}, true, 'down')).toEqual({ limitBytes: 2500 * MB, isProviderDefault: true });
    expect(resolveDailyLimitBytes(undefined, true, 'down')).toEqual({ limitBytes: 2500 * MB, isProviderDefault: true });
    expect(resolveDailyLimitBytes({ capEnabled: false }, true, 'down')).toEqual({ limitBytes: 2500 * MB, isProviderDefault: true });
    expect(resolveDailyLimitBytes(undefined, true, 'up')).toEqual({ limitBytes: 500 * MB, isProviderDefault: true });
  });

  it('is the 2000 MB default only when the cap is on and the field is empty', () => {
    expect(resolveDailyLimitBytes({ capEnabled: true }, true, 'down')).toEqual({ limitBytes: 2000 * MB, isProviderDefault: true });
    expect(resolveDailyLimitBytes({ capEnabled: true, dailyDownLimitBytes: null }, true, 'down')).toEqual({ limitBytes: 2000 * MB, isProviderDefault: true });
  });

  it('leaves the upload default at 500 MB with the cap on or off', () => {
    expect(resolveDailyLimitBytes({ capEnabled: true }, true, 'up')).toEqual({ limitBytes: 500 * MB, isProviderDefault: true });
    expect(resolveDailyLimitBytes({ capEnabled: false }, true, 'up')).toEqual({ limitBytes: 500 * MB, isProviderDefault: true });
  });

  it('prefers what the user typed, cap on or off, and is unlimited off Gmail', () => {
    expect(resolveDailyLimitBytes({ dailyDownLimitBytes: 123 * MB }, true, 'down')).toEqual({ limitBytes: 123 * MB, isProviderDefault: false });
    expect(resolveDailyLimitBytes({ capEnabled: true, dailyDownLimitBytes: 123 * MB }, true, 'down')).toEqual({ limitBytes: 123 * MB, isProviderDefault: false });
    expect(resolveDailyLimitBytes({}, false, 'down')).toEqual({ limitBytes: null, isProviderDefault: false });
    expect(resolveDailyLimitBytes({ capEnabled: true }, false, 'down')).toEqual({ limitBytes: null, isProviderDefault: false });
  });
});

describe('the two Gmail download figures', () => {
  it('keeps Gmail\'s own limit above the cap default that leaves room for everyday mail', () => {
    expect(GMAIL_LIMIT_DOWN_BYTES).toBe(2500 * MB);
    expect(GMAIL_DEFAULT_DOWN_BYTES).toBeLessThan(GMAIL_LIMIT_DOWN_BYTES);
  });
});
