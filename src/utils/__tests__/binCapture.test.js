import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { binCaptureError } from '../binCapture.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import en from '../../i18n/locales/en.json';

let warn;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('binCaptureError', () => {
  it.each([
    ['fetch', 'errors.E_BIN_CAPTURE_FETCH'],
    ['timeout', 'errors.E_BIN_CAPTURE_TIMEOUT'],
    ['busy', 'errors.E_BIN_CAPTURE_BUSY'],
    ['write', 'errors.E_BIN_CAPTURE_WRITE'],
  ])('maps the %s reason to its own copy and keeps the reason on the error', (reason, key) => {
    const out = binCaptureError(new Error(`E_BIN_CAPTURE:${reason}: x`));
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe(en[key]);
    expect(out.reason).toBe(reason);
  });

  it('gives the four reasons four different messages', () => {
    const messages = ['fetch', 'timeout', 'busy', 'write'].map((r) => binCaptureError(new Error(`E_BIN_CAPTURE:${r}: x`)).message);
    expect(new Set(messages).size).toBe(4);
    for (const m of messages) expect(m).not.toBe(en['errors.E_BIN_CAPTURE']);
  });

  it('reads the reason off a bare string error too', () => {
    const out = binCaptureError('E_BIN_CAPTURE:timeout: timed out after 45s');
    expect(out.message).toBe(en['errors.E_BIN_CAPTURE_TIMEOUT']);
    expect(out.reason).toBe('timeout');
  });

  it('maps an unknown reason to the generic copy', () => {
    const out = binCaptureError(new Error('E_BIN_CAPTURE:disk-on-fire: x'));
    expect(out.message).toBe(en['errors.E_BIN_CAPTURE']);
    expect(out.reason).toBeUndefined();
  });

  it('maps the legacy prefix, which names no reason, to the generic copy', () => {
    const out = binCaptureError(new Error('E_BIN_CAPTURE: write deleted copy: No space left on device'));
    expect(out.message).toBe(en['errors.E_BIN_CAPTURE']);
    expect(out.reason).toBeUndefined();
  });

  it('never lets the daemon detail reach the user', () => {
    const out = binCaptureError(new Error('E_BIN_CAPTURE:fetch: Server returned no body for UID 1'));
    expect(out.message).not.toContain('UID');
  });

  it('logs the daemon detail for the console', () => {
    binCaptureError(new Error('E_BIN_CAPTURE:fetch: Server returned no body for UID 1'));
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0].join(' '))).toContain('Server returned no body for UID 1');
  });

  it('returns an error that is not a capture refusal unchanged', () => {
    const other = new Error('errors.keychainBusy');
    expect(binCaptureError(other)).toBe(other);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns a non-string, non-error value unchanged', () => {
    const odd = { code: 5 };
    expect(binCaptureError(odd)).toBe(odd);
    expect(binCaptureError(undefined)).toBeUndefined();
  });
});

describe('the reason copy in every locale', () => {
  const KEYS = ['FETCH', 'TIMEOUT', 'BUSY', 'WRITE'].map((r) => `errors.E_BIN_CAPTURE_${r}`);
  const dir = resolve(process.cwd(), 'src/i18n/locales');
  const locales = readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'IDENTICAL_OK.json' && n !== 'en.json');

  it('finds the eight translated locales beside English', () => {
    expect(locales.length).toBe(8);
  });

  it.each(KEYS)('%s is translated in every locale, not copied from English', (key) => {
    expect(en[key]).toBeTruthy();
    for (const name of locales) {
      const catalog = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      expect(catalog[key], `${name} ${key}`).toBeTruthy();
      expect(catalog[key], `${name} ${key}`).not.toBe(en[key]);
    }
  });

  it('the write copy covers reading local storage too (the daemon files a failed read of its own copy under the write reason)', () => {
    expect(en['errors.E_BIN_CAPTURE_WRITE']).toMatch(/read or write/);
  });

  it('gives English four different copies, each saying the email was not deleted', () => {
    expect(new Set(KEYS.map((k) => en[k])).size).toBe(4);
    for (const k of KEYS) expect(en[k]).toMatch(/not deleted\.$/);
  });
});
