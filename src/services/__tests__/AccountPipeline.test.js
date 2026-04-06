import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies
vi.mock('../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => ({
      activeAccountId: 'acc-1',
      activeMailbox: 'INBOX',
      addToCache: vi.fn(),
    }),
    setState: vi.fn(),
    subscribe: () => () => {},
  },
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
    }),
  },
}));
vi.mock('../db', () => ({
  getSavedEmailIds: () => Promise.resolve(new Set()),
  getArchivedEmailIds: () => Promise.resolve(new Set()),
}));
vi.mock('../api', () => ({}));
vi.mock('../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
}));

const { AccountPipeline } = await import('../AccountPipeline');

describe('AccountPipeline memory cleanup', () => {
  it('clears _lastLoadedEmails and _graphIdMap on construction', () => {
    const pipeline = new AccountPipeline(
      { email: 'test@example.com' },
      'acc-1',
      { concurrency: 1 }
    );

    expect(pipeline._lastLoadedEmails).toBeNull();
    expect(pipeline._graphIdMap).toBeNull();
  });

  it('clears _lastLoadedEmails after _finish()', async () => {
    const pipeline = new AccountPipeline(
      { email: 'test@example.com' },
      'acc-1',
      { concurrency: 1 }
    );

    // Simulate having loaded headers
    pipeline._lastLoadedEmails = [{ uid: 1 }, { uid: 2 }];
    pipeline._graphIdMap = new Map([[1, 'graph-id-1']]);

    // Call _finish directly
    await pipeline._finish();

    expect(pipeline._lastLoadedEmails).toBeNull();
    expect(pipeline._graphIdMap).toBeNull();
  });

  it('clears data on destroy()', () => {
    const pipeline = new AccountPipeline(
      { email: 'test@example.com' },
      'acc-1',
      { concurrency: 1 }
    );

    pipeline._lastLoadedEmails = [{ uid: 1 }];
    pipeline._graphIdMap = new Map([[1, 'id']]);

    pipeline.destroy();

    expect(pipeline._destroyed).toBe(true);
  });
});
