import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PREMIUM_FEATURES } from '../../src/data/premiumFeatures.js';

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
  // the website ended up with no usable premium screenshot at all.
  it('seeds an entitled profile so the real UI renders', () => {
    expect(conf).toMatch(/billingProfile:\s*\{[^}]*hasSubscription:\s*true/s);
    expect(conf).toMatch(/premiumAccess:\s*true/);
  });

  // An assertion that matches the gate copy passes forever and can never notice
  // entitlement working.
  it('no longer asserts on the premium gate copy', () => {
    expect(shots).not.toContain('timeCapsuleRequiresPremium');
  });
});
