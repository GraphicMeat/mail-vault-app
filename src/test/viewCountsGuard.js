import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest';

// Detached recounts must finish within their test. Keep failures outside the
// spy's call history so clearAllMocks cannot erase a delayed warning.
export function guardViewCounts() {
  const warnings = [];
  let warn;
  beforeAll(() => {
    const originalWarn = console.warn;
    warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      if (args[0] === '[messageMutations] Could not count the saved views again:') warnings.push(args);
      originalWarn(...args);
    });
  });
  afterEach(() => vi.dynamicImportSettled());
  afterAll(async () => {
    await vi.dynamicImportSettled();
    const { __resetViewCountsForTests } = await import('../stores/viewStore');
    __resetViewCountsForTests();
    warn.mockRestore();
    expect(warnings).toEqual([]);
  });
}
