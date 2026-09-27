// Shared fixture with src-core/src/notes_to_self.rs's `normalize_identity`
// (Notes to Self detection, Track I): one table of cases, both languages,
// so the JS and Rust normalizers can never drift apart.
import { describe, it, expect } from 'vitest';
import cases from '../../../src-core/tests/fixtures/email-identity-cases.json';
import { normalizeEmailIdentity } from '../emailIdentity';

describe('normalizeEmailIdentity agrees with the Rust normalize_identity fixture', () => {
  it.each(cases.cases)('$name', ({ input, expected }) => {
    expect(normalizeEmailIdentity(input)).toBe(expected);
  });
});
