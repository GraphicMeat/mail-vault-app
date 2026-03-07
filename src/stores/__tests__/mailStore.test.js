import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub browser globals that mailStore uses at module level
if (!globalThis.window) {
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
} else {
  // Ensure addEventListener exists even in restricted environments
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

// Mock all heavy dependencies before importing the store
vi.mock('../../services/db', () => ({}));
vi.mock('../../services/api', () => ({}));
vi.mock('../../services/authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
}));
vi.mock('../../services/attachmentUtils', () => ({
  hasRealAttachments: () => false,
}));
vi.mock('../../utils/emailParser', () => ({
  buildThreads: () => new Map(),
}));
vi.mock('../settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      getLastMailbox: () => 'INBOX',
      emailListStyle: 'default',
    }),
  },
}));
vi.mock('../safeStorage', () => ({
  safeStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
}));

const { useMailStore } = await import('../mailStore');

// Helper: create a fake email with a predictable size
function fakeEmail(uid, sizeKB = 10) {
  return {
    uid,
    subject: 'Test email ' + uid,
    from: 'test@example.com',
    to: 'user@example.com',
    date: new Date().toISOString(),
    html: 'x'.repeat(sizeKB * 1024),
    attachments: [],
  };
}

function fakeEmailWithHeavyFields(uid) {
  return {
    uid,
    subject: 'Heavy email',
    from: 'test@example.com',
    to: 'user@example.com',
    rawSource: 'a'.repeat(50000),
    attachments: [
      { filename: 'doc.pdf', contentType: 'application/pdf', content: 'base64data' },
      { filename: 'img.png', contentType: 'image/png', content: 'moredata' },
    ],
  };
}

describe('mailStore email cache', () => {
  beforeEach(() => {
    const store = useMailStore.getState();
    store.emailCache.clear();
    useMailStore.setState({ cacheCurrentSizeMB: 0 });
  });

  it('adds an email to the cache', () => {
    const store = useMailStore.getState();
    store.addToCache('acc1-INBOX-1', fakeEmail(1), 128);

    expect(store.emailCache.size).toBe(1);
    expect(store.emailCache.has('acc1-INBOX-1')).toBe(true);
  });

  it('strips rawSource before caching', () => {
    const store = useMailStore.getState();
    store.addToCache('acc1-INBOX-1', fakeEmailWithHeavyFields(1), 128);

    const cached = store.emailCache.get('acc1-INBOX-1');
    expect(cached.email.rawSource).toBeUndefined();
  });

  it('strips attachment content but keeps metadata', () => {
    const store = useMailStore.getState();
    store.addToCache('acc1-INBOX-1', fakeEmailWithHeavyFields(1), 128);

    const cached = store.emailCache.get('acc1-INBOX-1');
    expect(cached.email.attachments).toHaveLength(2);
    expect(cached.email.attachments[0].filename).toBe('doc.pdf');
    expect(cached.email.attachments[0].content).toBeUndefined();
    expect(cached.email.attachments[1].content).toBeUndefined();
  });

  it('evicts oldest entries when cache limit is exceeded', () => {
    const store = useMailStore.getState();
    // Each email is ~100KB. With a 0.2MB limit, only ~2 fit.
    store.addToCache('key-1', fakeEmail(1, 100), 0.2);
    store.addToCache('key-2', fakeEmail(2, 100), 0.2);
    store.addToCache('key-3', fakeEmail(3, 100), 0.2);

    // Oldest (key-1) should have been evicted
    expect(store.emailCache.has('key-1')).toBe(false);
    expect(store.emailCache.has('key-3')).toBe(true);
  });

  it('treats cacheLimitMB=0 as unlimited (capped at 4096)', () => {
    const store = useMailStore.getState();
    for (let i = 0; i < 10; i++) {
      store.addToCache(`key-${i}`, fakeEmail(i, 10), 0);
    }
    expect(store.emailCache.size).toBe(10);
  });

  it('re-caching a key moves it to end (LRU)', () => {
    const store = useMailStore.getState();
    // First, add enough entries to fill cache, then verify LRU ordering.
    // Use a generous limit (10MB) and add 3 entries of ~1MB each.
    store.addToCache('lru-1', fakeEmail(201, 1024), 10);
    store.addToCache('lru-2', fakeEmail(202, 1024), 10);

    // Re-cache lru-1 — it should now be the newest (moved to end of Map)
    store.addToCache('lru-1', fakeEmail(201, 1024), 10);

    // Verify insertion order: lru-2 should be first (oldest), lru-1 should be last
    const keys = [...store.emailCache.keys()];
    expect(keys[0]).toBe('lru-2');
    expect(keys[keys.length - 1]).toBe('lru-1');
  });

  it('estimateEmailSizeMB returns a reasonable value', () => {
    const store = useMailStore.getState();
    const email = fakeEmail(1, 100); // ~100KB
    const size = store.estimateEmailSizeMB(email);
    expect(size).toBeGreaterThan(0.05);
    expect(size).toBeLessThan(0.2);
  });

  it('does not mutate original email when stripping fields', () => {
    const store = useMailStore.getState();
    const original = fakeEmailWithHeavyFields(1);
    store.addToCache('key-1', original, 128);

    // Original should still have rawSource and attachment content
    expect(original.rawSource).toBeDefined();
    expect(original.attachments[0].content).toBe('base64data');
  });
});

describe('mailStore initial state', () => {
  it('has empty emailCache on creation', () => {
    const store = useMailStore.getState();
    expect(store.emailCache).toBeInstanceOf(Map);
  });

  it('has exportProgress state for export/import tracking', () => {
    const store = useMailStore.getState();
    expect(store.exportProgress).toBeNull();
    expect(typeof store.setExportProgress).toBe('function');
    expect(typeof store.dismissExportProgress).toBe('function');
  });

  it('setExportProgress and dismissExportProgress work', () => {
    const store = useMailStore.getState();
    store.setExportProgress({ total: 100, completed: 50, active: true, mode: 'export' });
    expect(useMailStore.getState().exportProgress).toEqual({
      total: 100, completed: 50, active: true, mode: 'export',
    });

    store.dismissExportProgress();
    expect(useMailStore.getState().exportProgress).toBeNull();
  });
});
