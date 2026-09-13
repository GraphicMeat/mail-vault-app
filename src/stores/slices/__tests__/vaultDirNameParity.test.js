import { describe, it, expect } from 'vitest';
import cases from '../../../../src-core/tests/fixtures/vault_dir_names.json';
import { vaultDirName } from '../unifiedHelpers.js';

// The index stores sanitized vault directory names written by Rust, and the
// frontend maps them back with this function. One fixture, both languages.
describe('vaultDirName agrees with the Rust sanitizer', () => {
  it.each(cases)('%s -> %s', (input, want) => {
    expect(vaultDirName(input)).toBe(want);
  });
});
