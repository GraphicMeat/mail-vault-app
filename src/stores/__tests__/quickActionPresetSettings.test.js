import { describe, expect, it, vi } from 'vitest';

vi.mock('../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useSettingsStore } = await import('../settingsStore');
const { QUICK_ACTION_PRESETS, activeQuickActionPreset } = await import('../../utils/quickActionPresets');
const { quickActionScopeKey } = await import('../../utils/quickActions');

describe('applyQuickActionPreset (settings store)', () => {
  const surfaces = id => QUICK_ACTION_PRESETS.find(item => item.id === id).surfaces;

  it('starts on the MailVault set', () => {
    expect(activeQuickActionPreset(useSettingsStore.getState().quickActions)).toBe('mailvault');
  });

  it('writes the chosen set for All views or for one view', () => {
    const scope = { kind: 'mailbox', accountId: 'a', mailbox: 'INBOX' };
    useSettingsStore.getState().applyQuickActionPreset('gmail', null);
    expect(useSettingsStore.getState().quickActions.defaults).toEqual(surfaces('gmail'));

    useSettingsStore.getState().applyQuickActionPreset('outlook', scope);
    const { quickActions } = useSettingsStore.getState();
    expect(quickActions.overrides[quickActionScopeKey(scope)]).toEqual(surfaces('outlook'));
    expect(quickActions.defaults).toEqual(surfaces('gmail'));
    expect(activeQuickActionPreset(quickActions, scope)).toBe('outlook');
  });
});
