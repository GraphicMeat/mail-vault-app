import { describe, it, expect } from 'vitest';
import cases from '../../../../src-core/tests/fixtures/vault_dir_names.json';
import { vaultDirName, avoidReserved, isWindowsPlatform } from '../unifiedHelpers.js';

// The index stores sanitized vault directory names written by Rust, and the
// frontend maps them back with this function. One fixture, both languages.
// The fixture holds the unix names; on Windows both sides add the Win32
// reserved-name step on top (`...` -> `..._`), as the Rust test does.
describe('vaultDirName agrees with the Rust sanitizer', () => {
  it.each(cases)('%s -> %s', (input, want) => {
    expect(vaultDirName(input)).toBe(isWindowsPlatform() ? avoidReserved(want) : want);
  });
});
