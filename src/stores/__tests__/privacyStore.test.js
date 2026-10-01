import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../settingsStore', async (orig) => {
  const real = await orig();
  return { ...real, hasPremiumAccess: vi.fn(() => true) };
});
import { hasPremiumAccess } from '../settingsStore';
import { usePrivacyStore, isPrivacyMasking } from '../privacyStore';

beforeEach(() => usePrivacyStore.setState({ enabled: false, peek: false, captureMask: false }));

describe('privacyStore', () => {
  it('refuses to turn on without Premium', () => {
    hasPremiumAccess.mockReturnValueOnce(false);
    expect(usePrivacyStore.getState().setEnabled(true)).toBe('premium');
    expect(usePrivacyStore.getState().enabled).toBe(false);
  });
  it('always allows turning off, even without Premium', () => {
    usePrivacyStore.setState({ enabled: true });
    hasPremiumAccess.mockReturnValue(false);
    expect(usePrivacyStore.getState().setEnabled(false)).toBe('ok');
    expect(usePrivacyStore.getState().enabled).toBe(false);
    hasPremiumAccess.mockReturnValue(true);
  });
  it('never turns itself off when Premium lapses', () => {
    usePrivacyStore.setState({ enabled: true });
    hasPremiumAccess.mockReturnValue(false);
    expect(usePrivacyStore.getState().enabled).toBe(true);
    hasPremiumAccess.mockReturnValue(true);
  });
  it('masks when enabled or capture-masked, but not while peeking', () => {
    expect(isPrivacyMasking({ enabled: true, peek: false, captureMask: false })).toBe(true);
    expect(isPrivacyMasking({ enabled: false, peek: false, captureMask: true })).toBe(true);
    expect(isPrivacyMasking({ enabled: true, peek: true, captureMask: false })).toBe(false);
  });
  it('persists only enabled', () => {
    const { partialize } = usePrivacyStore.persist.getOptions();
    expect(partialize({ enabled: true, peek: true, captureMask: true })).toEqual({ enabled: true });
  });
});
