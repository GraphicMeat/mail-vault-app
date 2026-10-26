// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../settingsStore';

beforeEach(async () => {
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

describe('lifecycle message settings', () => {
  it('start switched on, with no checkout noted', () => {
    const s = useSettingsStore.getState();
    expect(s.lifecycleMessages).toBe(true);
    expect(s.lifecycleCheckoutAt).toBeNull();
  });

  it('can be switched off and on again', () => {
    useSettingsStore.getState().setLifecycleMessages(false);
    expect(useSettingsStore.getState().lifecycleMessages).toBe(false);
    useSettingsStore.getState().setLifecycleMessages(true);
    expect(useSettingsStore.getState().lifecycleMessages).toBe(true);
  });

  it('notes a checkout with the time it was opened', () => {
    useSettingsStore.getState().noteCheckoutOpened(1234);
    expect(useSettingsStore.getState().lifecycleCheckoutAt).toBe(1234);
  });
});
