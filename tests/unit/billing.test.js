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

const { hasPremiumAccess, isTauriDevPremiumOverrideEnabled, isShareGrantActive, useSettingsStore } = await import('../../src/stores/settingsStore');

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

describe('hasPremiumAccess — the device seat (clientAccessGranted)', () => {
  afterEach(cleanupGlobals);

  // The server answers this when client registration is on: it means "the
  // subscription is premium AND this device holds one of its seats". It is read
  // BEFORE premiumAccess, so a live subscription on an unregistered machine is
  // correctly not premium *here* — that is the whole point of the seat limit.
  it('denies premium on a device that holds no seat, even on a live subscription', () => {
    expect(hasPremiumAccess({
      hasSubscription: true, status: 'active', premiumAccess: true, clientAccessGranted: false,
    })).toBe(false);
  });

  it('grants premium on a registered device', () => {
    expect(hasPremiumAccess({
      hasSubscription: true, status: 'active', premiumAccess: false, clientAccessGranted: true,
    })).toBe(true);
  });

  it('outranks both the server verdict and the status fallback', () => {
    // premiumAccess says yes, status says yes, the seat says no. Seat wins.
    expect(hasPremiumAccess({
      hasSubscription: true, status: 'trialing', premiumAccess: true, clientAccessGranted: false,
    })).toBe(false);
  });

  it('is ignored when it is absent rather than false', () => {
    // Servers that do not do client registration omit the field entirely; that
    // must not read as a denied seat.
    expect(hasPremiumAccess({ hasSubscription: true, status: 'active', premiumAccess: true })).toBe(true);
  });

  it('still requires a subscription — no seat is granted on a free profile', () => {
    expect(hasPremiumAccess({ hasSubscription: false, clientAccessGranted: true })).toBe(false);
  });
});

describe('share-to-unlock grant', () => {
  const setGrant = (expiresAt) => useSettingsStore.setState({ shareGrant: expiresAt ? { expiresAt } : null });

  afterEach(() => {
    cleanupGlobals();
    setGrant(null);
  });

  it('is inactive with no grant stored', () => {
    setGrant(null);
    expect(isShareGrantActive()).toBe(false);
  });

  it('is active inside its window and dead after it', () => {
    setGrant(Date.now() + 60_000);
    expect(isShareGrantActive()).toBe(true);
    setGrant(Date.now() - 1);
    expect(isShareGrantActive()).toBe(false);
  });

  // This is how someone reaches every premium surface with no account, no
  // sign-in and no subscription — see project_backup_runs_without_premium.
  it('grants full premium with no billing profile at all', () => {
    setGrant(Date.now() + 60_000);
    expect(hasPremiumAccess(null)).toBe(true);
    expect(hasPremiumAccess({ hasSubscription: false })).toBe(true);
  });

  it('stops granting the moment it expires', () => {
    setGrant(Date.now() - 1);
    expect(hasPremiumAccess(null)).toBe(false);
    expect(hasPremiumAccess({ hasSubscription: false })).toBe(false);
  });

  // Order matters and is worth pinning: the grant is checked BEFORE the profile,
  // so it also covers a device whose seat the server refused. That is a grant
  // acting as its own premium source rather than as a subscription seat — the
  // behaviour today, recorded here so a change to it shows up as a failing test
  // rather than as a quiet bypass of the seat limit.
  it('outranks a refused device seat, because it is read before the profile', () => {
    setGrant(Date.now() + 60_000);
    expect(hasPremiumAccess({
      hasSubscription: true, status: 'active', clientAccessGranted: false,
    })).toBe(true);
  });
});
