import { describe, it, expect } from 'vitest';
import { decide, reasonI18nKey } from '../notificationPolicy.js';

// `now` is always built with the local Date constructor (never a raw epoch
// literal) so "23:30 is inside 22:00-07:00" means the same thing on every
// machine and in CI, whatever its timezone is.
const at = (h, m = 0) => new Date(2026, 0, 15, h, m).getTime();

const basePolicy = () => ({
  enabled: true,
  accounts: {},
  mutedViewIds: [],
  importantSenders: [],
});

describe('decide — notification policy precedence', () => {
  it('focus-hold beats everything, even an allowlisted sender', () => {
    const policy = { ...basePolicy(), importantSenders: [{ match: 'boss@example.com' }] };
    const result = decide({ accountId: 'a1', folder: 'INBOX', from: 'boss@example.com', now: at(12), focusHeld: true }, policy);
    expect(result).toEqual({ deliver: false, reason: 'focus-hold' });
  });

  it('priority-allowlist beats account-muted', () => {
    const policy = {
      ...basePolicy(),
      accounts: { a1: { enabled: false, folders: ['INBOX'] } },
      importantSenders: [{ match: 'boss@example.com' }],
    };
    const result = decide({ accountId: 'a1', folder: 'INBOX', from: 'boss@example.com', now: at(12) }, policy);
    expect(result).toEqual({ deliver: true, reason: 'priority-allowlist' });
  });

  it('priority-allowlist beats folder-not-watched', () => {
    const policy = {
      ...basePolicy(),
      accounts: { a1: { enabled: true, folders: ['INBOX'] } },
      importantSenders: [{ match: 'boss@example.com' }],
    };
    const result = decide({ accountId: 'a1', folder: 'Sent', from: 'boss@example.com', now: at(12) }, policy);
    expect(result).toEqual({ deliver: true, reason: 'priority-allowlist' });
  });

  it('priority-allowlist beats quiet hours when the entry does not say throughQuietHours (defaults true)', () => {
    const policy = {
      ...basePolicy(),
      accounts: { a1: { enabled: true, folders: ['INBOX'], quietHours: { enabled: true, start: '22:00', end: '07:00' } } },
      importantSenders: [{ match: 'boss@example.com' }],
    };
    const result = decide({ accountId: 'a1', folder: 'INBOX', from: 'boss@example.com', now: at(23, 30) }, policy);
    expect(result).toEqual({ deliver: true, reason: 'priority-allowlist' });
  });

  it('priority-allowlist yields to quiet hours ONLY when the entry sets throughQuietHours: false', () => {
    const policy = {
      ...basePolicy(),
      accounts: { a1: { enabled: true, folders: ['INBOX'], quietHours: { enabled: true, start: '22:00', end: '07:00' } } },
      importantSenders: [{ match: 'boss@example.com', throughQuietHours: false }],
    };
    const result = decide({ accountId: 'a1', folder: 'INBOX', from: 'boss@example.com', now: at(23, 30) }, policy);
    expect(result).toEqual({ deliver: false, reason: 'quiet-hours' });
  });

  it('allowlist matches a bare domain, case-insensitively', () => {
    const policy = { ...basePolicy(), importantSenders: [{ match: 'Example.COM' }] };
    const result = decide({ accountId: 'a1', folder: 'INBOX', from: 'new@example.com', domain: 'example.com', now: at(12) }, policy);
    expect(result).toEqual({ deliver: true, reason: 'priority-allowlist' });
  });

  it('quiet hours crossing midnight: suppresses at 23:30 and at 06:00', () => {
    const policy = { ...basePolicy(), accounts: { a1: { enabled: true, folders: ['INBOX'], quietHours: { enabled: true, start: '22:00', end: '07:00' } } } };
    expect(decide({ accountId: 'a1', folder: 'INBOX', now: at(23, 30) }, policy)).toEqual({ deliver: false, reason: 'quiet-hours' });
    expect(decide({ accountId: 'a1', folder: 'INBOX', now: at(6, 0) }, policy)).toEqual({ deliver: false, reason: 'quiet-hours' });
  });

  it('quiet hours crossing midnight: delivers at noon, outside the window', () => {
    const policy = { ...basePolicy(), accounts: { a1: { enabled: true, folders: ['INBOX'], quietHours: { enabled: true, start: '22:00', end: '07:00' } } } };
    const result = decide({ accountId: 'a1', folder: 'INBOX', now: at(12) }, policy);
    expect(result).toEqual({ deliver: true, reason: 'delivered-default' });
  });

  it('quiet hours within one day (09:00-17:00) suppress inside and deliver outside', () => {
    const policy = { ...basePolicy(), accounts: { a1: { enabled: true, folders: ['INBOX'], quietHours: { enabled: true, start: '09:00', end: '17:00' } } } };
    expect(decide({ accountId: 'a1', folder: 'INBOX', now: at(10) }, policy).reason).toBe('quiet-hours');
    expect(decide({ accountId: 'a1', folder: 'INBOX', now: at(20) }, policy).reason).toBe('delivered-default');
  });

  it('a disabled quiet-hours window never suppresses', () => {
    const policy = { ...basePolicy(), accounts: { a1: { enabled: true, folders: ['INBOX'], quietHours: { enabled: false, start: '00:00', end: '23:59' } } } };
    const result = decide({ accountId: 'a1', folder: 'INBOX', now: at(12) }, policy);
    expect(result).toEqual({ deliver: true, reason: 'delivered-default' });
  });

  it('view-muted beats folder-not-watched', () => {
    const policy = { ...basePolicy(), accounts: { a1: { enabled: true, folders: ['INBOX'] } }, mutedViewIds: ['view-1'] };
    const result = decide({ accountId: 'a1', folder: 'Sent', viewIds: ['view-1'], now: at(12) }, policy);
    expect(result).toEqual({ deliver: false, reason: 'view-muted' });
  });

  it('folder-not-watched fires when the view is not muted', () => {
    const policy = { ...basePolicy(), accounts: { a1: { enabled: true, folders: ['INBOX'] } }, mutedViewIds: ['view-1'] };
    const result = decide({ accountId: 'a1', folder: 'Sent', viewIds: ['view-2'], now: at(12) }, policy);
    expect(result).toEqual({ deliver: false, reason: 'folder-not-watched' });
  });

  it('account-muted when the account is configured but disabled', () => {
    const policy = { ...basePolicy(), accounts: { a1: { enabled: false, folders: ['INBOX'] } } };
    const result = decide({ accountId: 'a1', folder: 'INBOX', now: at(12) }, policy);
    expect(result).toEqual({ deliver: false, reason: 'account-muted' });
  });

  it('notifications-off when the master switch is off, even for a configured+enabled account', () => {
    const policy = { ...basePolicy(), enabled: false, accounts: { a1: { enabled: true, folders: ['INBOX'] } } };
    const result = decide({ accountId: 'a1', folder: 'INBOX', now: at(12) }, policy);
    expect(result).toEqual({ deliver: false, reason: 'notifications-off' });
  });

  it('an important sender does not punch through the master switch', () => {
    // Turning notifications off means silence, not silence with exceptions
    // the user has to remember they configured.
    const policy = {
      ...basePolicy(),
      enabled: false,
      importantSenders: [{ match: 'boss@corp.example', throughQuietHours: true }],
    };
    const result = decide({ accountId: 'a1', folder: 'INBOX', from: 'boss@corp.example', now: at(10) }, policy);
    expect(result).toEqual({ deliver: false, reason: 'notifications-off' });
  });

  it('an unconfigured account still defaults to enabled INBOX (today\'s behavior)', () => {
    const policy = basePolicy();
    const result = decide({ accountId: 'unknown-account', folder: 'INBOX', now: at(12) }, policy);
    expect(result).toEqual({ deliver: true, reason: 'delivered-default' });
  });

  it('delivers by default for a configured, enabled, watched folder', () => {
    const policy = { ...basePolicy(), accounts: { a1: { enabled: true, folders: ['INBOX', 'Sent'] } } };
    const result = decide({ accountId: 'a1', folder: 'Sent', now: at(12) }, policy);
    expect(result).toEqual({ deliver: true, reason: 'delivered-default' });
  });

  it('maps every reason to an i18n key', () => {
    for (const reason of ['focus-hold', 'priority-allowlist', 'quiet-hours', 'view-muted', 'account-muted', 'folder-not-watched', 'delivered-default']) {
      expect(reasonI18nKey(reason)).toMatch(/^notifyPolicy\.reason\./);
    }
  });
});
