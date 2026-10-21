/**
 * Characterises `decide` with the shared fixture the Rust port
 * (src-core/src/notify_policy.rs) must match. `local` is wall-clock HH:MM,
 * built with the local Date constructor so a case means the same anywhere.
 */
import { describe, it, expect } from 'vitest';
import fixture from '../../../src-core/tests/fixtures/notify-policy-cases.json';
import { decide } from '../notificationPolicy.js';

const at = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 0, 15, h, m).getTime();
};

describe('decide (shared fixture)', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(decide({ ...c.ctx, now: at(c.local) }, c.policy)).toEqual(c.expected);
    });
  }
});
