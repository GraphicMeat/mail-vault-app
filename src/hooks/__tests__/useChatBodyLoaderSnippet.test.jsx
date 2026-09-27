// @vitest-environment jsdom
//
// Download modes (H5): a thread or chat message with no body on this computer
// shows the search index's snippet while its body downloads. The loader puts
// it on the still-loading entry as `snippet`, never as `email`, so a reply or
// forward still resolves the real body (replyTarget gets `loaded: null`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';

const mockGetLocalEmailLight = vi.fn();
const mockGetEmailHeadersByUids = vi.fn();
const mockFetchEmailLight = vi.fn();

vi.mock('../../services/db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getEmailHeadersByUids: (...a) => mockGetEmailHeadersByUids(...a),
}));
vi.mock('../../services/api', () => ({
  fetchEmailLight: (...a) => mockFetchEmailLight(...a),
  graphGetMessage: vi.fn(),
  graphCacheMime: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/authUtils', () => ({ ensureFreshToken: async (a) => a }));
vi.mock('../../services/attachmentUtils', () => ({ hydrateInlineImages: async (e) => e }));

const store = {
  accounts: [{ id: 'acc1', email: 'me@example.test' }],
  getFromCache: () => null,
  addToCache: vi.fn(),
};
vi.mock('../../stores/mailStore', () => ({
  useMailStore: { getState: () => store },
  getGraphMessageId: () => null,
  graphMessageToEmail: (m) => m,
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ cacheLimitMB: 100 }) },
}));
vi.mock('../../stores/slices/unifiedHelpers', async () => {
  const actual = await vi.importActual('../../stores/slices/unifiedHelpers');
  return { ...actual, resolveEmailLocation: () => ({ accountId: 'acc1', mailbox: 'INBOX' }) };
});

const { useChatBodyLoader, emailKey } = await import('../useChatBodyLoader');

const ROW_A = { uid: 4, _accountId: 'acc1', subject: 'Lunch', messageId: '<a@x>' };
const ROW_B = { uid: 5, _accountId: 'acc1', subject: 'Re: Lunch', messageId: '<b@x>', previewText: 'From the row' };

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

describe('useChatBodyLoader: index snippet while a body downloads', () => {
  beforeEach(() => {
    mockGetLocalEmailLight.mockReset().mockResolvedValue(null);
    mockGetEmailHeadersByUids.mockReset().mockImplementation(async (accountId, mailbox, uids) =>
      uids.map(uid => ({ uid, previewText: `snippet of ${uid}` })));
    mockFetchEmailLight.mockReset();
  });
  afterEach(() => cleanup());

  it('puts the snippet on the loading entry, one header read for the folder, then the body replaces it', async () => {
    const bodyA = deferred();
    const bodyB = deferred();
    mockFetchEmailLight.mockImplementation((account, uid) => (uid === 4 ? bodyA.promise : bodyB.promise));
    const { result } = renderHook(() => useChatBodyLoader([ROW_A, ROW_B]));
    const entry = row => result.current.bodiesMapRef.current.get(emailKey(row));

    await waitFor(() => expect(entry(ROW_A)?.snippet).toBe('snippet of 4'));
    expect(entry(ROW_B).snippet).toBe('From the row');
    expect(entry(ROW_A).status).toBe('loading');
    expect(entry(ROW_A).email).toBeNull();
    // Only the row without its own preview is asked for, in one read.
    expect(mockGetEmailHeadersByUids).toHaveBeenCalledTimes(1);
    expect(mockGetEmailHeadersByUids).toHaveBeenCalledWith('acc1', 'INBOX', [4]);

    bodyA.resolve({ ...ROW_A, html: '<p>whole A</p>' });
    await waitFor(() => expect(entry(ROW_A).status).toBe('loaded'));
    expect(entry(ROW_A).email.html).toBe('<p>whole A</p>');
    expect(entry(ROW_A).snippet).toBeUndefined();
    bodyB.resolve({ ...ROW_B, html: '<p>whole B</p>' });
  });

  it('a snippet that lands after the body is dropped', async () => {
    const snippet = deferred();
    mockGetEmailHeadersByUids.mockReturnValue(snippet.promise);
    mockFetchEmailLight.mockResolvedValue({ ...ROW_A, html: '<p>whole A</p>' });
    const { result } = renderHook(() => useChatBodyLoader([ROW_A]));
    const entry = () => result.current.bodiesMapRef.current.get(emailKey(ROW_A));

    await waitFor(() => expect(entry().status).toBe('loaded'));
    snippet.resolve([{ uid: 4, previewText: 'late' }]);
    await new Promise(r => setTimeout(r, 0));
    expect(entry().snippet).toBeUndefined();
    expect(entry().email.html).toBe('<p>whole A</p>');
  });

  it('a body the vault holds never flashes the snippet, even while the vault read is slow', async () => {
    const vault = deferred();
    mockGetLocalEmailLight.mockReturnValue(vault.promise);
    const { result } = renderHook(() => useChatBodyLoader([ROW_A]));
    const entry = () => result.current.bodiesMapRef.current.get(emailKey(ROW_A));

    // The snippet is known, but the vault has not answered yet: nothing shows.
    await waitFor(() => expect(mockGetEmailHeadersByUids).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 0));
    expect(entry().snippet).toBeUndefined();

    vault.resolve({ ...ROW_A, html: '<p>from the vault</p>' });
    await waitFor(() => expect(entry().status).toBe('loaded'));
    expect(entry().snippet).toBeUndefined();
    expect(mockFetchEmailLight).not.toHaveBeenCalled();
  });
});
