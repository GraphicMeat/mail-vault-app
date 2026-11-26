// @vitest-environment jsdom
/**
 * Asking for too many codes for one address (3 an hour) is that address's limit, not the
 * billing server's: it must not stop this computer from checking its subscription.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { signinStart, isBillingRateLimited, BillingRateLimitError } = await import('../billingApi');

afterEach(() => vi.unstubAllGlobals());

describe('signinStart rate limit', () => {
  it('reports when to try again without locking every billing call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429, headers: { 'Retry-After': '600', 'Content-Type': 'application/json' },
    })));
    const err = await signinStart('payer@mock.test', 'en').catch(e => e);
    expect(err).toBeInstanceOf(BillingRateLimitError);
    expect(err.retryAfterMs).toBe(600_000);
    expect(isBillingRateLimited()).toBe(false);
  });
});
