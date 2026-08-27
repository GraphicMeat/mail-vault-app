/**
 * Billing rate limiting.
 *
 * The server answers 429 when a client checks its subscription too often, and
 * the client then refuses to ask again until the window passes. That refusal is
 * module state (`_rateLimitedUntil`), so every case here re-imports the module
 * to get a clean one — a shared instance would let the first 429 decide the
 * result of every test after it.
 *
 * Why it matters: the block is what stops a refresh loop from hammering the
 * billing API, and the message is what the user reads instead of "premium
 * stopped working". Both are easy to break silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
vi.stubGlobal('__TAURI__', undefined);

/** A 429 the way the real server sends it. */
const tooManyRequests = (retryAfter) => ({
  ok: false,
  status: 429,
  headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
  json: () => Promise.resolve({}),
});

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(body) });

let api;
beforeEach(async () => {
  vi.resetModules();
  mockFetch.mockReset();
  api = await import('../../src/services/billingApi.js');
});

const status = () => api.fetchSubscriptionStatus({ customerId: 'cus_test' });

describe('billingApi — 429 handling', () => {
  it('turns a 429 into a BillingRateLimitError, not a generic failure', async () => {
    mockFetch.mockResolvedValueOnce(tooManyRequests('120'));
    await expect(status()).rejects.toBeInstanceOf(api.BillingRateLimitError);
  });

  it('says minutes for a long wait and seconds for a short one', async () => {
    mockFetch.mockResolvedValueOnce(tooManyRequests('120'));
    await expect(status()).rejects.toThrow(/2 minutes/);

    vi.resetModules();
    const fresh = await import('../../src/services/billingApi.js');
    mockFetch.mockResolvedValueOnce(tooManyRequests('30'));
    await expect(fresh.fetchSubscriptionStatus({ customerId: 'c' })).rejects.toThrow(/30 seconds/);
  });

  it('carries the wait as a number the caller can schedule on', async () => {
    mockFetch.mockResolvedValueOnce(tooManyRequests('90'));
    const err = await status().catch(e => e);
    expect(err.retryAfterMs).toBe(90_000);
    expect(err.rateLimitedUntil).toBeGreaterThan(Date.now());
  });

  it('reads the header case-insensitively', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: (n) => (n === 'Retry-After' ? null : n === 'retry-after' ? '120' : null) },
      json: () => Promise.resolve({}),
    });
    await expect(status()).rejects.toThrow(/2 minutes/);
  });
});

describe('billingApi — Retry-After values that cannot be trusted', () => {
  // A server (or a proxy) can send nonsense here. Anything outside 0 < n < 3600
  // falls back to 60s, so a bad header can neither unblock instantly nor lock
  // the user out for an hour.
  it.each([
    ['missing', null],
    ['garbage', 'soon'],
    ['zero', '0'],
    ['negative', '-5'],
    ['an hour or more', '99999'],
  ])('falls back to 60 seconds when Retry-After is %s', async (_label, header) => {
    mockFetch.mockResolvedValueOnce(tooManyRequests(header));
    const err = await status().catch(e => e);
    expect(err).toBeInstanceOf(api.BillingRateLimitError);
    expect(err.retryAfterMs).toBe(60_000);
  });
});

describe('billingApi — the local block after a 429', () => {
  it('refuses the next call without reaching the network', async () => {
    mockFetch.mockResolvedValueOnce(tooManyRequests('120'));
    await expect(status()).rejects.toBeInstanceOf(api.BillingRateLimitError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    await expect(status()).rejects.toBeInstanceOf(api.BillingRateLimitError);
    // The whole point: the second call never left the app.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('blocks every billing endpoint, not just the one that was limited', async () => {
    mockFetch.mockResolvedValueOnce(tooManyRequests('120'));
    await expect(status()).rejects.toBeInstanceOf(api.BillingRateLimitError);

    await expect(api.fetchPricing({ currency: 'eur' })).rejects.toBeInstanceOf(api.BillingRateLimitError);
    await expect(api.createCheckoutSession('a@b.test', {})).rejects.toBeInstanceOf(api.BillingRateLimitError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reports itself as limited, and stops once the window passes', async () => {
    expect(api.isBillingRateLimited()).toBe(false);

    mockFetch.mockResolvedValueOnce(tooManyRequests('120'));
    await expect(status()).rejects.toBeInstanceOf(api.BillingRateLimitError);
    expect(api.isBillingRateLimited()).toBe(true);
    expect(api.getBillingRateLimitedUntil()).toBeGreaterThan(Date.now());

    // Walk past the window rather than waiting two real minutes.
    const realNow = Date.now;
    Date.now = () => realNow() + 121_000;
    try {
      expect(api.isBillingRateLimited()).toBe(false);
      mockFetch.mockResolvedValueOnce(ok({ hasSubscription: true }));
      await expect(status()).resolves.toEqual({ hasSubscription: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('does not arm the block on an ordinary error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 500, headers: { get: () => null },
      json: () => Promise.resolve({ error: 'boom' }),
    });
    await expect(status()).rejects.toThrow(/boom/);
    expect(api.isBillingRateLimited()).toBe(false);
  });
});
