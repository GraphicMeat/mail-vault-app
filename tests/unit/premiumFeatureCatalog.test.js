import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PREMIUM_FEATURES } from '../../src/data/premiumFeatures.js';

// The tab ids live in a JSX file this spec must not import (it would drag the
// whole settings tree into jsdom), so read them out of the source instead.
const settingsSource = readFileSync('src/components/SettingsPage.jsx', 'utf8');
const TAB_IDS = [...settingsSource.matchAll(/\{\s*id:\s*'([a-z-]+)'/g)].map(m => m[1]);

describe('premium feature catalog', () => {
  it('covers every premium feature the product sells', () => {
    expect(PREMIUM_FEATURES.map(f => f.id)).toEqual([
      'backup-schedule', 'backup-health', 'cleanup', 'time-capsule',
      'tracker-blocking', 'auto-cleanup', 'migration', 'server-change',
      'export-image', 'devices',
    ]);
  });

  // A renamed settings tab otherwise leaves an Open button that navigates nowhere.
  it('only deep-links to tabs that exist', () => {
    expect(TAB_IDS.length).toBeGreaterThan(5);
    for (const f of PREMIUM_FEATURES) {
      if (f.tab === null) continue;
      expect(TAB_IDS, `${f.id} points at a missing tab`).toContain(f.tab);
    }
  });

  it('gives every entry the copy keys and an icon', () => {
    for (const f of PREMIUM_FEATURES) {
      expect(f.titleKey).toMatch(/^premium\.[a-zA-Z]+\.title$/);
      expect(f.blurbKey).toMatch(/^premium\.[a-zA-Z]+\.blurb$/);
      expect(typeof f.icon).not.toBe('undefined');
    }
  });

  // The gallery resolves an asset per shot; a duplicate would silently show
  // one feature's screenshot under another feature's title.
  it('has unique, unique-per-feature shot names', () => {
    const shots = PREMIUM_FEATURES.map(f => f.shot).filter(Boolean);
    expect(new Set(shots).size).toBe(shots.length);
    expect(shots).toHaveLength(9);
  });
});
