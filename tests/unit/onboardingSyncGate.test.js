// tests/unit/onboardingSyncGate.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const app = readFileSync('src/App.jsx', 'utf8');

describe('initial sync gate', () => {
  // The tour is four screens long. Gating the fetch on the flag means the
  // mailbox only starts loading once the tour ends, and the reader waits twice.
  it('starts the full init once an account exists, not once the tour ends', () => {
    expect(app).toMatch(/if \(!initialized && quickLoadDone && accounts\.length > 0\)/);
  });

  it('keeps the effect subscribed to the account count', () => {
    expect(app).toMatch(/\}, \[initialized, quickLoadDone, accounts\.length\]\);/);
  });
});
