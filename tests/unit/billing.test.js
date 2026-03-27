import { describe, it, expect, vi } from 'vitest';

// Mock safeStorage (required by settingsStore's persist middleware)
vi.mock('../../src/stores/safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
  };
});

const { hasPremiumAccess } = await import('../../src/stores/settingsStore');

describe('hasPremiumAccess', () => {
  it('returns false for null/undefined profile', () => {
    expect(hasPremiumAccess(null)).toBe(false);
    expect(hasPremiumAccess(undefined)).toBe(false);
  });

  it('returns false when hasSubscription is false', () => {
    expect(hasPremiumAccess({ hasSubscription: false, status: null })).toBe(false);
  });

  it('returns true for active subscription', () => {
    expect(hasPremiumAccess({ hasSubscription: true, status: 'active', premiumAccess: true })).toBe(true);
  });

  it('returns true for trialing subscription', () => {
    expect(hasPremiumAccess({ hasSubscription: true, status: 'trialing', premiumAccess: true })).toBe(true);
  });

  it('returns true for past_due subscription', () => {
    expect(hasPremiumAccess({ hasSubscription: true, status: 'past_due', premiumAccess: true })).toBe(true);
  });

  it('returns true for canceled subscription before period end', () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    expect(hasPremiumAccess({ hasSubscription: true, status: 'canceled', currentPeriodEnd: futureDate, premiumAccess: true })).toBe(true);
  });

  it('returns false for canceled subscription after period end', () => {
    const pastDate = new Date(Date.now() - 24 * 3600_000).toISOString();
    expect(hasPremiumAccess({ hasSubscription: true, status: 'canceled', currentPeriodEnd: pastDate, premiumAccess: false })).toBe(false);
  });

  it('returns false for incomplete subscription', () => {
    expect(hasPremiumAccess({ hasSubscription: true, status: 'incomplete', premiumAccess: false })).toBe(false);
  });

  it('returns false for unpaid subscription', () => {
    expect(hasPremiumAccess({ hasSubscription: true, status: 'unpaid', premiumAccess: false })).toBe(false);
  });

  it('trusts server-computed premiumAccess when present', () => {
    // Server says no access even though status is active (edge case)
    expect(hasPremiumAccess({ hasSubscription: true, status: 'active', premiumAccess: false })).toBe(false);
    // Server says yes even though status is unusual
    expect(hasPremiumAccess({ hasSubscription: true, status: 'past_due', premiumAccess: true })).toBe(true);
  });

  it('falls back to client-side logic when premiumAccess is not a boolean', () => {
    expect(hasPremiumAccess({ hasSubscription: true, status: 'active' })).toBe(true);
    expect(hasPremiumAccess({ hasSubscription: true, status: 'canceled', currentPeriodEnd: new Date(Date.now() + 86400000).toISOString() })).toBe(true);
    expect(hasPremiumAccess({ hasSubscription: true, status: 'incomplete' })).toBe(false);
  });
});
