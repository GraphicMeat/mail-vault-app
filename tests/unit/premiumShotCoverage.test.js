import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PREMIUM_FEATURES } from '../../src/data/premiumFeatures.js';
import { PREMIUM_BILLING_PROFILE } from '../../scripts/screenshots/premiumSeed.js';
import { hasPremiumAccess } from '../../src/stores/settingsStore.js';

const shots = readFileSync('scripts/screenshots/shots.js', 'utf8');
const conf = readFileSync('wdio.screenshots.conf.js', 'utf8');

describe('premium screenshot coverage', () => {
  it('captures a shot for every catalog feature that declares one', () => {
    for (const f of PREMIUM_FEATURES) {
      if (!f.shot) continue;
      expect(shots, `no capture step for ${f.shot}`).toContain(`'${f.shot}'`);
    }
  });

  // Without a seeded profile the run photographs the upsell card, which is how
  // the website ended up with no usable premium screenshot at all. A text
  // match on the seed's shape (e.g. `premiumAccess: true` appearing ANYWHERE
  // in the file) would still pass next to a stray `clientAccessGranted: false`
  // — that field outranks the subscription in hasPremiumAccess's own
  // precedence order — so this checks the wiring AND feeds the real seeded
  // object through the app's own gate function instead of guessing at its shape.
  it('seeds an entitled profile so the real UI renders', () => {
    expect(conf).toContain('billingProfile: PREMIUM_BILLING_PROFILE');
    expect(hasPremiumAccess(PREMIUM_BILLING_PROFILE)).toBe(true);
  });

  // An assertion that matches the gate copy passes forever and can never notice
  // entitlement working.
  it('no longer asserts on the premium gate copy', () => {
    expect(shots).not.toContain('timeCapsuleRequiresPremium');
  });
});
