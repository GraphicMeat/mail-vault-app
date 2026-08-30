import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from '../../src/utils/emailParser.js';

/**
 * `formatRelativeTime` calls `t(...)` but `emailParser.js` never imported it.
 * Rollup treats a free identifier as a global, so the build says nothing and
 * the failure only appears at runtime — as
 * `ReferenceError: Can't find variable: t`, thrown inside render, which the
 * error boundary turns into "Something went wrong. Please restart the app."
 *
 * Chat view is where the demo mailbox first shows a relative timestamp, so the
 * whole screen died there and every step after it failed too.
 */
describe('formatRelativeTime', () => {
  const ago = (ms) => new Date(Date.now() - ms).toISOString();

  it('formats a just-now timestamp', () => {
    expect(formatRelativeTime(ago(10_000))).toBeTruthy();
  });

  it('formats minutes, hours and yesterday without throwing', () => {
    expect(formatRelativeTime(ago(5 * 60_000))).toBeTruthy();
    expect(formatRelativeTime(ago(5 * 3_600_000))).toBeTruthy();
    expect(formatRelativeTime(ago(30 * 3_600_000))).toBeTruthy();
  });

  it('interpolates the count rather than leaving a placeholder', () => {
    expect(formatRelativeTime(ago(5 * 60_000))).not.toContain('{{');
  });
});
