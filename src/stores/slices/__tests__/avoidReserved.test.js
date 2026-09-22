import { describe, it, expect, afterEach, vi } from 'vitest';
import { avoidReserved, vaultDirName } from '../unifiedHelpers.js';

// Finding 2 (final fix wave): mirrors src-core/src/search_index/text.rs's
// `avoid_reserved` test one-for-one, so the two sanitizers can't drift again.
// This is the pure function only — no navigator/platform gating here, so it
// runs the same on every CI host regardless of OS.
describe('avoidReserved (Win32 reserved-name suffixing, mirrors the Rust side)', () => {
  it('suffixes reserved device names, with or without an extension, any case', () => {
    for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'CON.txt']) {
      const out = avoidReserved(name);
      expect(out).not.toBe(name);
      expect(out.endsWith('_')).toBe(true);
    }
  });

  it('suffixes a trailing dot or space, which Win32 silently strips', () => {
    expect(avoidReserved('Inbox.')).toBe('Inbox._');
    expect(avoidReserved('Inbox ')).toBe('Inbox _');
  });

  it('leaves near-misses and everything else untouched', () => {
    for (const name of ['INBOX', 'Sent', 'CONTRACTS', 'COM', 'COM10', 'Inbox.Spam', '_meta']) {
      expect(avoidReserved(name)).toBe(name);
    }
    expect(avoidReserved('')).toBe('');
  });
});

describe('vaultDirName applies avoidReserved only when the platform reports Windows', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('suffixes a reserved name on a Windows navigator', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows NT 10.0' });
    expect(vaultDirName('CON')).toBe('CON_');
  });

  it('leaves a reserved name untouched on a non-Windows navigator', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' });
    expect(vaultDirName('CON')).toBe('CON');
  });
});
