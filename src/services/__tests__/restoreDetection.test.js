import { describe, it, expect, vi } from 'vitest';

// Mock the store/api dependencies so importing restoreDetection.js does not pull
// in the real store chain (which reads window.__TAURI__ at module-eval time and
// crashes under the node test environment). The pure heuristic needs none of it.
vi.mock('../api.js', () => ({
  countLocalFolder: vi.fn(),
  checkMailboxStatus: vi.fn(),
}));
vi.mock('../../stores/accountStore.js', () => ({
  getMailboxes: vi.fn(() => []),
}));
vi.mock('../../stores/settingsStore.js', () => ({
  useSettingsStore: { getState: () => ({ setRestoreDetected: vi.fn() }) },
}));

const { shouldPromptRestore } = await import('../restoreDetection.js');

describe('shouldPromptRestore', () => {
  it('prompts when host changed and server is near-empty vs local', () => {
    expect(shouldPromptRestore({
      hostChanged: true, localTotal: 500, serverTotal: 0,
    })).toBe(true);
    expect(shouldPromptRestore({
      hostChanged: true, localTotal: 500, serverTotal: 10,
    })).toBe(true);
  });

  it('does not prompt without a host change', () => {
    expect(shouldPromptRestore({
      hostChanged: false, localTotal: 500, serverTotal: 0,
    })).toBe(false);
  });

  it('does not prompt for trivially small local mailboxes', () => {
    expect(shouldPromptRestore({
      hostChanged: true, localTotal: 5, serverTotal: 0,
    })).toBe(false);
  });

  it('does not prompt when the server already has the mail', () => {
    expect(shouldPromptRestore({
      hostChanged: true, localTotal: 500, serverTotal: 480,
    })).toBe(false);
  });
});
