// Fix round 1 (task-B2-review.md, Important): a byte/case comparison of a
// Google id_token's `email` claim against the typed address rejected real
// Gmail sign-ins whenever the two differed by dots, a `+tag`, or the
// gmail.com/googlemail.com domain alias — all the same inbox to Gmail.
import { describe, it, expect } from 'vitest';
import { normalizeEmailIdentity } from '../emailIdentity';

describe('normalizeEmailIdentity', () => {
  it('drops dots from the local part on gmail.com', () => {
    expect(normalizeEmailIdentity('john.doe@gmail.com')).toBe(normalizeEmailIdentity('johndoe@gmail.com'));
    expect(normalizeEmailIdentity('j.o.h.n@gmail.com')).toBe('john@gmail.com');
  });

  it('drops a +tag suffix on gmail.com', () => {
    expect(normalizeEmailIdentity('john+news@gmail.com')).toBe(normalizeEmailIdentity('john@gmail.com'));
    expect(normalizeEmailIdentity('john.doe+work@gmail.com')).toBe('johndoe@gmail.com');
  });

  it('unifies googlemail.com onto gmail.com', () => {
    expect(normalizeEmailIdentity('john.doe@googlemail.com')).toBe(normalizeEmailIdentity('johndoe@gmail.com'));
  });

  it('is case-insensitive', () => {
    expect(normalizeEmailIdentity('John.Doe@Gmail.COM')).toBe('johndoe@gmail.com');
    expect(normalizeEmailIdentity('SOMEONE@Example.COM')).toBe('someone@example.com');
  });

  it('leaves dots and +tags alone on a non-Gmail domain', () => {
    // Dots and plus-addressing are not provably meaningless anywhere else,
    // so only Gmail's two domains fold them.
    expect(normalizeEmailIdentity('john.doe@example.com')).not.toBe(normalizeEmailIdentity('johndoe@example.com'));
    expect(normalizeEmailIdentity('john+news@example.com')).not.toBe(normalizeEmailIdentity('john@example.com'));
    expect(normalizeEmailIdentity('John.Doe@Example.com')).toBe('john.doe@example.com');
  });

  it('handles missing or malformed input without throwing', () => {
    expect(normalizeEmailIdentity('')).toBe('');
    expect(normalizeEmailIdentity(null)).toBe('');
    expect(normalizeEmailIdentity(undefined)).toBe('');
    expect(normalizeEmailIdentity('not-an-email')).toBe('not-an-email');
  });
});
