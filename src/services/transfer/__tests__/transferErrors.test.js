import { describe, it, expect } from 'vitest';
import en from '../../../i18n/locales/en.json';
import { transferErrorKey, TRANSFER_PASSWORD_MIN } from '../transferErrors';

const has = key => key in en || `${key}_other` in en;

describe('transferErrorKey', () => {
  it.each([
    [new Error('E_TRANSFER_DECRYPT'), 'settings.transfer.errors.decrypt'],
    [new Error('E_TRANSFER_FORMAT: bad magic'), 'settings.transfer.errors.format'],
    // Tauri rejects an Err(String) with the bare string, not an Error.
    ['E_TRANSFER_READ: No such file or directory', 'settings.transfer.errors.read'],
    ['E_TRANSFER_FORMAT: not a .mvtransfer file', 'settings.transfer.errors.format'],
    [new Error('E_KEYCHAIN_UNAVAILABLE'), 'settings.transfer.errors.keychain'],
    [new Error('E_KEYCHAIN_WRITE: disk full'), 'settings.transfer.errors.keychainWrite'],
  ])('maps %s by prefix', (err, key) => {
    expect(transferErrorKey(err)).toEqual({ key, values: {} });
    expect(has(key)).toBe(true);
  });

  it('names the accounts without a password', () => {
    expect(transferErrorKey(new Error('E_TRANSFER_INCOMPLETE: a@x.test, b@y.test')))
      .toEqual({ key: 'settings.transfer.errors.incomplete', values: { emails: 'a@x.test, b@y.test' } });
  });

  it('shows the length rule for a too-short password', () => {
    expect(transferErrorKey(new Error('E_TRANSFER_PASSWORD: too short')))
      .toEqual({ key: 'settings.transfer.passwordHint', values: { count: TRANSFER_PASSWORD_MIN } });
    expect(TRANSFER_PASSWORD_MIN).toBe(12);
  });

  it.each([
    [new Error('errors.daemonUnavailable'), 'errors.daemonUnavailable'],
    [new Error('errors.daemonOutdated'), 'errors.daemonOutdated'],
  ])('maps a raw Tauri-layer daemon key %s to itself, not the generic wrapper', (err, key) => {
    expect(transferErrorKey(err)).toEqual({ key, values: {} });
    expect(has(key)).toBe(true);
  });

  it('keeps the "may already be added" wording for a daemon failure during apply', () => {
    expect(transferErrorKey(new Error('errors.daemonUnavailable'), { applying: true }).key).toBe('settings.transfer.errors.partial');
    expect(transferErrorKey(new Error('errors.daemonOutdated'), { applying: true }).key).toBe('settings.transfer.errors.partial');
  });

  it('falls back to the generic message', () => {
    expect(transferErrorKey(new Error('daemon gone'))).toEqual({ key: 'settings.transfer.errors.generic', values: { message: 'daemon gone' } });
    expect(transferErrorKey(undefined).key).toBe('settings.transfer.errors.generic');
  });

  // Once saveAccounts has run, only an unavailable keychain means nothing was written.
  it('never claims nothing was imported once the apply step failed', () => {
    expect(transferErrorKey(new Error('E_KEYCHAIN_UNAVAILABLE'), { applying: true }).key).toBe('settings.transfer.errors.keychain');
    expect(transferErrorKey(new Error('E_KEYCHAIN_WRITE: x'), { applying: true }).key).toBe('settings.transfer.errors.keychainWrite');
    expect(transferErrorKey(new Error('E_TRANSFER_FORMAT: appConfig'), { applying: true }))
      .toEqual({ key: 'settings.transfer.errors.partial', values: { message: 'E_TRANSFER_FORMAT: appConfig' } });
    expect(has('settings.transfer.errors.partial')).toBe(true);
    expect(has('settings.transfer.errors.generic')).toBe(true);
    expect(has('settings.transfer.errors.incomplete')).toBe(true);
    expect(has('settings.transfer.passwordHint')).toBe(true);
  });
});
