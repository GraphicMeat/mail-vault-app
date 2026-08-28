// @vitest-environment jsdom
//
// The vault Maildir is keyed (accountId, mailbox, uid) with no per-file
// generation proof. rare@graphicmeat.com moved to Purelymail, so INBOX uid 4 on
// disk is a March "StrictSeal" mail while the server's uid 4 is an August
// Zendesk reply. The loader spotted the Message-ID mismatch — and then treated
// it as a dead end, so the thread printed the row's SUBJECT in italics where its
// body belongs. The server holds the uid the row was built from; ask it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';

const mockGetLocalEmailLight = vi.fn();
const mockFetchEmailLight = vi.fn();

vi.mock('../../services/db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
}));

vi.mock('../../services/api', () => ({
  fetchEmailLight: (...a) => mockFetchEmailLight(...a),
  graphGetMessage: vi.fn(),
  graphCacheMime: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/authUtils', () => ({
  ensureFreshToken: async (a) => a,
}));

vi.mock('../../services/attachmentUtils', () => ({
  hydrateInlineImages: async (e) => e,
}));

// The body cache the loader consults BEFORE it goes anywhere. Every test here
// left it empty, so the cache-hit branch had never once executed — which is how
// that branch shipped calling a helper the file no longer imported, and threw
// ReferenceError on the first real thread that had a body cached.
let cacheHit = null;
const store = {
  accounts: [{ id: 'acc1', email: 'rare@graphicmeat.com' }],
  getFromCache: () => cacheHit,
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

// The row, as the header cache has it.
const ROW = {
  uid: 4,
  _accountId: 'acc1',
  subject: 'Affiliate program',
  messageId: '<4GX4VJ7EJKN_6a8f0d4c87839_82d252d96f43b4_sprut@zendesk.com>',
};

// What the vault holds under uid 4 — a different message entirely.
const STALE_VAULT_COPY = {
  uid: 4,
  subject: 'Your product is now live on StrictSeal',
  messageId: '<202603192236.72893218187@smtp-relay.mailin.fr>',
  html: '<p>StrictSeal</p>',
};

const SERVER_COPY = {
  uid: 4,
  subject: 'Affiliate program',
  messageId: ROW.messageId,
  html: '<p>Thanks for contacting Blurb Support</p>',
};

const entryFor = (result) => result.current.bodiesMapRef.current.get(emailKey(ROW));

describe('useChatBodyLoader — vault copy under a reissued uid', () => {
  beforeEach(() => {
    mockGetLocalEmailLight.mockReset();
    mockFetchEmailLight.mockReset();
    store.addToCache.mockReset();
    cacheHit = null;
  });
  afterEach(() => cleanup());

  it('refetches from the server when the vault file is another message', async () => {
    mockGetLocalEmailLight.mockResolvedValue(STALE_VAULT_COPY);
    mockFetchEmailLight.mockResolvedValue(SERVER_COPY);

    const { result } = renderHook(() => useChatBodyLoader([ROW]));

    await waitFor(() => expect(entryFor(result)?.status).toBe('loaded'));
    // Not `toBe`: the loader hands back the body with the row's account on it,
    // so a reply to it leaves from the mailbox the message was read in.
    expect(entryFor(result).email).toMatchObject(SERVER_COPY);
    expect(entryFor(result).email._accountId).toBe(ROW._accountId);
    expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
  });

  it('serves the vault copy without a server call when it is this message', async () => {
    mockGetLocalEmailLight.mockResolvedValue(SERVER_COPY);

    const { result } = renderHook(() => useChatBodyLoader([ROW]));

    await waitFor(() => expect(entryFor(result)?.status).toBe('loaded'));
    expect(mockFetchEmailLight).not.toHaveBeenCalled();
  });

  it('serves a cached body that answers for this row, without any read', async () => {
    cacheHit = SERVER_COPY;

    const { result } = renderHook(() => useChatBodyLoader([ROW]));

    expect(entryFor(result).status).toBe('loaded');
    expect(entryFor(result).email).toMatchObject(SERVER_COPY);
    expect(mockGetLocalEmailLight).not.toHaveBeenCalled();
    expect(mockFetchEmailLight).not.toHaveBeenCalled();
  });

  it('ignores a cached body that is another message and loads this one', async () => {
    cacheHit = STALE_VAULT_COPY;
    mockGetLocalEmailLight.mockResolvedValue(SERVER_COPY);

    const { result } = renderHook(() => useChatBodyLoader([ROW]));

    await waitFor(() => expect(entryFor(result)?.status).toBe('loaded'));
    expect(entryFor(result).email).toMatchObject(SERVER_COPY);
  });

  it('still refuses a SERVER body that contradicts the row', async () => {
    mockGetLocalEmailLight.mockResolvedValue(null);
    mockFetchEmailLight.mockResolvedValue(STALE_VAULT_COPY);

    const { result } = renderHook(() => useChatBodyLoader([ROW]));

    await waitFor(() => expect(entryFor(result)?.status).toBe('error'));
    expect(entryFor(result).email).toBeNull();
    // No retry loop: the server already answered for this uid.
    expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
  });
});
