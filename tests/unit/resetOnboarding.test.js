import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const help = readFileSync('src/components/settings/HelpSettings.jsx', 'utf8');
const storage = readFileSync('src/stores/safeStorage.js', 'utf8');

describe('reset onboarding', () => {
  // The reload is the bug: safeStorage debounces the disk write, so a reload
  // on the next line throws the write away and the flag reads back true.
  it('does not reload the page after flipping the flag', () => {
    expect(help).toContain('setOnboardingComplete(false)');
    expect(help).not.toMatch(/window\.location\.reload/);
  });

  it('still writes through a debounced store, so the reload can never come back', () => {
    expect(storage).toMatch(/setTimeout\(saveToDisk, \d+\)/);
  });
});
