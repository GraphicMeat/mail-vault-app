import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock window.__TAURI__ to avoid shell import
vi.stubGlobal('__TAURI__', undefined);

const { createCheckoutSession, fetchSubscriptionStatus, openInBrowser } = await import('../../src/services/billingApi');

describe('billingApi — billingFetch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns parsed JSON on successful response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ url: 'https://checkout.stripe.com/test' }),
    });
    const result = await createCheckoutSession('test@example.com', 'monthly');
    expect(result.url).toBe('https://checkout.stripe.com/test');
  });

  it('propagates structured server error messages', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'billing_unavailable', message: 'Billing service is not configured.' }),
    });
    await expect(createCheckoutSession('test@example.com', 'monthly'))
      .rejects.toThrow('Billing service is not configured.');
  });

  it('handles non-JSON 5xx responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    });
    await expect(createCheckoutSession('test@example.com', 'monthly'))
      .rejects.toThrow('Billing service error (502)');
  });

  it('handles network/timeout failures', async () => {
    const timeoutErr = new Error('timeout');
    timeoutErr.name = 'TimeoutError';
    mockFetch.mockRejectedValueOnce(timeoutErr);
    await expect(createCheckoutSession('test@example.com', 'monthly'))
      .rejects.toThrow('Billing service timed out');
  });

  it('handles generic network failure', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(fetchSubscriptionStatus({ email: 'test@example.com' }))
      .rejects.toThrow('Could not reach billing service');
  });
});

// openInBrowser tests require jsdom (window global) — covered by component/E2E tests
