// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const { hasPremiumAccess, isTauriDevPremiumOverrideEnabled } = await import('../../src/stores/settingsStore');

/** Set up globals to simulate a Tauri dev environment. */
function setupTauriDev(overrideValue) {
  window.__TAURI__ = {};
  window.__MAILVAULT_FORCE_PREMIUM__ = overrideValue;
  // import.meta.env.DEV is true in vitest, so we only need location
  Object.defineProperty(window, 'location', {
    value: { origin: 'http://localhost:5173' },
    writable: true,
    configurable: true,
  });
}

function cleanupGlobals() {
  delete window.__TAURI__;
  delete window.__MAILVAULT_FORCE_PREMIUM__;
}

describe('isTauriDevPremiumOverrideEnabled', () => {
  afterEach(cleanupGlobals);

  it('returns true when Tauri + DEV + localhost:5173 + boolean override', () => {
    setupTauriDev(true);
    expect(isTauriDevPremiumOverrideEnabled()).toBe(true);
  });

  it('returns true when override is false (boolean)', () => {
    setupTauriDev(false);
    expect(isTauriDevPremiumOverrideEnabled()).toBe(true);
  });

  it('returns false when __TAURI__ is absent (plain browser dev)', () => {
    window.__MAILVAULT_FORCE_PREMIUM__ = true;
    Object.defineProperty(window, 'location', {
      value: { origin: 'http://localhost:5173' },
      writable: true, configurable: true,
    });
    expect(isTauriDevPremiumOverrideEnabled()).toBe(false);
  });

  it('returns false when origin is not the dev server (packaged/debug build)', () => {
    window.__TAURI__ = {};
    window.__MAILVAULT_FORCE_PREMIUM__ = true;
    Object.defineProperty(window, 'location', {
      value: { origin: 'tauri://localhost' },
      writable: true, configurable: true,
    });
    expect(isTauriDevPremiumOverrideEnabled()).toBe(false);
  });

  it('returns false when override is a non-boolean value', () => {
    setupTauriDev('yes');
    expect(isTauriDevPremiumOverrideEnabled()).toBe(false);
  });
});

describe('hasPremiumAccess — dev override gate', () => {
  afterEach(cleanupGlobals);

  it('override true grants premium in tauri dev', () => {
    setupTauriDev(true);
    expect(hasPremiumAccess(null)).toBe(true);
  });

  it('override false denies premium in tauri dev', () => {
    setupTauriDev(false);
    expect(hasPremiumAccess({ hasSubscription: true, status: 'active', premiumAccess: true })).toBe(false);
  });

  it('override is ignored in plain browser dev (no __TAURI__)', () => {
    window.__MAILVAULT_FORCE_PREMIUM__ = true;
    Object.defineProperty(window, 'location', {
      value: { origin: 'http://localhost:5173' },
      writable: true, configurable: true,
    });
    // Falls through to billing logic — null profile → false
    expect(hasPremiumAccess(null)).toBe(false);
  });

  it('override is ignored in packaged build (wrong origin)', () => {
    window.__TAURI__ = {};
    window.__MAILVAULT_FORCE_PREMIUM__ = true;
    Object.defineProperty(window, 'location', {
      value: { origin: 'tauri://localhost' },
      writable: true, configurable: true,
    });
    expect(hasPremiumAccess(null)).toBe(false);
  });

  it('override is ignored in tauri build --debug (wrong origin)', () => {
    window.__TAURI__ = {};
    window.__MAILVAULT_FORCE_PREMIUM__ = true;
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://tauri.localhost' },
      writable: true, configurable: true,
    });
    expect(hasPremiumAccess(null)).toBe(false);
  });
});

describe('hasPremiumAccess — billing logic', () => {
  afterEach(cleanupGlobals);

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
    expect(hasPremiumAccess({ hasSubscription: true, status: 'active', premiumAccess: false })).toBe(false);
    expect(hasPremiumAccess({ hasSubscription: true, status: 'past_due', premiumAccess: true })).toBe(true);
  });

  it('falls back to client-side logic when premiumAccess is not a boolean', () => {
    expect(hasPremiumAccess({ hasSubscription: true, status: 'active' })).toBe(true);
    expect(hasPremiumAccess({ hasSubscription: true, status: 'canceled', currentPeriodEnd: new Date(Date.now() + 86400000).toISOString() })).toBe(true);
    expect(hasPremiumAccess({ hasSubscription: true, status: 'incomplete' })).toBe(false);
  });
});
