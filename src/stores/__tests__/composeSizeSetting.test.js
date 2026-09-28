import { describe, expect, it, vi } from 'vitest';

vi.mock('../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useSettingsStore } = await import('../settingsStore');

describe('the remembered compose size', () => {
  it('is unset by default, so a fresh install opens at each surface\'s own default', () => {
    expect(useSettingsStore.getState().composeSize).toBeNull();
  });

  it('stores the last size a compose surface was resized to', () => {
    useSettingsStore.getState().setComposeSize({ width: 720, height: 560 });
    expect(useSettingsStore.getState().composeSize).toEqual({ width: 720, height: 560 });
  });

  it('floors a size below 200x200 to the minimum every compose surface enforces', () => {
    useSettingsStore.getState().setComposeSize({ width: 50, height: 90 });
    expect(useSettingsStore.getState().composeSize).toEqual({ width: 200, height: 200 });
  });

  it('clears back to null for a missing or malformed size', () => {
    useSettingsStore.getState().setComposeSize({ width: 720, height: 560 });
    useSettingsStore.getState().setComposeSize(null);
    expect(useSettingsStore.getState().composeSize).toBeNull();
  });
});
