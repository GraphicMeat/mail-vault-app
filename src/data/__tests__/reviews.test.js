import { describe, expect, it } from 'vitest';
import { REVIEWS } from '../reviews.js';

// Reviews are quoted from real people and linked to where they said it. This
// file is the only place that list lives, so the shape is pinned here: a quote
// without a working source link must not reach the onboarding screen.
describe('REVIEWS', () => {
  it('is a list', () => {
    expect(Array.isArray(REVIEWS)).toBe(true);
  });

  it('gives every review a quote, an author, a source name and an https link', () => {
    for (const review of REVIEWS) {
      expect(String(review.quote || '').trim(), review.id).not.toBe('');
      expect(String(review.author || '').trim(), review.id).not.toBe('');
      expect(String(review.source || '').trim(), review.id).not.toBe('');
      expect(() => new URL(review.url), review.id).not.toThrow();
      expect(new URL(review.url).protocol, review.id).toBe('https:');
    }
  });

  it('keeps ids unique and each quote short enough to read at a glance', () => {
    const ids = REVIEWS.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const review of REVIEWS) expect(review.quote.length, review.id).toBeLessThanOrEqual(280);
  });

  it('never quotes in straight double quotes (the card adds its own marks)', () => {
    for (const review of REVIEWS) expect(review.quote, review.id).not.toMatch(/^"|"$/);
  });
});
