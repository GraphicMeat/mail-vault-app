// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../billingApi', () => ({
  createCheckoutSession: vi.fn(),
  openInBrowser: vi.fn(),
}));

const { createCheckoutSession, openInBrowser } = await import('../billingApi');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { startCheckout } = await import('../checkout');

beforeEach(async () => {
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  createCheckoutSession.mockReset();
  openInBrowser.mockReset();
  openInBrowser.mockResolvedValue(true);
});

describe('startCheckout', () => {
  it('asks for a session on the trimmed lower-case address and opens it in the browser', async () => {
    createCheckoutSession.mockResolvedValue({ url: 'https://checkout.example/s1' });
    const result = await startCheckout({ email: '  First@Example.com ', planId: 'yearly' });
    expect(createCheckoutSession).toHaveBeenCalledWith('first@example.com', { planId: 'yearly' });
    expect(openInBrowser).toHaveBeenCalledWith('https://checkout.example/s1');
    expect(result).toEqual({ ok: true });
  });

  it('remembers the address as the billing email before it asks', async () => {
    createCheckoutSession.mockImplementation(async () => {
      expect(useSettingsStore.getState().billingEmail).toBe('first@example.com');
      return { url: 'https://checkout.example/s1' };
    });
    await startCheckout({ email: 'first@example.com', planId: 'monthly' });
    expect(useSettingsStore.getState().billingEmail).toBe('first@example.com');
  });

  it('keeps the profile it had and adds the new customer id and address', async () => {
    useSettingsStore.setState({ billingProfile: { status: 'canceled', hasSubscription: true } });
    createCheckoutSession.mockResolvedValue({ url: 'https://checkout.example/s1', customerId: 'cus_1' });
    await startCheckout({ email: 'first@example.com', planId: 'yearly' });
    expect(useSettingsStore.getState().billingProfile).toMatchObject({
      status: 'canceled', hasSubscription: true, customerId: 'cus_1', customerEmail: 'first@example.com',
    });
  });

  it('notes when the checkout was opened, so a left checkout can be followed up', async () => {
    createCheckoutSession.mockResolvedValue({ url: 'https://checkout.example/s1' });
    const before = Date.now();
    await startCheckout({ email: 'first@example.com', planId: 'yearly' });
    expect(useSettingsStore.getState().lifecycleCheckoutAt).toBeGreaterThanOrEqual(before);
  });

  it('notes nothing when no checkout page was opened', async () => {
    createCheckoutSession.mockRejectedValue(new Error('billing_unavailable'));
    await startCheckout({ email: 'first@example.com', planId: 'yearly' });
    expect(useSettingsStore.getState().lifecycleCheckoutAt).toBeNull();

    createCheckoutSession.mockResolvedValue({ url: 'https://checkout.example/s1' });
    openInBrowser.mockRejectedValue(new Error('cannot open'));
    await startCheckout({ email: 'first@example.com', planId: 'yearly' });
    expect(useSettingsStore.getState().lifecycleCheckoutAt).toBeNull();
  });

  it('with no address sends nothing', async () => {
    const result = await startCheckout({ email: '   ', planId: 'yearly' });
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(openInBrowser).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('reports a refused session and opens nothing', async () => {
    createCheckoutSession.mockRejectedValue(new Error('billing_unavailable'));
    const result = await startCheckout({ email: 'first@example.com', planId: 'yearly' });
    expect(result).toEqual({ ok: false, error: 'billing_unavailable' });
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it('reports a browser that would not open, after the session was made', async () => {
    createCheckoutSession.mockResolvedValue({ url: 'https://checkout.example/s1', customerId: 'cus_1' });
    openInBrowser.mockRejectedValue(new Error('cannot open'));
    const result = await startCheckout({ email: 'first@example.com', planId: 'yearly' });
    expect(result).toEqual({ ok: false, error: 'cannot open' });
    expect(useSettingsStore.getState().billingProfile?.customerId).toBe('cus_1');
  });
});
