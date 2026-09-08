import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../safeStorage', () => {
  const saved = new Map();
  return {
    safeStorage: {
      getItem: async key => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
      removeItem: key => saved.delete(key),
    },
  };
});

const { safeStorage } = await import('../safeStorage');
const { useSettingsStore } = await import('../settingsStore');

beforeEach(async () => {
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

describe('appearance onboarding invitation', () => {
  it('keeps a completed legacy install eligible after asynchronous hydration', async () => {
    safeStorage.setItem('mailvault-settings', JSON.stringify({
      version: 5,
      state: { onboardingComplete: true, sidebarLayout: 'split', language: 'de' },
    }));
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState()).toMatchObject({
      onboardingComplete: true,
      appearanceOnboardingPromptSeen: false,
      sidebarLayout: 'split',
      language: 'de',
    });
  });

  it('excludes users who finish the current onboarding', () => {
    useSettingsStore.getState().setOnboardingComplete(true);
    expect(useSettingsStore.getState().appearanceOnboardingPromptSeen).toBe(true);
  });

  it('persists seeing the invitation across restarts', async () => {
    useSettingsStore.getState().markAppearanceOnboardingPromptSeen();
    const saved = await safeStorage.getItem('mailvault-settings');
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    safeStorage.setItem('mailvault-settings', saved);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().appearanceOnboardingPromptSeen).toBe(true);
  });

  it('preserves preferences when restarting onboarding', () => {
    useSettingsStore.setState({
      onboardingComplete: true,
      appearanceOnboardingPromptSeen: true,
      sidebarLayout: 'switcher',
      layoutMode: 'two-column',
      viewStyle: 'chat',
      language: 'de',
    });
    useSettingsStore.getState().setOnboardingComplete(false);
    expect(useSettingsStore.getState()).toMatchObject({
      onboardingComplete: false,
      appearanceOnboardingPromptSeen: true,
      sidebarLayout: 'switcher',
      layoutMode: 'two-column',
      viewStyle: 'chat',
      language: 'de',
    });
  });
});
